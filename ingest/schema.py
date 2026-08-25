"""Exhaustive PyArrow schemas for every persisted dataset."""

from __future__ import annotations

import pyarrow as pa


MATCH_SCHEMA = pa.schema(
    [
        pa.field("match_id", pa.int64(), nullable=False),
        pa.field("start_time", pa.int64()),
        pa.field("duration", pa.int32()),
        pa.field("leagueid", pa.int32()),
        pa.field("league_name", pa.string()),
        pa.field("league_tier", pa.string()),
        pa.field("series_id", pa.int32()),
        pa.field("series_type", pa.int32()),
        pa.field("radiant_team_id", pa.int32()),
        pa.field("dire_team_id", pa.int32()),
        pa.field("radiant_team_name", pa.string()),
        pa.field("dire_team_name", pa.string()),
        pa.field("radiant_captain", pa.int64()),
        pa.field("dire_captain", pa.int64()),
        pa.field("radiant_win", pa.bool_()),
        pa.field("radiant_score", pa.int32()),
        pa.field("dire_score", pa.int32()),
        pa.field("first_blood_time", pa.int32()),
        pa.field("game_mode", pa.int32()),
        pa.field("lobby_type", pa.int32()),
        pa.field("patch", pa.string()),
        pa.field("is_parsed", pa.bool_()),
        pa.field("tower_status_radiant", pa.int32()),
        pa.field("tower_status_dire", pa.int32()),
        pa.field("barracks_status_radiant", pa.int32()),
        pa.field("barracks_status_dire", pa.int32()),
        pa.field("radiant_gold_adv", pa.list_(pa.int32())),
        pa.field("radiant_xp_adv", pa.list_(pa.int32())),
    ]
)


PLAYER_SCHEMA = pa.schema(
    [
        pa.field("match_id", pa.int64(), nullable=False),
        pa.field("account_id", pa.int64()),
        pa.field("player_slot", pa.int32()),
        pa.field("is_radiant", pa.bool_()),
        pa.field("hero_id", pa.int32()),
        pa.field("hero_variant", pa.int32()),
        pa.field("kills", pa.int32()),
        pa.field("deaths", pa.int32()),
        pa.field("assists", pa.int32()),
        pa.field("last_hits", pa.int32()),
        pa.field("denies", pa.int32()),
        pa.field("gold_per_min", pa.int32()),
        pa.field("xp_per_min", pa.int32()),
        pa.field("net_worth", pa.int32()),
        pa.field("level", pa.int32()),
        pa.field("hero_damage", pa.int32()),
        pa.field("tower_damage", pa.int64()),
        pa.field("hero_healing", pa.int64()),
        pa.field("stuns", pa.float32()),
        pa.field("teamfight_participation", pa.float32()),
        pa.field("obs_placed", pa.int32()),
        pa.field("sen_placed", pa.int32()),
        pa.field("camps_stacked", pa.int32()),
        pa.field("rune_pickups", pa.int32()),
        pa.field("lane", pa.int32()),
        pa.field("lane_role", pa.int32()),
        pa.field("is_roaming", pa.bool_()),
        pa.field("leaver_status", pa.int32()),
        pa.field("item_0", pa.int32()),
        pa.field("item_1", pa.int32()),
        pa.field("item_2", pa.int32()),
        pa.field("item_3", pa.int32()),
        pa.field("item_4", pa.int32()),
        pa.field("item_5", pa.int32()),
        pa.field("backpack_0", pa.int32()),
        pa.field("backpack_1", pa.int32()),
        pa.field("backpack_2", pa.int32()),
        pa.field("backpack_3", pa.int32()),
        pa.field("item_neutral", pa.int32()),
    ]
)


DRAFT_SCHEMA = pa.schema(
    [
        pa.field("match_id", pa.int64(), nullable=False),
        pa.field("is_pick", pa.bool_()),
        pa.field("hero_id", pa.int32()),
        pa.field("team", pa.int16()),
        pa.field("ord", pa.int16()),
    ]
)


# Reference IDs preserve their source-table widths: reference_teams.team_id and
# reference_leagues.leagueid are int64, while the corresponding match IDs are int32.
TEAM_SCHEMA = pa.schema(
    [
        pa.field("team_id", pa.int64()),
        pa.field("name", pa.string()),
        pa.field("tag", pa.string()),
        pa.field("logo_url", pa.string()),
    ]
)


REFERENCE_PLAYER_SCHEMA = pa.schema(
    [
        pa.field("account_id", pa.int64()),
        pa.field("name", pa.string()),
        pa.field("country_code", pa.string()),
        pa.field("fantasy_role", pa.int32()),
        pa.field("team_id", pa.int32()),
        pa.field("team_name", pa.string()),
        pa.field("team_tag", pa.string()),
        pa.field("is_pro", pa.bool_()),
    ]
)


LEAGUE_SCHEMA = pa.schema(
    [
        pa.field("leagueid", pa.int64()),
        pa.field("name", pa.string()),
        pa.field("tier", pa.string()),
        pa.field("banner", pa.string()),
    ]
)


HERO_SCHEMA = pa.schema(
    [
        pa.field("id", pa.int32()),
        pa.field("name", pa.string()),
        pa.field("localized_name", pa.string()),
        pa.field("primary_attr", pa.string()),
        pa.field("attack_type", pa.string()),
        pa.field("roles", pa.list_(pa.string())),
    ]
)


SCHEMAS: dict[str, pa.Schema] = {
    "matches": MATCH_SCHEMA,
    "players": PLAYER_SCHEMA,
    "draft": DRAFT_SCHEMA,
    "reference_teams": TEAM_SCHEMA,
    "reference_players": REFERENCE_PLAYER_SCHEMA,
    "reference_leagues": LEAGUE_SCHEMA,
    "reference_heroes": HERO_SCHEMA,
}


def get_schema(name: str) -> pa.Schema:
    """Return the schema registered for ``name``."""
    return SCHEMAS[name]


__all__ = [
    "DRAFT_SCHEMA",
    "HERO_SCHEMA",
    "LEAGUE_SCHEMA",
    "MATCH_SCHEMA",
    "PLAYER_SCHEMA",
    "REFERENCE_PLAYER_SCHEMA",
    "SCHEMAS",
    "TEAM_SCHEMA",
    "get_schema",
]


if __name__ == "__main__":
    import tempfile
    from pathlib import Path

    import pyarrow.parquet as pq

    for schema_name, schema in SCHEMAS.items():
        print(f"=== {schema_name} ===")
        print(schema)
        try:
            table = pa.Table.from_pylist([], schema=schema)
            with tempfile.TemporaryDirectory() as temporary_directory:
                parquet_path = Path(temporary_directory) / f"{schema_name}.parquet"
                pq.write_table(table, parquet_path)
                round_tripped = pq.read_table(parquet_path)
            assert round_tripped.schema.equals(schema)
        except Exception:
            print("FAIL")
            raise
        print("PASS")
