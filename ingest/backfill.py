"""One-time historical OpenDota SQL Explorer backfill.

Live execution is step 9 and requires explicit approval. ``--dry-run`` is an
offline contract check backed only by scripted responses.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from textwrap import dedent
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pyarrow as pa
import pyarrow.parquet as pq

from ingest.compact import (
    AlreadyCompactedError,
    CorruptShardStateError,
    is_eligible,
    parse_month,
    read_ndjson,
    shard_paths,
    verify_staged_parquet,
    write_staged_parquet,
)
from ingest.fetch import (
    append_rows_atomically,
    atomic_write_text,
    dataset_paths,
    read_ndjson_match_ids,
)
from ingest.schema import DRAFT_SCHEMA, MATCH_SCHEMA, PLAYER_SCHEMA
from ingest.slim import shard_month, slim_sql_draft, slim_sql_match, slim_sql_player


REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
CHECKPOINT_PATH = Path(__file__).resolve().with_name(".backfill-checkpoint.json")

START_MONTH = "2021-01"
INITIAL_PAGE_SIZE = 2_000
MIN_PAGE_SIZE = 1
EXPLORER_INTERVAL_SECONDS = 5.0
EXPLORER_TIMEOUT_SECONDS = 120
EXPLORER_URL = "https://api.opendota.com/api/explorer"
EXPLORER_RATE_LIMIT_RETRIES = 5
RATE_LIMIT_BACKOFF_SECONDS = 1.1
CHECKPOINT_VERSION = 1
PLAYER_ROWS_PER_MATCH = 10
MAX_PLAYER_TAIL_HALVINGS_PER_MONTH = 3

MATCH_QUERY_COLUMNS = tuple(
    name
    for name in MATCH_SCHEMA.names
    if name not in {"radiant_gold_adv", "radiant_xp_adv"}
)

JsonObject = dict[str, Any]


class ExplorerTimeout(TimeoutError):
    """A SQL Explorer query timed out and may be retried with a smaller window."""


class ExplorerRateLimitError(RuntimeError):
    """Raised after /explorer remains rate-limited through five retries."""


class ZeroPlayerRowsError(RuntimeError):
    """Raised when a match has no player rows and the month must abort."""


class Explorer(Protocol):
    def query(self, sql: str) -> list[Mapping[str, Any]]: ...


@dataclass
class MonthRows:
    matches: list[JsonObject] = field(default_factory=list)
    players: list[JsonObject] = field(default_factory=list)
    draft: list[JsonObject] = field(default_factory=list)
    pages: int = 0
    explorer_queries: int = 0
    null_team_id_matches: int = 0
    player_row_count_anomalies: dict[int, int] = field(default_factory=dict)
    player_tail_halvings: int = 0
    player_tail_halving_cap_reached: bool = False
    zero_draft_match_ids: list[int] = field(default_factory=list)


@dataclass(frozen=True)
class WriteResult:
    month: str
    matches_written: int
    players_written: int
    draft_written: int
    duplicate_matches_skipped: int
    wrote_files: bool
    write_target: str


@dataclass
class BackfillSummary:
    upper_bound: str
    completed_months: list[str] = field(default_factory=list)
    resumed_months: list[str] = field(default_factory=list)
    matches_written: int = 0
    duplicate_matches_skipped: int = 0
    explorer_queries: int = 0
    null_team_id_matches: int = 0
    player_row_count_anomalies: dict[int, int] = field(default_factory=dict)
    zero_draft_matches: int = 0
    late_matches_written: int = 0


class ExplorerClient:
    """Rate-limited client for OpenDota's production SQL Explorer endpoint."""

    def __init__(
        self,
        *,
        opener: Callable[..., Any] = urlopen,
        sleeper: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._opener = opener
        self._sleep = sleeper
        self._clock = clock
        self._last_call_finished: float | None = None

    def _wait_for_slot(self) -> None:
        if self._last_call_finished is not None:
            elapsed = self._clock() - self._last_call_finished
            remaining = EXPLORER_INTERVAL_SECONDS - elapsed
            if remaining > 0:
                self._sleep(remaining)

    @staticmethod
    def _retry_after_seconds(error: HTTPError, retry_number: int) -> float:
        header = error.headers.get("Retry-After") if error.headers is not None else None
        if header:
            try:
                return max(0.0, float(header))
            except ValueError:
                try:
                    retry_at = parsedate_to_datetime(header)
                    if retry_at.tzinfo is None:
                        retry_at = retry_at.replace(tzinfo=timezone.utc)
                    return max(
                        0.0,
                        (retry_at - datetime.now(timezone.utc)).total_seconds(),
                    )
                except (TypeError, ValueError, OverflowError):
                    pass
        return RATE_LIMIT_BACKOFF_SECONDS * (2 ** (retry_number - 1))

    def query(self, sql: str) -> list[Mapping[str, Any]]:
        request = Request(
            f"{EXPLORER_URL}?{urlencode({'sql': sql})}",
            headers={"User-Agent": "dotainfo-backfill/1"},
        )
        for retry_number in range(EXPLORER_RATE_LIMIT_RETRIES + 1):
            self._wait_for_slot()
            rate_limit_delay: float | None = None
            try:
                with self._opener(
                    request, timeout=EXPLORER_TIMEOUT_SECONDS
                ) as response:
                    payload = json.load(response)
            except HTTPError as error:
                if error.code in {408, 504}:
                    raise ExplorerTimeout(f"HTTP {error.code}") from error
                if error.code != 429:
                    raise
                if retry_number >= EXPLORER_RATE_LIMIT_RETRIES:
                    error.close()
                    raise ExplorerRateLimitError(
                        "HTTP 429 persisted after "
                        f"{EXPLORER_RATE_LIMIT_RETRIES} in-run retries"
                    ) from error
                rate_limit_delay = self._retry_after_seconds(
                    error, retry_number + 1
                )
                error.close()
            except (TimeoutError, socket.timeout) as error:
                raise ExplorerTimeout(str(error) or "request timed out") from error
            except URLError as error:
                if isinstance(error.reason, (TimeoutError, socket.timeout)):
                    raise ExplorerTimeout(str(error.reason)) from error
                raise
            finally:
                # The next call is spaced from completion, including response reading.
                self._last_call_finished = self._clock()
            if rate_limit_delay is not None:
                self._sleep(rate_limit_delay)
                continue
            break
        else:
            raise AssertionError("unreachable")

        if not isinstance(payload, Mapping):
            raise TypeError("/explorer response must be an object")
        error_message = payload.get("error")
        if isinstance(error_message, str):
            if "timeout" in error_message.lower() or "timed out" in error_message.lower():
                raise ExplorerTimeout(error_message)
            raise RuntimeError(f"/explorer error: {error_message}")
        rows = payload.get("rows")
        if not isinstance(rows, list) or not all(isinstance(row, Mapping) for row in rows):
            raise TypeError("/explorer response rows must be an array of objects")
        return rows


def month_start(month: str) -> date:
    year, month_number = parse_month(month)
    return date(year, month_number, 1)


def next_month(value: date) -> date:
    if value.month == 12:
        return date(value.year + 1, 1, 1)
    return date(value.year, value.month + 1, 1)


def previous_month(value: date) -> date:
    if value.month == 1:
        return date(value.year - 1, 12, 1)
    return date(value.year, value.month - 1, 1)


def iter_months(first: str, last: str) -> list[str]:
    current = month_start(first)
    end = month_start(last)
    months: list[str] = []
    while current <= end:
        months.append(current.strftime("%Y-%m"))
        current = next_month(current)
    return months


def last_fully_closed_month(run_date: date) -> str:
    """Return the newest month eligible under compact.py's exact rule."""
    candidate = previous_month(run_date.replace(day=1))
    while not is_eligible(candidate.strftime("%Y-%m"), run_date):
        candidate = previous_month(candidate)
    return candidate.strftime("%Y-%m")


def month_epoch_bounds(month: str) -> tuple[int, int]:
    start_date = month_start(month)
    end_date = next_month(start_date)
    start = int(datetime.combine(start_date, datetime.min.time(), timezone.utc).timestamp())
    end = int(datetime.combine(end_date, datetime.min.time(), timezone.utc).timestamp())
    return start, end


def build_match_query(month: str, cursor: int, limit: int) -> str:
    start, end = month_epoch_bounds(month)
    return dedent(
        f"""
        /* backfill:matches */
        SELECT m.match_id, m.start_time, m.duration, m.leagueid,
               l.name AS league_name, l.tier AS league_tier,
               m.series_id, m.series_type,
               m.radiant_team_id, m.dire_team_id,
               rt.name AS radiant_team_name, dt.name AS dire_team_name,
               m.radiant_captain, m.dire_captain,
               m.radiant_win, m.radiant_score, m.dire_score,
               m.first_blood_time, m.game_mode, m.lobby_type,
               mp.patch, m.version IS NOT NULL AS is_parsed,
               m.tower_status_radiant, m.tower_status_dire,
               m.barracks_status_radiant, m.barracks_status_dire
        FROM matches m
        LEFT JOIN leagues l ON l.leagueid = m.leagueid
        LEFT JOIN match_patch mp ON mp.match_id = m.match_id
        LEFT JOIN teams rt ON rt.team_id = m.radiant_team_id
        LEFT JOIN teams dt ON dt.team_id = m.dire_team_id
        WHERE m.leagueid > 0
          AND m.start_time >= {start} AND m.start_time < {end}
          AND m.match_id > {cursor}
        ORDER BY m.match_id
        LIMIT {limit}
        """
    ).strip()


def build_player_query(month: str, cursor: int, window_end: int) -> str:
    start, end = month_epoch_bounds(month)
    return dedent(
        f"""
        /* backfill:players */
        SELECT pm.match_id, pm.account_id, pm.player_slot, pm.hero_id,
               pm.hero_variant, pm.kills, pm.deaths, pm.assists,
               pm.last_hits, pm.denies, pm.gold_per_min, pm.xp_per_min,
               pm.net_worth, pm.level, pm.hero_damage, pm.tower_damage,
               pm.hero_healing, pm.stuns, pm.teamfight_participation,
               pm.obs_placed, pm.sen_placed, pm.camps_stacked,
               pm.rune_pickups, pm.lane, pm.lane_role, pm.is_roaming,
               pm.leaver_status, pm.item_0, pm.item_1, pm.item_2,
               pm.item_3, pm.item_4, pm.item_5, pm.backpack_0,
               pm.backpack_1, pm.backpack_2, pm.backpack_3,
               pm.item_neutral
        FROM player_matches pm
        JOIN matches m ON m.match_id = pm.match_id
        WHERE m.leagueid > 0
          AND m.start_time >= {start} AND m.start_time < {end}
          AND pm.match_id > {cursor} AND pm.match_id <= {window_end}
        ORDER BY pm.match_id, pm.player_slot
        """
    ).strip()


def build_draft_query(month: str, cursor: int, window_end: int) -> str:
    start, end = month_epoch_bounds(month)
    return dedent(
        f"""
        /* backfill:draft */
        SELECT pb.match_id, pb.is_pick, pb.hero_id, pb.team, pb.ord
        FROM picks_bans pb
        JOIN matches m ON m.match_id = pb.match_id
        WHERE m.leagueid > 0
          AND m.start_time >= {start} AND m.start_time < {end}
          AND pb.match_id > {cursor} AND pb.match_id <= {window_end}
        ORDER BY pb.match_id, pb.ord
        """
    ).strip()


def _required_match_id(row: Mapping[str, Any], source: str) -> int:
    match_id = row.get("match_id")
    if not isinstance(match_id, int) or isinstance(match_id, bool):
        raise ValueError(f"{source} row has invalid match_id: {match_id!r}")
    return match_id


def _validate_match_columns(row: Mapping[str, Any]) -> None:
    missing = sorted(set(MATCH_QUERY_COLUMNS) - set(row))
    if missing:
        raise ValueError(
            "SQL match query result is missing expected columns: "
            + ", ".join(missing)
        )


def fetch_month_rows(
    client: Explorer,
    month: str,
    *,
    initial_page_size: int = INITIAL_PAGE_SIZE,
) -> MonthRows:
    """Fetch one month with keyset pagination and coordinated child windows."""
    if initial_page_size < MIN_PAGE_SIZE:
        raise ValueError("initial_page_size must be positive")
    result = MonthRows()
    cursor = 0
    page_size = initial_page_size
    match_columns_validated = False

    def query(sql: str) -> list[Mapping[str, Any]]:
        result.explorer_queries += 1
        return client.query(sql)

    def halve_page(
        reason: str, *, observed_match_count: int | None = None
    ) -> bool:
        nonlocal page_size
        effective_size = (
            min(page_size, observed_match_count)
            if observed_match_count is not None
            else page_size
        )
        if effective_size <= MIN_PAGE_SIZE:
            return False
        reduced = max(MIN_PAGE_SIZE, effective_size // 2)
        print(
            f"{reason} month={month} cursor={cursor} "
            f"window={page_size}->{reduced}"
        )
        page_size = reduced
        return True

    while True:
        try:
            source_matches = query(build_match_query(month, cursor, page_size))
            if not source_matches:
                break
            if not match_columns_validated:
                _validate_match_columns(source_matches[0])
                match_columns_validated = True
            match_ids = [
                _required_match_id(row, "matches") for row in source_matches
            ]
            if match_ids != sorted(match_ids) or len(match_ids) != len(set(match_ids)):
                raise ValueError("match page must be strictly ordered by match_id")
            if match_ids[0] <= cursor:
                raise ValueError("match keyset pagination did not advance")
            if len(match_ids) > page_size:
                raise ValueError("match page exceeded its requested LIMIT")

            window_end = match_ids[-1]
            source_players = query(build_player_query(month, cursor, window_end))
            source_draft = query(build_draft_query(month, cursor, window_end))
        except ExplorerTimeout:
            if not halve_page("TIMEOUT"):
                raise
            continue

        page_ids = set(match_ids)
        for source_name, child_rows in (
            ("players", source_players),
            ("draft", source_draft),
        ):
            unexpected = {
                _required_match_id(row, source_name) for row in child_rows
            } - page_ids
            if unexpected:
                raise ValueError(
                    f"{source_name} query returned rows outside match window: "
                    f"{sorted(unexpected)}"
                )

        player_counts = {match_id: 0 for match_id in match_ids}
        for row in source_players:
            player_counts[_required_match_id(row, "players")] += 1
        short_player_counts = {
            match_id: count
            for match_id, count in player_counts.items()
            if count < PLAYER_ROWS_PER_MATCH
        }
        tail_short_ids: list[int] = []
        for match_id in reversed(match_ids):
            if match_id not in short_player_counts:
                break
            tail_short_ids.append(match_id)
        tail_short_ids.reverse()
        tail_counts = {
            match_id: player_counts[match_id]
            for match_id in tail_short_ids
        }
        if (
            tail_short_ids
            and result.player_tail_halvings
            < MAX_PLAYER_TAIL_HALVINGS_PER_MONTH
            and halve_page(
                "SUSPECTED PLAYER TRUNCATION",
                observed_match_count=len(match_ids),
            )
        ):
            result.player_tail_halvings += 1
            result.player_tail_halving_cap_reached = (
                result.player_tail_halvings
                == MAX_PLAYER_TAIL_HALVINGS_PER_MONTH
            )
            print(
                f"TRUNCATED PLAYER TAIL month={month} "
                f"counts={tail_counts} "
                f"player_tail_halvings={result.player_tail_halvings}"
            )
            continue
        if (
            tail_short_ids
            and result.player_tail_halvings
            >= MAX_PLAYER_TAIL_HALVINGS_PER_MONTH
        ):
            result.player_tail_halving_cap_reached = True
            print(
                f"PLAYER TAIL HALVING CAP REACHED month={month} "
                f"cap={MAX_PLAYER_TAIL_HALVINGS_PER_MONTH} "
                f"counts={tail_counts}"
            )

        zero_player_ids = sorted(
            match_id for match_id, count in player_counts.items() if count == 0
        )
        if zero_player_ids:
            raise ZeroPlayerRowsError(
                f"player query returned zero rows for month={month} "
                f"match_ids={zero_player_ids}; aborting month"
            )

        player_anomalies = {
            match_id: count
            for match_id, count in player_counts.items()
            if count != PLAYER_ROWS_PER_MATCH
        }

        draft_ids = {
            _required_match_id(row, "draft") for row in source_draft
        }
        zero_draft_ids = sorted(page_ids - draft_ids)

        mapped_matches = [slim_sql_match(row) for row in source_matches]
        result.matches.extend(mapped_matches)
        result.players.extend(slim_sql_player(row) for row in source_players)
        result.draft.extend(slim_sql_draft(row) for row in source_draft)
        result.null_team_id_matches += sum(
            row["radiant_team_id"] is None or row["dire_team_id"] is None
            for row in mapped_matches
        )
        result.player_row_count_anomalies.update(player_anomalies)
        result.zero_draft_match_ids.extend(zero_draft_ids)
        result.pages += 1
        cursor = window_end

    pa.Table.from_pylist(result.matches, schema=MATCH_SCHEMA)
    pa.Table.from_pylist(result.players, schema=PLAYER_SCHEMA)
    pa.Table.from_pylist(result.draft, schema=DRAFT_SCHEMA)
    return result


def _late_month_match_ids(path: Path, month: str) -> set[int]:
    if not path.exists():
        return set()
    match_ids: set[int] = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, Mapping):
            raise ValueError(f"expected object in {path}:{line_number}")
        if shard_month(row) == month:
            match_ids.add(_required_match_id(row, f"{path}:{line_number}"))
    return match_ids


def existing_month_match_ids(data_dir: Path, month: str) -> set[int]:
    matches_dir = data_dir / "matches"
    ids: set[int] = set()
    ndjson_path = matches_dir / f"{month}.ndjson"
    parquet_path = matches_dir / f"{month}.parquet"
    if ndjson_path.exists():
        ids.update(read_ndjson_match_ids(ndjson_path))
    if parquet_path.exists():
        table = pq.read_table(parquet_path, columns=["match_id"])
        ids.update(value.as_py() for value in table.column("match_id"))
    ids.update(_late_month_match_ids(matches_dir / "late.ndjson", month))
    return ids


def _filter_existing_late_children(
    path: Path,
    rows: Sequence[JsonObject],
    source: str,
) -> list[JsonObject]:
    """Skip a complete child set already published before an interrupted match append."""
    existing_ids = read_ndjson_match_ids(path)
    return [
        row
        for row in rows
        if _required_match_id(row, source) not in existing_ids
    ]


def _sort_nullable(value: Any) -> tuple[bool, Any]:
    return value is None, value


def _combined_table(
    existing: pa.Table,
    new_rows: Sequence[Mapping[str, Any]],
    schema: pa.Schema,
    key: Callable[[Mapping[str, Any]], Any],
) -> pa.Table:
    rows = existing.to_pylist() + [dict(row) for row in new_rows]
    rows.sort(key=key)
    return pa.Table.from_pylist(rows, schema=schema)


def _publish_tables(
    sources: Mapping[str, Path],
    destinations: Mapping[str, Path],
    tables: Mapping[str, pa.Table],
) -> None:
    staged: dict[str, Path] = {}
    published: list[Path] = []
    retired: dict[Path, Path] = {}
    try:
        for name, table in tables.items():
            staged[name] = write_staged_parquet(table, destinations[name])
            verify_staged_parquet(
                staged[name], table.schema, table.num_rows
            )
        for name in tables:
            if destinations[name].exists():
                raise AlreadyCompactedError(
                    f"refusing to overwrite closed shard {destinations[name]}"
                )
            os.replace(staged[name], destinations[name])
            published.append(destinations[name])
        for source in sources.values():
            if not source.exists():
                continue
            descriptor, backup_name = tempfile.mkstemp(
                dir=source.parent,
                prefix=f".{source.name}.",
                suffix=".backfill-retired",
            )
            os.close(descriptor)
            backup = Path(backup_name)
            backup.unlink()
            os.replace(source, backup)
            retired[source] = backup
    except BaseException:
        for source, backup in reversed(tuple(retired.items())):
            if backup.exists():
                os.replace(backup, source)
        for path in reversed(published):
            path.unlink(missing_ok=True)
        raise
    finally:
        for path in staged.values():
            path.unlink(missing_ok=True)
    for backup in retired.values():
        backup.unlink()


def write_month(data_dir: Path, month: str, fetched: MonthRows) -> WriteResult:
    """Publish one month after applying REST-first deduplication at write time."""
    existing_ids = existing_month_match_ids(data_dir, month)
    seen_ids = set(existing_ids)
    new_matches: list[JsonObject] = []
    duplicate_count = 0
    for row in fetched.matches:
        match_id = _required_match_id(row, "backfill matches")
        if match_id in seen_ids:
            duplicate_count += 1
            continue
        seen_ids.add(match_id)
        new_matches.append(row)
    new_ids = {_required_match_id(row, "backfill matches") for row in new_matches}
    new_players = [
        row
        for row in fetched.players
        if _required_match_id(row, "backfill players") in new_ids
    ]
    new_draft = [
        row
        for row in fetched.draft
        if _required_match_id(row, "backfill draft") in new_ids
    ]

    sources = shard_paths(data_dir, month, "ndjson")
    destinations = shard_paths(data_dir, month, "parquet")
    source_exists = {name: path.exists() for name, path in sources.items()}
    destination_exists = {name: path.exists() for name, path in destinations.items()}

    if any(destination_exists.values()):
        if not all(destination_exists.values()) or any(source_exists.values()):
            raise CorruptShardStateError(
                f"month {month} mixes hot and closed shards: "
                f"ndjson={source_exists}, parquet={destination_exists}"
            )
        if not new_matches:
            return WriteResult(month, 0, 0, 0, duplicate_count, False, "none")
        late_paths = dataset_paths(data_dir, month, late=True)
        late_draft = _filter_existing_late_children(
            late_paths["draft"], new_draft, "backfill late draft"
        )
        late_players = _filter_existing_late_children(
            late_paths["players"], new_players, "backfill late players"
        )
        late_rows = {
            "matches": new_matches,
            "players": late_players,
            "draft": late_draft,
        }
        # The match row is the deduplication key and is deliberately published last.
        # Child-local match-ID filtering makes either interruption point resumable.
        for name in ("draft", "players", "matches"):
            append_rows_atomically(late_paths[name], late_rows[name])
        return WriteResult(
            month=month,
            matches_written=len(new_matches),
            players_written=len(late_players),
            draft_written=len(late_draft),
            duplicate_matches_skipped=duplicate_count,
            wrote_files=True,
            write_target="late",
        )

    if any(source_exists.values()) and not all(source_exists.values()):
        raise CorruptShardStateError(
            f"month {month} must have all three NDJSON shards: {source_exists}"
        )
    if not new_matches and not any(source_exists.values()):
        return WriteResult(month, 0, 0, 0, duplicate_count, False, "none")

    existing_tables = {
        "matches": read_ndjson(sources["matches"], MATCH_SCHEMA)
        if source_exists["matches"]
        else pa.Table.from_pylist([], schema=MATCH_SCHEMA),
        "players": read_ndjson(sources["players"], PLAYER_SCHEMA)
        if source_exists["players"]
        else pa.Table.from_pylist([], schema=PLAYER_SCHEMA),
        "draft": read_ndjson(sources["draft"], DRAFT_SCHEMA)
        if source_exists["draft"]
        else pa.Table.from_pylist([], schema=DRAFT_SCHEMA),
    }
    tables = {
        "matches": _combined_table(
            existing_tables["matches"],
            new_matches,
            MATCH_SCHEMA,
            lambda row: _required_match_id(row, "matches"),
        ),
        "players": _combined_table(
            existing_tables["players"],
            new_players,
            PLAYER_SCHEMA,
            lambda row: (
                _required_match_id(row, "players"),
                _sort_nullable(row.get("player_slot")),
            ),
        ),
        "draft": _combined_table(
            existing_tables["draft"],
            new_draft,
            DRAFT_SCHEMA,
            lambda row: (
                _required_match_id(row, "draft"),
                _sort_nullable(row.get("ord")),
            ),
        ),
    }
    _publish_tables(sources, destinations, tables)
    return WriteResult(
        month=month,
        matches_written=len(new_matches),
        players_written=len(new_players),
        draft_written=len(new_draft),
        duplicate_matches_skipped=duplicate_count,
        wrote_files=True,
        write_target="parquet",
    )


def load_checkpoint(path: Path) -> JsonObject:
    if not path.exists():
        return {"version": CHECKPOINT_VERSION, "completed_months": []}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != CHECKPOINT_VERSION:
        raise ValueError(f"invalid checkpoint version in {path}")
    completed = value.get("completed_months")
    if not isinstance(completed, list) or not all(
        isinstance(month, str) for month in completed
    ):
        raise ValueError(f"invalid completed_months in {path}")
    for month in completed:
        parse_month(month)
    return value


def save_checkpoint(
    path: Path,
    completed_months: set[str],
    upper_bound: str,
) -> None:
    content = json.dumps(
        {
            "version": CHECKPOINT_VERSION,
            "completed_months": sorted(completed_months),
            "last_eligible_month": upper_bound,
            "updated_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        },
        indent=2,
    ) + "\n"
    atomic_write_text(path, content)


def run_backfill(
    client: Explorer,
    *,
    data_dir: Path = DATA_DIR,
    checkpoint_path: Path = CHECKPOINT_PATH,
    run_date: date | None = None,
    start_month: str = START_MONTH,
    initial_page_size: int = INITIAL_PAGE_SIZE,
    only_month: str | None = None,
    max_months: int | None = None,
) -> BackfillSummary:
    effective_date = run_date or datetime.now(timezone.utc).date()
    upper_bound = last_fully_closed_month(effective_date)
    summary = BackfillSummary(upper_bound=upper_bound)
    checkpoint = load_checkpoint(checkpoint_path)
    completed = set(checkpoint["completed_months"])

    print("mode=write")
    print(f"start_month={start_month}")
    print(f"last_fully_closed_month={upper_bound}")
    if only_month is not None:
        parse_month(only_month)
        if month_start(only_month) < month_start(start_month):
            raise ValueError(
                f"requested month {only_month} precedes start month {start_month}"
            )
        if month_start(only_month) > month_start(upper_bound):
            raise ValueError(
                f"requested month {only_month} is not fully closed; "
                f"upper bound is {upper_bound}"
            )
        candidate_months = [only_month]
        print(f"only_month={only_month}")
    else:
        candidate_months = iter_months(start_month, upper_bound)

    pending_months: list[str] = []
    for month in candidate_months:
        if month in completed:
            summary.resumed_months.append(month)
            print(f"SKIP completed month={month}")
            continue
        pending_months.append(month)
    if max_months is not None:
        pending_months = pending_months[:max_months]
        print(f"max_months={max_months}")

    for month in pending_months:
        fetched = fetch_month_rows(
            client, month, initial_page_size=initial_page_size
        )
        result = write_month(data_dir, month, fetched)
        completed.add(month)
        save_checkpoint(checkpoint_path, completed, upper_bound)
        summary.completed_months.append(month)
        summary.matches_written += result.matches_written
        summary.duplicate_matches_skipped += result.duplicate_matches_skipped
        summary.explorer_queries += fetched.explorer_queries
        summary.null_team_id_matches += fetched.null_team_id_matches
        summary.player_row_count_anomalies.update(
            fetched.player_row_count_anomalies
        )
        summary.zero_draft_matches += len(fetched.zero_draft_match_ids)
        if result.write_target == "late":
            summary.late_matches_written += result.matches_written
        if fetched.zero_draft_match_ids:
            print(
                f"ZERO DRAFT ROWS month={month} "
                f"match_ids={fetched.zero_draft_match_ids}"
            )
        if fetched.player_row_count_anomalies:
            print(
                f"PLAYER ROW COUNT ANOMALIES month={month} "
                f"counts={fetched.player_row_count_anomalies}"
            )
        print(
            f"COMPLETE month={month} pages={fetched.pages} "
            f"matches_written={result.matches_written} "
            f"duplicates_skipped={result.duplicate_matches_skipped} "
            f"null_team_id_matches={fetched.null_team_id_matches} "
            "player_row_count_anomalies="
            f"{len(fetched.player_row_count_anomalies)} "
            f"player_tail_halvings={fetched.player_tail_halvings} "
            "player_tail_halving_cap_reached="
            f"{str(fetched.player_tail_halving_cap_reached).lower()} "
            f"zero_draft_matches={len(fetched.zero_draft_match_ids)} "
            f"write_target={result.write_target} "
            f"files_written={str(result.wrote_files).lower()}"
        )
    return summary


class _ScriptedExplorer:
    def __init__(
        self, script: Sequence[tuple[str, Sequence[Mapping[str, Any]]]]
    ) -> None:
        self._script = list(script)
        self.queries: list[str] = []

    def query(self, sql: str) -> list[Mapping[str, Any]]:
        if not self._script:
            raise AssertionError("mock explorer received an unexpected query")
        expected_tag, rows = self._script.pop(0)
        if f"backfill:{expected_tag}" not in sql:
            raise AssertionError(
                f"expected {expected_tag} query, received: {sql.splitlines()[0]}"
            )
        self.queries.append(sql)
        return list(rows)

    def assert_exhausted(self) -> None:
        if self._script:
            raise AssertionError(f"unused mock responses: {len(self._script)}")


def _mock_match(match_id: int) -> JsonObject:
    row = {name: None for name in MATCH_QUERY_COLUMNS}
    row.update(
        {
            "match_id": match_id,
            "start_time": 1609459200 + match_id,
            "patch": "7.41",
            "is_parsed": True,
            "radiant_team_id": None,
            "radiant_team_name": "must be cleared",
            "dire_team_id": None,
            "dire_team_name": "must be cleared",
        }
    )
    return row


def _mock_players(match_id: int) -> list[JsonObject]:
    slots = list(range(5)) + list(range(128, 133))
    return [{"match_id": match_id, "player_slot": slot} for slot in slots]


def validate_offline_dry_run() -> MonthRows:
    script = [
        ("matches", [_mock_match(101), _mock_match(102)]),
        ("players", _mock_players(101) + _mock_players(102)),
        ("draft", [{"match_id": 101, "is_pick": True, "hero_id": 1, "team": 0, "ord": 0}]),
        ("matches", [_mock_match(103)]),
        ("players", _mock_players(103)[:2]),
        ("draft", [{"match_id": 103, "is_pick": False, "hero_id": 2, "team": 1, "ord": 1}]),
        ("matches", []),
    ]
    client = _ScriptedExplorer(script)
    rows = fetch_month_rows(client, "2021-01", initial_page_size=2)
    client.assert_exhausted()
    match_queries = [query for query in client.queries if "backfill:matches" in query]
    expected_cursors = ["m.match_id > 0", "m.match_id > 102", "m.match_id > 103"]
    if not all(expected in query for expected, query in zip(expected_cursors, match_queries)):
        raise AssertionError("mock keyset cursors did not advance as expected")
    if any(row["radiant_gold_adv"] is not None for row in rows.matches):
        raise AssertionError("backfilled gold advantage must be null")
    if any(row["radiant_xp_adv"] is not None for row in rows.matches):
        raise AssertionError("backfilled xp advantage must be null")

    tables = (
        pa.Table.from_pylist(rows.matches, schema=MATCH_SCHEMA),
        pa.Table.from_pylist(rows.players, schema=PLAYER_SCHEMA),
        pa.Table.from_pylist(rows.draft, schema=DRAFT_SCHEMA),
    )
    schemas_valid = all(
        table.schema.equals(schema)
        for table, schema in zip(
            tables, (MATCH_SCHEMA, PLAYER_SCHEMA, DRAFT_SCHEMA), strict=True
        )
    )
    patch_values = sorted({row["patch"] for row in rows.matches})
    patch_format = patch_values[0] if len(patch_values) == 1 else patch_values
    advantage_arrays_all_null = all(
        row["radiant_gold_adv"] is None and row["radiant_xp_adv"] is None
        for row in rows.matches
    )
    mock_player_counts = {
        row["match_id"]: 0 for row in rows.matches
    }
    for row in rows.players:
        mock_player_counts[row["match_id"]] += 1
    mock_complete_player_page_match_ids = sorted(
        match_id
        for match_id, count in mock_player_counts.items()
        if count == PLAYER_ROWS_PER_MATCH
    )

    print("mode=dry-run")
    print("source=mocked-explorer-responses")
    print("live_api_calls=0")
    print("filesystem_writes=0")
    print("mock_month=2021-01")
    print(f"mock_match_pages={rows.pages}")
    print(f"mock_explorer_queries={rows.explorer_queries}")
    print("mock_keyset_cursors=[0, 102, 103]")
    print(f"mock_matches={len(rows.matches)}")
    print(f"mock_players={len(rows.players)}")
    print(f"mock_draft={len(rows.draft)}")
    print(f"null_team_id_matches={rows.null_team_id_matches}")
    print(
        "mock_complete_player_page_match_ids="
        f"{mock_complete_player_page_match_ids}"
    )
    print(
        "mock_deliberate_player_anomaly="
        f"{rows.player_row_count_anomalies}"
    )
    print(f"player_tail_halvings={rows.player_tail_halvings}")
    print(
        "player_tail_halving_cap_reached="
        f"{str(rows.player_tail_halving_cap_reached).lower()}"
    )
    print(f"zero_draft_match_ids={rows.zero_draft_match_ids}")
    print(f"patch_format={patch_format}")
    print(
        "advantage_arrays="
        + ("all-null" if advantage_arrays_all_null else "unexpected-non-null")
    )
    print(f"schemas_valid={str(schemas_valid).lower()}")
    print("DRY RUN: zero live API calls and zero filesystem writes performed")
    return rows


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def month_argument(value: str) -> str:
    try:
        parse_month(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="validate offline with mocked responses; make no network calls or writes",
    )
    mode.add_argument(
        "--execute-live",
        action="store_true",
        help="explicitly authorize live /explorer queries and data writes",
    )
    parser.add_argument("--start-month", type=month_argument, default=START_MONTH)
    bounds = parser.add_mutually_exclusive_group()
    bounds.add_argument(
        "--month",
        type=month_argument,
        help="process exactly one fully closed month",
    )
    bounds.add_argument(
        "--max-months",
        type=positive_int,
        help="process at most this many incomplete months",
    )
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help=argparse.SUPPRESS)
    parser.add_argument(
        "--checkpoint", type=Path, default=CHECKPOINT_PATH, help=argparse.SUPPRESS
    )
    return parser


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.dry_run:
        validate_offline_dry_run()
        return 0
    run_backfill(
        ExplorerClient(),
        data_dir=args.data_dir,
        checkpoint_path=args.checkpoint,
        start_month=args.start_month,
        only_month=args.month,
        max_months=args.max_months,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
