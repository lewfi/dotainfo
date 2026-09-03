"""Incrementally ingest professional OpenDota matches into hot NDJSON shards."""

from __future__ import annotations

import argparse
import http.client
import json
import os
import tempfile
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pyarrow as pa
import pyarrow.parquet as pq

from ingest.compact import compact_eligible_months
from ingest.schema import DRAFT_SCHEMA, MATCH_SCHEMA, PLAYER_SCHEMA
from ingest.slim import shard_month, slim_match_response


API_BASE_URL = "https://api.opendota.com/api"
REST_INTERVAL_SECONDS = 1.1
HTTP_TIMEOUT_SECONDS = 60
BOOTSTRAP_DAYS = 7
FAILURE_LIMIT = 5
RATE_LIMIT_RETRIES = 5
TRANSIENT_RETRIES = 3

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
STATE_PATH = DATA_DIR / "state.json"
FAILED_PATH = DATA_DIR / "failed.ndjson"
FAILED_PERMANENT_PATH = DATA_DIR / "failed_permanent.ndjson"
RUN_SUMMARY_PATH = DATA_DIR / ".run-summary.json"

JsonObject = dict[str, Any]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def json_line(value: JsonObject) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


@dataclass
class RunSummary:
    run_utc: str
    matches_fetched: int = 0
    matches_failed: int = 0
    retries_attempted: int = 0
    retries_succeeded: int = 0
    retries_permanent: int = 0
    transient_retries: int = 0
    api_calls: int = 0
    unknown_patch_indices: list[int] = field(default_factory=list)
    shards_written: list[str] = field(default_factory=list)
    late_rows_written: int = 0
    cursor_before: int = 0
    cursor_after: int = 0
    duration_seconds: float = 0.0


@dataclass
class Discovery:
    cursor_before: int
    new_ids: list[int]
    bootstrap: bool
    pages_read: int
    bootstrap_cutoff_utc: str | None = None


@dataclass
class PlannedMatch:
    match_id: int
    month: str
    late: bool
    match_row: JsonObject
    player_count: int
    draft_count: int


class RateLimitError(RuntimeError):
    """Raised after a request remains rate-limited through its in-run retries."""


def retry_after_seconds(error: HTTPError, retry_number: int) -> float:
    """Return the server-directed or exponential delay for a 429 retry."""
    header = error.headers.get("Retry-After") if error.headers is not None else None
    if header:
        try:
            return max(0.0, float(header))
        except ValueError:
            try:
                retry_at = parsedate_to_datetime(header)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=timezone.utc)
                return max(0.0, (retry_at - utc_now()).total_seconds())
            except (TypeError, ValueError, OverflowError):
                pass
    return REST_INTERVAL_SECONDS * (2 ** (retry_number - 1))


class ApiClient:
    def __init__(self) -> None:
        self.calls = 0
        self.transient_retries = 0
        self._last_call_finished: float | None = None

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        query_params = dict(params or {})
        api_key = os.environ.get("OPENDOTA_API_KEY")
        if api_key:
            query_params["api_key"] = api_key
        query = f"?{urlencode(query_params)}" if query_params else ""
        request = Request(
            f"{API_BASE_URL}{path}{query}",
            headers={"User-Agent": "dotainfo-v0-ingest"},
        )
        rate_limit_retries = 0
        transient_retries = 0
        while True:
            if self._last_call_finished is not None:
                elapsed = time.monotonic() - self._last_call_finished
                if elapsed < REST_INTERVAL_SECONDS:
                    time.sleep(REST_INTERVAL_SECONDS - elapsed)

            self.calls += 1
            try:
                with urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                    return json.load(response)
            except HTTPError as error:
                if error.code == 429:
                    if rate_limit_retries >= RATE_LIMIT_RETRIES:
                        raise RateLimitError(
                            f"HTTP 429 persisted after {RATE_LIMIT_RETRIES} in-run retries"
                        ) from error
                    rate_limit_retries += 1
                    time.sleep(retry_after_seconds(error, rate_limit_retries))
                    continue
                if error.code < 500:
                    raise
                if transient_retries >= TRANSIENT_RETRIES:
                    raise
                transient_retries += 1
                self.transient_retries += 1
                time.sleep(REST_INTERVAL_SECONDS * (2 ** (transient_retries - 1)))
            except (URLError, TimeoutError, http.client.RemoteDisconnected):
                if transient_retries >= TRANSIENT_RETRIES:
                    raise
                transient_retries += 1
                self.transient_retries += 1
                time.sleep(REST_INTERVAL_SECONDS * (2 ** (transient_retries - 1)))
            finally:
                self._last_call_finished = time.monotonic()


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="call the API and print the plan without writing any files",
    )
    parser.add_argument(
        "--limit",
        type=positive_int,
        help="maximum combined new and retry matches attempted this run",
    )
    return parser.parse_args(argv)


def read_state(path: Path = STATE_PATH) -> JsonObject | None:
    if not path.exists():
        return None
    state = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(state, dict) or not isinstance(state.get("last_match_id"), int):
        raise ValueError(f"invalid state file: {path}")
    return state


def read_failure_queue(path: Path) -> dict[int, JsonObject]:
    records: dict[int, JsonObject] = {}
    if not path.exists():
        return records
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        record = json.loads(line)
        match_id = record.get("match_id")
        if not isinstance(match_id, int):
            raise ValueError(f"invalid match_id in {path}:{line_number}")
        records[match_id] = record
    return records


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", text=True
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def atomic_write_if_changed(path: Path, content: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return False
    atomic_write_text(path, content)
    return True


def serialize_failure_queue(records: dict[int, JsonObject]) -> str:
    if not records:
        return ""
    return "".join(f"{json_line(records[match_id])}\n" for match_id in sorted(records))


def append_rows_atomically(path: Path, rows: list[JsonObject]) -> None:
    if not rows:
        return
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    if existing and not existing.endswith("\n"):
        existing += "\n"
    appended = "".join(f"{json_line(row)}\n" for row in rows)
    atomic_write_text(path, existing + appended)


def read_ndjson_match_ids(path: Path) -> set[int]:
    match_ids: set[int] = set()
    if not path.exists():
        return match_ids
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        match_id = value.get("match_id")
        if not isinstance(match_id, int):
            raise ValueError(f"invalid match_id in {path}:{line_number}")
        match_ids.add(match_id)
    return match_ids


def existing_match_ids(data_dir: Path = DATA_DIR) -> set[int]:
    matches_dir = data_dir / "matches"
    match_ids: set[int] = set()
    if not matches_dir.exists():
        return match_ids
    for path in matches_dir.glob("*.ndjson"):
        match_ids.update(read_ndjson_match_ids(path))
    for path in matches_dir.glob("*.parquet"):
        table = pq.read_table(path, columns=["match_id"])
        match_ids.update(value.as_py() for value in table.column("match_id"))
    return match_ids


def pro_matches_page(client: ApiClient, less_than: int | None = None) -> list[JsonObject]:
    params = {"less_than_match_id": less_than} if less_than is not None else None
    response = client.get_json("/proMatches", params)
    if not isinstance(response, list) or not all(isinstance(item, dict) for item in response):
        raise TypeError("/proMatches response must be an array of objects")
    return response


def page_match_ids(page: list[JsonObject]) -> list[int]:
    match_ids = [item.get("match_id") for item in page]
    if not all(isinstance(match_id, int) for match_id in match_ids):
        raise TypeError("every /proMatches row must contain an integer match_id")
    return match_ids


def discover_matches(
    client: ApiClient, state: JsonObject | None, now: datetime
) -> Discovery:
    pages: list[list[JsonObject]] = []
    less_than: int | None = None

    if state is None:
        cutoff = now - timedelta(days=BOOTSTRAP_DAYS)
        while True:
            page = pro_matches_page(client, less_than)
            if not page:
                raise RuntimeError("bootstrap reached an empty /proMatches page")
            pages.append(page)
            match_ids = page_match_ids(page)
            start_times = [item.get("start_time") for item in page]
            if not all(isinstance(start_time, int) for start_time in start_times):
                raise TypeError("every /proMatches row must contain an integer start_time")
            if any(
                datetime.fromtimestamp(start_time, tz=timezone.utc) < cutoff
                for start_time in start_times
            ):
                cursor_before = min(match_ids)
                break
            next_less_than = min(match_ids)
            if less_than == next_less_than:
                raise RuntimeError("/proMatches pagination did not advance")
            less_than = next_less_than

        discovered = {
            match_id
            for page in pages
            for match_id in page_match_ids(page)
            if match_id > cursor_before
        }
        return Discovery(
            cursor_before=cursor_before,
            new_ids=sorted(discovered),
            bootstrap=True,
            pages_read=len(pages),
            bootstrap_cutoff_utc=isoformat_utc(cutoff),
        )

    cursor_before = state["last_match_id"]
    while True:
        page = pro_matches_page(client, less_than)
        if not page:
            break
        pages.append(page)
        match_ids = page_match_ids(page)
        if any(match_id <= cursor_before for match_id in match_ids):
            break
        if len(page) < 100:
            break
        next_less_than = min(match_ids)
        if less_than == next_less_than:
            raise RuntimeError("/proMatches pagination did not advance")
        less_than = next_less_than

    discovered = {
        match_id
        for page in pages
        for match_id in page_match_ids(page)
        if match_id > cursor_before
    }
    return Discovery(
        cursor_before=cursor_before,
        new_ids=sorted(discovered),
        bootstrap=False,
        pages_read=len(pages),
    )


def build_patch_lookup(response: Any) -> dict[int, str]:
    if not isinstance(response, list):
        raise TypeError("/constants/patch response must be an array")
    lookup: dict[int, str] = {}
    for patch in response:
        if not isinstance(patch, dict):
            continue
        patch_id = patch.get("id")
        name = patch.get("name")
        if isinstance(patch_id, int) and isinstance(name, str):
            lookup[patch_id] = name
    return lookup


def validate_rows(
    match_row: JsonObject,
    player_rows: list[JsonObject],
    draft_rows: list[JsonObject],
) -> None:
    pa.Table.from_pylist([match_row], schema=MATCH_SCHEMA)
    pa.Table.from_pylist(player_rows, schema=PLAYER_SCHEMA)
    pa.Table.from_pylist(draft_rows, schema=DRAFT_SCHEMA)


def dataset_paths(data_dir: Path, month: str, late: bool) -> dict[str, Path]:
    filename = "late.ndjson" if late else f"{month}.ndjson"
    return {
        "matches": data_dir / "matches" / filename,
        "players": data_dir / "players" / filename,
        "draft": data_dir / "draft" / filename,
    }


def failure_record(match_id: int, previous: JsonObject | None, error: Exception) -> JsonObject:
    failed_utc = isoformat_utc(utc_now())
    message = f"{type(error).__name__}: {error}".replace("\r", " ").replace("\n", " ")
    return {
        "match_id": match_id,
        "first_failed_utc": previous.get("first_failed_utc", failed_utc)
        if previous
        else failed_utc,
        "attempts": int(previous.get("attempts", 0)) + 1 if previous else 1,
        "last_error": message,
    }


def print_discovery_plan(
    discovery: Discovery,
    retry_ids: list[int],
    selected_ids: list[int],
    dry_run: bool,
) -> None:
    print(f"mode={'dry-run' if dry_run else 'write'}")
    print(f"bootstrap={str(discovery.bootstrap).lower()}")
    if discovery.bootstrap_cutoff_utc:
        print(f"bootstrap_cutoff_utc={discovery.bootstrap_cutoff_utc}")
    print(f"pro_matches_pages={discovery.pages_read}")
    print(f"cursor_before={discovery.cursor_before}")
    print(f"new_candidates={len(discovery.new_ids)}")
    print(f"retry_candidates={len(retry_ids)}")
    print(f"selected_match_ids={selected_ids}")


def run(args: argparse.Namespace) -> RunSummary:
    started = time.monotonic()
    run_started_utc = utc_now()
    summary = RunSummary(run_utc=isoformat_utc(run_started_utc))
    client = ApiClient()

    state = read_state(STATE_PATH)
    failures = read_failure_queue(FAILED_PATH)
    permanent_failures = read_failure_queue(FAILED_PERMANENT_PATH)

    patch_lookup = build_patch_lookup(client.get_json("/constants/patch"))
    discovery = discover_matches(client, state, run_started_utc)
    summary.cursor_before = discovery.cursor_before
    summary.cursor_after = discovery.cursor_before

    retry_ids = sorted(failures)
    combined_ids = sorted(set(discovery.new_ids) | set(retry_ids))
    selected_ids = combined_ids[: args.limit] if args.limit is not None else combined_ids
    detailed_output = len(selected_ids) <= 20
    print_discovery_plan(discovery, retry_ids, selected_ids, args.dry_run)

    stored_match_ids = existing_match_ids(DATA_DIR)
    pending_rows: dict[Path, list[JsonObject]] = defaultdict(list)
    planned_matches: list[PlannedMatch] = []
    attempted_new_ids: list[int] = []
    hot_months: set[str] = set()
    unknown_patch_indices: set[int] = set()

    for match_id in selected_ids:
        is_retry = match_id in failures
        is_new = match_id in discovery.new_ids
        if is_retry:
            summary.retries_attempted += 1
        if is_new:
            attempted_new_ids.append(match_id)

        if match_id in stored_match_ids:
            print(f"SKIP match_id={match_id} already persisted")
            if is_retry:
                failures.pop(match_id, None)
                summary.retries_succeeded += 1
            continue

        try:
            response = client.get_json(f"/matches/{match_id}")
            if not isinstance(response, dict):
                raise TypeError("match response must be an object")
            match_row, player_rows, draft_rows = slim_match_response(response, patch_lookup)
            validate_rows(match_row, player_rows, draft_rows)

            patch_index = response.get("patch")
            if isinstance(patch_index, int) and match_row["patch"] is None:
                unknown_patch_indices.add(patch_index)

            month = shard_month(match_row)
            late = (DATA_DIR / "matches" / f"{month}.parquet").exists()
            paths = dataset_paths(DATA_DIR, month, late)
            pending_rows[paths["matches"]].append(match_row)
            pending_rows[paths["players"]].extend(player_rows)
            pending_rows[paths["draft"]].extend(draft_rows)
            stored_match_ids.add(match_id)
            summary.matches_fetched += 1

            if late:
                summary.late_rows_written += 1 + len(player_rows) + len(draft_rows)
            else:
                hot_months.add(month)
            if is_retry:
                failures.pop(match_id, None)
                summary.retries_succeeded += 1

            planned = PlannedMatch(
                match_id=match_id,
                month=month,
                late=late,
                match_row=match_row,
                player_count=len(player_rows),
                draft_count=len(draft_rows),
            )
            planned_matches.append(planned)
            if detailed_output:
                print(
                    f"{'PLAN' if args.dry_run else 'READY'} match_id={match_id} "
                    f"month={month} late={str(late).lower()} "
                    f"players={len(player_rows)} draft={len(draft_rows)}"
                )
            elif summary.matches_fetched % 25 == 0:
                print(
                    f"PROGRESS matches_fetched={summary.matches_fetched} "
                    f"latest_match_id={match_id}"
                )
        except Exception as error:
            summary.matches_failed += 1
            updated = failure_record(match_id, failures.get(match_id), error)
            if updated["attempts"] >= FAILURE_LIMIT:
                permanent_failures[match_id] = updated
                failures.pop(match_id, None)
                summary.retries_permanent += 1
            else:
                failures[match_id] = updated
            print(f"FAILED match_id={match_id} error={updated['last_error']}")

    if attempted_new_ids:
        summary.cursor_after = max(discovery.cursor_before, max(attempted_new_ids))
    summary.unknown_patch_indices = sorted(unknown_patch_indices)
    summary.shards_written = sorted(hot_months)
    summary.api_calls = client.calls
    summary.transient_retries = getattr(client, "transient_retries", 0)

    if not args.dry_run:
        for path in sorted(pending_rows, key=str):
            append_rows_atomically(path, pending_rows[path])
        atomic_write_if_changed(FAILED_PATH, serialize_failure_queue(failures))
        atomic_write_if_changed(
            FAILED_PERMANENT_PATH, serialize_failure_queue(permanent_failures)
        )
        if attempted_new_ids:
            state_content = json.dumps(
                {
                    "last_match_id": summary.cursor_after,
                    "last_run_utc": summary.run_utc,
                },
                indent=2,
            ) + "\n"
            atomic_write_if_changed(STATE_PATH, state_content)
        compact_eligible_months(DATA_DIR, run_started_utc.date())
    else:
        compact_eligible_months(DATA_DIR, run_started_utc.date(), dry_run=True)

    summary.duration_seconds = round(time.monotonic() - started, 3)
    summary_content = json.dumps(asdict(summary), indent=2) + "\n"
    if args.dry_run:
        print("DRY RUN: zero filesystem writes performed")
        print("planned_summary=")
        print(summary_content, end="")
    else:
        atomic_write_text(RUN_SUMMARY_PATH, summary_content)
        print("run_summary=")
        print(summary_content, end="")
        if planned_matches:
            if detailed_output:
                print("written_matches=")
                for planned in planned_matches:
                    print(json_line(planned.match_row))
            else:
                print(
                    "written_match_ids="
                    + json.dumps([planned.match_id for planned in planned_matches])
                )
    return summary


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        run(args)
    except KeyboardInterrupt:
        print("interrupted", flush=True)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
