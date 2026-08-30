"""Refresh OpenDota reference datasets into deterministic Parquet files."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

import pyarrow as pa
import pyarrow.parquet as pq

from ingest.fetch import ApiClient, RateLimitError
from ingest.schema import (
    HERO_SCHEMA,
    LEAGUE_SCHEMA,
    REFERENCE_PLAYER_SCHEMA,
    TEAM_SCHEMA,
)
from ingest.slim import slim_hero, slim_league, slim_reference_player, slim_team


TEAM_PAGE_SIZE = 1_000
MAX_TEAM_PAGES = 100
SUPPLEMENTAL_TEAM_LIMIT = 600

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"

JsonObject = dict[str, Any]
Slimmer = Callable[[Mapping[str, Any]], JsonObject]


@dataclass
class ReferenceSummary:
    pages_walked: int = 0
    team_rows_returned: int = 0
    team_duplicates_dropped: int = 0
    distinct_teams_walked: int = 0
    local_match_files_read: tuple[str, ...] = ()
    local_match_ids_seen: int = 0
    local_distinct_team_ids: int = 0
    local_ids_resolved_by_walk: int = 0
    local_ids_already_cached: int = 0
    supplemental_attempted: int = 0
    supplemental_succeeded: int = 0
    supplemental_failed: int = 0
    supplemental_deferred: int = 0
    teams_rows: int = 0
    leagues_rows: int = 0
    heroes_rows: int = 0
    players_rows: int = 0


@dataclass(frozen=True)
class LocalMatchInventory:
    files_read: tuple[Path, ...]
    match_ids_seen: int
    team_ids: frozenset[int]


def _objects(payload: Any, endpoint: str) -> list[Mapping[str, Any]]:
    if not isinstance(payload, list) or not all(
        isinstance(item, Mapping) for item in payload
    ):
        raise TypeError(f"{endpoint} must return a JSON array of objects")
    return payload


def _required_int(row: Mapping[str, Any], key: str, source: str) -> int:
    value = row.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{source} row has invalid {key}: {value!r}")
    return value


def walk_teams(
    client: ApiClient,
) -> tuple[dict[int, JsonObject], ReferenceSummary]:
    """Walk every `/teams` page and retain the first row for each team ID."""
    teams: dict[int, JsonObject] = {}
    summary = ReferenceSummary()
    for page in range(MAX_TEAM_PAGES):
        payload = _objects(client.get_json("/teams", {"page": page}), "/teams")
        summary.pages_walked += 1
        summary.team_rows_returned += len(payload)
        for source in payload:
            row = slim_team(source)
            team_id = _required_int(row, "team_id", f"/teams?page={page}")
            if team_id in teams:
                summary.team_duplicates_dropped += 1
            else:
                teams[team_id] = row

        if len(payload) < TEAM_PAGE_SIZE:
            break
    else:
        raise RuntimeError(
            f"/teams pagination exceeded the {MAX_TEAM_PAGES}-page ceiling "
            "without a short or empty page"
        )

    summary.distinct_teams_walked = len(teams)
    return teams, summary


def _read_ndjson_team_ids(path: Path) -> tuple[set[int], int]:
    team_ids: set[int] = set()
    matches_seen = 0
    with path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid JSON in {path}:{line_number}") from error
            if not isinstance(row, Mapping):
                raise ValueError(f"expected object in {path}:{line_number}")
            matches_seen += 1
            for key in ("radiant_team_id", "dire_team_id"):
                value = row.get(key)
                if isinstance(value, int) and not isinstance(value, bool):
                    team_ids.add(value)
    return team_ids, matches_seen


def read_local_match_inventory(data_dir: Path) -> LocalMatchInventory:
    """Read match and team-ID counts from every local match data shard."""
    matches_dir = data_dir / "matches"
    if not matches_dir.exists():
        return LocalMatchInventory((), 0, frozenset())

    files_read: list[Path] = []
    matches_seen = 0
    team_ids: set[int] = set()
    for path in sorted(matches_dir.glob("*.ndjson")):
        shard_team_ids, shard_matches_seen = _read_ndjson_team_ids(path)
        files_read.append(path)
        matches_seen += shard_matches_seen
        team_ids.update(shard_team_ids)

    for path in sorted(matches_dir.glob("*.parquet")):
        table = pq.read_table(
            path, columns=["radiant_team_id", "dire_team_id"]
        )
        files_read.append(path)
        matches_seen += table.num_rows
        for key in ("radiant_team_id", "dire_team_id"):
            for value in table.column(key).to_pylist():
                if isinstance(value, int) and not isinstance(value, bool):
                    team_ids.add(value)
    return LocalMatchInventory(
        tuple(files_read), matches_seen, frozenset(team_ids)
    )


def local_match_team_ids(data_dir: Path) -> set[int]:
    """Return non-null team IDs from every local match data shard."""
    return set(read_local_match_inventory(data_dir).team_ids)


def read_existing_teams(path: Path) -> dict[int, JsonObject]:
    """Read the previous teams Parquet, which is the supplemental cache."""
    if not path.exists():
        return {}
    table = pq.read_table(path)
    rows = pa.Table.from_pylist(table.to_pylist(), schema=TEAM_SCHEMA).to_pylist()
    teams: dict[int, JsonObject] = {}
    for row in rows:
        team_id = _required_int(row, "team_id", str(path))
        teams.setdefault(team_id, row)
    return teams


def _fetch_rows(client: ApiClient, path: str, slimmer: Slimmer) -> list[JsonObject]:
    return [slimmer(source) for source in _objects(client.get_json(path), path)]


def _sort_rows(rows: list[JsonObject], key: str) -> list[JsonObject]:
    return sorted(rows, key=lambda row: (row.get(key) is None, row.get(key)))


def _table(rows: list[JsonObject], schema: pa.Schema) -> pa.Table:
    return pa.Table.from_pylist(rows, schema=schema)


def _atomic_write_parquet(path: Path, table: pa.Table) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        pq.write_table(table, temporary_path)
        verified = pq.read_table(temporary_path)
        if verified.num_rows != table.num_rows or not verified.schema.equals(table.schema):
            raise RuntimeError(f"failed to verify temporary Parquet for {path}")
        os.replace(temporary_path, path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def _print_summary(summary: ReferenceSummary, dry_run: bool) -> None:
    print(f"pages_walked={summary.pages_walked}")
    print(f"team_rows_returned={summary.team_rows_returned}")
    print(f"team_duplicates_dropped={summary.team_duplicates_dropped}")
    print(f"distinct_teams_walked={summary.distinct_teams_walked}")
    if summary.local_match_files_read:
        for path in summary.local_match_files_read:
            print(f"local_match_files_read={path}")
    else:
        print("local_match_files_read=(none)")
    print(f"local_match_ids_seen={summary.local_match_ids_seen}")
    print(f"local_distinct_team_ids={summary.local_distinct_team_ids}")
    print(f"local_ids_resolved_by_walk={summary.local_ids_resolved_by_walk}")
    print(f"local_ids_already_cached={summary.local_ids_already_cached}")
    print(f"supplemental_attempted={summary.supplemental_attempted}")
    print(f"supplemental_succeeded={summary.supplemental_succeeded}")
    print(f"supplemental_failed={summary.supplemental_failed}")
    print(f"supplemental_deferred={summary.supplemental_deferred}")
    print(f"teams.parquet_rows={summary.teams_rows}")
    print(f"leagues.parquet_rows={summary.leagues_rows}")
    print(f"heroes.parquet_rows={summary.heroes_rows}")
    print(f"players.parquet_rows={summary.players_rows}")
    if dry_run:
        print("DRY RUN: zero filesystem writes performed")


def run(
    args: argparse.Namespace,
    *,
    client: ApiClient | None = None,
    data_dir: Path = DATA_DIR,
) -> ReferenceSummary:
    """Fetch, normalize, and optionally write all four reference datasets."""
    api = client or ApiClient()
    walked_teams, summary = walk_teams(api)
    leagues = _fetch_rows(api, "/leagues", slim_league)
    heroes = _fetch_rows(api, "/heroes", slim_hero)
    players = _fetch_rows(api, "/proPlayers", slim_reference_player)

    reference_dir = data_dir / "reference"
    teams_path = reference_dir / "teams.parquet"
    existing_teams = read_existing_teams(teams_path)
    inventory = read_local_match_inventory(data_dir)
    local_ids = set(inventory.team_ids)
    resolved_by_walk = local_ids & walked_teams.keys()
    already_cached = (local_ids - walked_teams.keys()) & existing_teams.keys()
    needed = sorted(local_ids - (walked_teams.keys() | existing_teams.keys()))
    attempted_ids = needed[:SUPPLEMENTAL_TEAM_LIMIT]
    summary.local_match_files_read = tuple(
        str(path.resolve()) for path in inventory.files_read
    )
    summary.local_match_ids_seen = inventory.match_ids_seen
    summary.local_distinct_team_ids = len(local_ids)
    summary.local_ids_resolved_by_walk = len(resolved_by_walk)
    summary.local_ids_already_cached = len(already_cached)
    summary.supplemental_attempted = len(attempted_ids)
    summary.supplemental_deferred = len(needed) - len(attempted_ids)
    accounted_ids = (
        summary.local_ids_resolved_by_walk
        + summary.local_ids_already_cached
        + summary.supplemental_attempted
        + summary.supplemental_deferred
    )
    if summary.local_distinct_team_ids != accounted_ids:
        raise AssertionError(
            "local team-ID accounting mismatch: "
            f"{summary.local_distinct_team_ids} != {accounted_ids}"
        )

    supplemental_teams: dict[int, JsonObject] = {}
    for team_id in attempted_ids:
        try:
            payload = api.get_json(f"/teams/{team_id}")
        except HTTPError as error:
            summary.supplemental_failed += 1
            print(f"supplemental_failed_team_id={team_id} http_status={error.code}")
            continue
        except RateLimitError:
            summary.supplemental_failed += 1
            print(f"supplemental_failed_team_id={team_id} http_status=429")
            continue
        if not isinstance(payload, Mapping):
            raise TypeError(f"/teams/{team_id} must return a JSON object")
        row = slim_team(payload)
        returned_id = _required_int(row, "team_id", f"/teams/{team_id}")
        if returned_id != team_id:
            raise ValueError(
                f"/teams/{team_id} returned mismatched team_id {returned_id}"
            )
        supplemental_teams[team_id] = row
        summary.supplemental_succeeded += 1

    combined_teams = dict(existing_teams)
    combined_teams.update(walked_teams)
    combined_teams.update(supplemental_teams)

    team_rows = _sort_rows(list(combined_teams.values()), "team_id")
    league_rows = _sort_rows(leagues, "leagueid")
    hero_rows = _sort_rows(heroes, "id")
    player_rows = _sort_rows(players, "account_id")
    tables = {
        "teams.parquet": _table(team_rows, TEAM_SCHEMA),
        "leagues.parquet": _table(league_rows, LEAGUE_SCHEMA),
        "heroes.parquet": _table(hero_rows, HERO_SCHEMA),
        "players.parquet": _table(player_rows, REFERENCE_PLAYER_SCHEMA),
    }

    summary.teams_rows = len(team_rows)
    summary.leagues_rows = len(league_rows)
    summary.heroes_rows = len(hero_rows)
    summary.players_rows = len(player_rows)
    _print_summary(summary, args.dry_run)

    if not args.dry_run:
        for filename, table in tables.items():
            _atomic_write_parquet(reference_dir / filename, table)
    return summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="perform API and local reads but write no files",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    run(parse_args(argv))
    return 0


__all__ = [
    "DATA_DIR",
    "LocalMatchInventory",
    "MAX_TEAM_PAGES",
    "ReferenceSummary",
    "SUPPLEMENTAL_TEAM_LIMIT",
    "TEAM_PAGE_SIZE",
    "local_match_team_ids",
    "main",
    "parse_args",
    "read_local_match_inventory",
    "read_existing_teams",
    "run",
    "walk_teams",
]


if __name__ == "__main__":
    raise SystemExit(main())
