"""Map OpenDota API payloads to the exact persisted row shapes."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any, TypeAlias

from .schema import (
    DRAFT_SCHEMA,
    HERO_SCHEMA,
    LEAGUE_SCHEMA,
    MATCH_SCHEMA,
    PLAYER_SCHEMA,
    REFERENCE_PLAYER_SCHEMA,
    TEAM_SCHEMA,
)

JsonObject: TypeAlias = Mapping[str, Any]
PatchLookup: TypeAlias = Mapping[int, str]
Row: TypeAlias = dict[str, Any]


def _object(value: Any) -> JsonObject:
    return value if isinstance(value, Mapping) else {}


def _objects(value: Any) -> Sequence[JsonObject]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, Mapping))


def _project(source: JsonObject, names: Sequence[str]) -> Row:
    """Return exactly the requested keys, preserving missing values as null."""
    return {name: source.get(name) for name in names}


def _first_present(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def slim_match(payload: JsonObject, patch_lookup: PatchLookup) -> Row:
    """Create the single match row from a `/matches/{id}` response."""
    row = _project(payload, MATCH_SCHEMA.names)
    league = _object(payload.get("league"))
    radiant_team = _object(payload.get("radiant_team"))
    dire_team = _object(payload.get("dire_team"))

    row["league_name"] = _first_present(
        payload.get("league_name"), league.get("name")
    )
    row["league_tier"] = _first_present(
        payload.get("league_tier"), league.get("tier")
    )
    # Prefer the match-level names in case OpenDota restores historical names there;
    # nested team names are current names and are only a fallback.
    row["radiant_team_name"] = _first_present(
        payload.get("radiant_name"), radiant_team.get("name")
    )
    row["dire_team_name"] = _first_present(
        payload.get("dire_name"), dire_team.get("name")
    )
    patch_index = payload.get("patch")
    patch_name = (
        patch_lookup.get(patch_index)
        if isinstance(patch_index, int) and not isinstance(patch_index, bool)
        else None
    )
    row["patch"] = patch_name if isinstance(patch_name, str) else None
    row["is_parsed"] = payload.get("version") is not None
    return row


def shard_month(match_row: JsonObject) -> str:
    """Return the UTC `YYYY-MM` shard selected by a match's start time."""
    start_time = match_row.get("start_time")
    if not isinstance(start_time, int) or isinstance(start_time, bool):
        raise TypeError("match row start_time must be an integer")
    return datetime.fromtimestamp(start_time, tz=timezone.utc).strftime("%Y-%m")


def slim_players(payload: JsonObject) -> list[Row]:
    """Create all player rows from a `/matches/{id}` response."""
    match_id = payload.get("match_id")
    rows: list[Row] = []
    for player in _objects(payload.get("players")):
        row = _project(player, PLAYER_SCHEMA.names)
        player_slot = player.get("player_slot")
        row["match_id"] = match_id
        row["is_radiant"] = (
            player_slot < 128 if isinstance(player_slot, int) else None
        )
        rows.append(row)
    return rows


def slim_draft(payload: JsonObject) -> list[Row]:
    """Create draft rows and normalize the REST ordering key to `ord`."""
    match_id = payload.get("match_id")
    rows: list[Row] = []
    for pick_or_ban in _objects(payload.get("picks_bans")):
        row = _project(pick_or_ban, DRAFT_SCHEMA.names)
        row["match_id"] = match_id
        row["ord"] = _first_present(
            pick_or_ban.get("order"), pick_or_ban.get("ord")
        )
        rows.append(row)
    return rows


def slim_match_response(
    payload: JsonObject, patch_lookup: PatchLookup
) -> tuple[Row, list[Row], list[Row]]:
    """Return match, player, and draft rows for one detailed match response."""
    if not isinstance(payload, Mapping):
        raise TypeError("match response must be a mapping")
    return slim_match(payload, patch_lookup), slim_players(payload), slim_draft(payload)


def slim_team(payload: JsonObject) -> Row:
    """Create one `/teams` reference row."""
    return _project(payload, TEAM_SCHEMA.names)


def slim_reference_player(payload: JsonObject) -> Row:
    """Create one notable-player reference row."""
    return _project(payload, REFERENCE_PLAYER_SCHEMA.names)


def slim_league(payload: JsonObject) -> Row:
    """Create one `/leagues` reference row."""
    return _project(payload, LEAGUE_SCHEMA.names)


def slim_hero(payload: JsonObject) -> Row:
    """Create one `/heroes` reference row."""
    return _project(payload, HERO_SCHEMA.names)


__all__ = [
    "shard_month",
    "slim_draft",
    "slim_hero",
    "slim_league",
    "slim_match",
    "slim_match_response",
    "slim_players",
    "slim_reference_player",
    "slim_team",
]
