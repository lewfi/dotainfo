"""Offline contract tests for OpenDota match slimming."""

from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path
from typing import Any

import pyarrow as pa

from ingest.schema import SCHEMAS
from ingest.slim import shard_month, slim_match, slim_match_response


FIXTURE_DIR = Path(__file__).parent / "fixtures"
MATCH_FIXTURES = {
    "parsed": "match_parsed.json",
    "unparsed": "match_unparsed.json",
    "synthetic_precedence": "synthetic_precedence.json",
}


def load_fixture(name: str) -> Any:
    with (FIXTURE_DIR / name).open(encoding="utf-8") as fixture_file:
        return json.load(fixture_file)


class SlimMatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        patch_constants = load_fixture("constants_patch.json")
        cls.patch_lookup = {
            patch["id"]: patch["name"] for patch in patch_constants
        }
        cls.responses = {
            name: load_fixture(filename)
            for name, filename in MATCH_FIXTURES.items()
        }

    def slim_response(
        self, name: str
    ) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
        return slim_match_response(self.responses[name], self.patch_lookup)

    def test_all_persisted_rows_validate_against_schemas(self) -> None:
        for name in MATCH_FIXTURES:
            with self.subTest(fixture=name):
                match_row, player_rows, draft_rows = self.slim_response(name)
                pa.Table.from_pylist([match_row], schema=SCHEMAS["matches"])
                pa.Table.from_pylist(player_rows, schema=SCHEMAS["players"])
                pa.Table.from_pylist(draft_rows, schema=SCHEMAS["draft"])

    def test_parsed_match_patch_and_parse_state(self) -> None:
        match_row, _, _ = self.slim_response("parsed")
        self.assertEqual(match_row["patch"], "7.41")
        self.assertIs(match_row["is_parsed"], True)

    def test_unparsed_match_is_nullable_without_error(self) -> None:
        match_row, player_rows, _ = self.slim_response("unparsed")
        self.assertEqual(match_row["patch"], "7.40")
        self.assertIs(match_row["is_parsed"], False)
        self.assertIsNone(match_row["radiant_gold_adv"])
        self.assertIsNone(match_row["radiant_xp_adv"])

        parsed_only_player_fields = (
            "stuns",
            "teamfight_participation",
            "obs_placed",
            "sen_placed",
            "camps_stacked",
            "rune_pickups",
            "lane",
            "lane_role",
            "is_roaming",
        )
        for player_row in player_rows:
            for field in parsed_only_player_fields:
                self.assertIsNone(player_row[field])

    def test_match_level_team_names_take_precedence(self) -> None:
        match_row, _, _ = self.slim_response("synthetic_precedence")
        self.assertEqual(match_row["radiant_team_name"], "HISTORICAL_RADIANT")
        self.assertEqual(match_row["dire_team_name"], "HISTORICAL_DIRE")
        self.assertNotEqual(match_row["radiant_team_name"], "CURRENT_RADIANT")
        self.assertNotEqual(match_row["dire_team_name"], "CURRENT_DIRE")

    def test_unknown_patch_is_null_and_caller_records_index(self) -> None:
        response = copy.copy(self.responses["parsed"])
        response["patch"] = 999_999
        run_summary: dict[str, list[int]] = {"unknown_patch_indices": []}

        match_row = slim_match(response, self.patch_lookup)
        if response.get("patch") is not None and match_row["patch"] is None:
            run_summary["unknown_patch_indices"].append(response["patch"])

        self.assertIsNone(match_row["patch"])
        self.assertEqual(run_summary["unknown_patch_indices"], [999_999])

    def test_each_match_has_exactly_ten_player_rows(self) -> None:
        for name in MATCH_FIXTURES:
            with self.subTest(fixture=name):
                _, player_rows, _ = self.slim_response(name)
                self.assertEqual(len(player_rows), 10)

    def test_draft_order_is_contiguous_from_zero(self) -> None:
        for name in MATCH_FIXTURES:
            with self.subTest(fixture=name):
                _, _, draft_rows = self.slim_response(name)
                orders = [row["ord"] for row in draft_rows]
                self.assertEqual(orders, list(range(len(orders))))

    def test_shard_month_uses_utc_start_time(self) -> None:
        expected_months = {
            "parsed": "2026-08",
            "unparsed": "2026-02",
            "synthetic_precedence": "2026-08",
        }
        for name, expected_month in expected_months.items():
            with self.subTest(fixture=name):
                match_row, _, _ = self.slim_response(name)
                self.assertEqual(shard_month(match_row), expected_month)


if __name__ == "__main__":
    unittest.main()
