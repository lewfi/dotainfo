"""Close eligible monthly NDJSON shards as verified Parquet files."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from ingest.schema import DRAFT_SCHEMA, MATCH_SCHEMA, PLAYER_SCHEMA


REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"

TABLE_SCHEMAS: dict[str, pa.Schema] = {
    "matches": MATCH_SCHEMA,
    "players": PLAYER_SCHEMA,
    "draft": DRAFT_SCHEMA,
}


class CompactionError(RuntimeError):
    """Base error for a monthly compaction that cannot safely proceed."""


class AlreadyCompactedError(CompactionError):
    """Raised when a caller attempts to rewrite a closed month."""


class CorruptShardStateError(CompactionError):
    """Raised when the three tables are not in one consistent lifecycle state."""


@dataclass(frozen=True)
class CompactionResult:
    month: str
    row_counts: dict[str, int]
    dry_run: bool


def parse_reference_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an ISO date in YYYY-MM-DD form") from error


def parse_month(month: str) -> tuple[int, int]:
    try:
        parsed = date.fromisoformat(f"{month}-01")
    except ValueError as error:
        raise ValueError(f"invalid shard month {month!r}; expected YYYY-MM") from error
    if parsed.strftime("%Y-%m") != month:
        raise ValueError(f"invalid shard month {month!r}; expected YYYY-MM")
    return parsed.year, parsed.month


def eligible_on(month: str) -> date:
    """Return the first date on which a month may be closed."""
    year, month_number = parse_month(month)
    if month_number == 12:
        following_month = date(year + 1, 1, 1)
    else:
        following_month = date(year, month_number + 1, 1)
    return following_month + timedelta(days=7)


def is_eligible(month: str, reference_date: date) -> bool:
    return reference_date >= eligible_on(month)


def shard_paths(data_dir: Path, month: str, extension: str) -> dict[str, Path]:
    return {
        table_name: data_dir / table_name / f"{month}.{extension}"
        for table_name in TABLE_SCHEMAS
    }


def discover_hot_months(data_dir: Path) -> list[str]:
    months: set[str] = set()
    for table_name in TABLE_SCHEMAS:
        directory = data_dir / table_name
        if not directory.exists():
            continue
        for path in directory.glob("????-??.ndjson"):
            parse_month(path.stem)
            months.add(path.stem)
    return sorted(months)


def read_ndjson(path: Path, schema: pa.Schema) -> pa.Table:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise CompactionError(f"{path}:{line_number} must contain a JSON object")
        rows.append(value)
    try:
        return pa.Table.from_pylist(rows, schema=schema)
    except (pa.ArrowException, TypeError, ValueError) as error:
        raise CompactionError(f"{path} does not conform to its schema: {error}") from error


def write_staged_parquet(table: pa.Table, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        pq.write_table(table, temporary_path)
        return temporary_path
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def verify_staged_parquet(
    path: Path, expected_schema: pa.Schema, expected_rows: int
) -> None:
    table = pq.read_table(path)
    if table.num_rows != expected_rows:
        raise CompactionError(
            f"verification failed for {path}: expected {expected_rows} rows, "
            f"read back {table.num_rows}"
        )
    if not table.schema.equals(expected_schema):
        raise CompactionError(
            f"verification failed for {path}: schema changed during Parquet round-trip"
        )


def publish_parquet(staged_path: Path, destination: Path) -> None:
    if destination.exists():
        raise AlreadyCompactedError(f"refusing to overwrite closed shard {destination}")
    os.replace(staged_path, destination)


def validate_month_state(data_dir: Path, month: str) -> tuple[dict[str, Path], dict[str, Path]]:
    sources = shard_paths(data_dir, month, "ndjson")
    destinations = shard_paths(data_dir, month, "parquet")
    source_exists = {name: path.exists() for name, path in sources.items()}
    destination_exists = {name: path.exists() for name, path in destinations.items()}

    if any(destination_exists.values()):
        if all(destination_exists.values()) and not any(source_exists.values()):
            raise AlreadyCompactedError(
                f"refusing to rewrite already-compacted month {month}"
            )
        raise CorruptShardStateError(
            f"month {month} mixes hot and closed shards: "
            f"ndjson={source_exists}, parquet={destination_exists}"
        )
    if not all(source_exists.values()):
        raise CorruptShardStateError(
            f"month {month} must have all three NDJSON shards: {source_exists}"
        )
    return sources, destinations


def compact_month(
    data_dir: Path,
    month: str,
    reference_date: date,
    *,
    dry_run: bool = False,
) -> CompactionResult | None:
    """Compact one eligible month, or return ``None`` while it is still hot."""
    if not is_eligible(month, reference_date):
        return None

    sources, destinations = validate_month_state(data_dir, month)
    tables = {
        name: read_ndjson(sources[name], schema)
        for name, schema in TABLE_SCHEMAS.items()
    }
    row_counts = {name: table.num_rows for name, table in tables.items()}
    action = "WOULD COMPACT" if dry_run else "COMPACT"
    print(
        f"{action} month={month} "
        + " ".join(f"{name}_rows={row_counts[name]}" for name in TABLE_SCHEMAS)
    )
    if dry_run:
        return CompactionResult(month=month, row_counts=row_counts, dry_run=True)

    staged: dict[str, Path] = {}
    published: list[Path] = []
    retired_sources: dict[Path, Path] = {}
    try:
        for name, schema in TABLE_SCHEMAS.items():
            staged[name] = write_staged_parquet(tables[name], destinations[name])
            verify_staged_parquet(staged[name], schema, row_counts[name])

        for name in TABLE_SCHEMAS:
            publish_parquet(staged[name], destinations[name])
            published.append(destinations[name])

        for name in TABLE_SCHEMAS:
            source = sources[name]
            descriptor, backup_name = tempfile.mkstemp(
                dir=source.parent,
                prefix=f".{source.name}.",
                suffix=".retired",
            )
            os.close(descriptor)
            backup = Path(backup_name)
            backup.unlink()
            os.replace(source, backup)
            retired_sources[source] = backup
    except BaseException:
        for source, backup in reversed(tuple(retired_sources.items())):
            if backup.exists():
                os.replace(backup, source)
        for path in reversed(published):
            path.unlink(missing_ok=True)
        raise
    finally:
        for path in staged.values():
            path.unlink(missing_ok=True)

    for backup in retired_sources.values():
        backup.unlink()

    print(
        f"COMPACTED month={month} "
        + " ".join(f"{name}_rows={row_counts[name]}" for name in TABLE_SCHEMAS)
    )
    return CompactionResult(month=month, row_counts=row_counts, dry_run=False)


def compact_eligible_months(
    data_dir: Path,
    reference_date: date,
    *,
    dry_run: bool = False,
) -> list[CompactionResult]:
    results: list[CompactionResult] = []
    for month in discover_hot_months(data_dir):
        result = compact_month(
            data_dir,
            month,
            reference_date,
            dry_run=dry_run,
        )
        if result is not None:
            results.append(result)
    if not results:
        print(f"NO ELIGIBLE MONTHS reference_date={reference_date.isoformat()}")
    return results


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    parser.add_argument(
        "--reference-date",
        type=parse_reference_date,
        default=datetime.now(timezone.utc).date(),
        help="eligibility date in YYYY-MM-DD form (default: current UTC date)",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=DATA_DIR,
        help=argparse.SUPPRESS,
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        compact_eligible_months(
            args.data_dir,
            args.reference_date,
            dry_run=args.dry_run,
        )
    except CompactionError as error:
        print(f"COMPACTION FAILED: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
