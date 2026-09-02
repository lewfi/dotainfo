from __future__ import annotations

import copy
import io
import json
import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import pyarrow as pa
import pyarrow.parquet as pq

from ingest import reference
from ingest.schema import (
    HERO_SCHEMA,
    ITEM_SCHEMA,
    LEAGUE_SCHEMA,
    MATCH_SCHEMA,
    REFERENCE_PLAYER_SCHEMA,
    TEAM_SCHEMA,
)


FIXTURE_DIR = Path(__file__).parent / "fixtures"


class FakeApiClient:
    def __init__(
        self,
        team_pages,
        *,
        supplemental=None,
        leagues=None,
        heroes=None,
        items=None,
        players=None,
    ):
        self.team_pages = team_pages
        self.supplemental = supplemental or {}
        self.leagues = leagues or []
        self.heroes = heroes or []
        self.items = items or {}
        self.players = players or []
        self.calls = []

    def get_json(self, path, params=None):
        self.calls.append((path, copy.deepcopy(params)))
        if path == "/teams":
            page = params["page"]
            if page >= len(self.team_pages):
                raise AssertionError(f"unexpected teams page: {page}")
            return copy.deepcopy(self.team_pages[page])
        if path.startswith("/teams/"):
            team_id = int(path.rsplit("/", 1)[1])
            result = self.supplemental[team_id]
            if isinstance(result, Exception):
                raise result
            return copy.deepcopy(result)
        if path == "/leagues":
            return copy.deepcopy(self.leagues)
        if path == "/heroes":
            return copy.deepcopy(self.heroes)
        if path == "/constants/items":
            return copy.deepcopy(self.items)
        if path == "/proPlayers":
            return copy.deepcopy(self.players)
        raise AssertionError(f"unexpected API path: {path}")


def team(team_id, name=None, tag=None, logo_url=None):
    return {
        "team_id": team_id,
        "name": name if name is not None else f"Team {team_id}",
        "tag": tag if tag is not None else f"T{team_id}",
        "logo_url": logo_url,
    }


class ReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.team_detail = json.loads(
            (FIXTURE_DIR / "team_detail.json").read_text(encoding="utf-8")
        )
        cls.leagues = json.loads(
            (FIXTURE_DIR / "leagues_subset.json").read_text(encoding="utf-8")
        )
        cls.heroes = json.loads(
            (FIXTURE_DIR / "heroes.json").read_text(encoding="utf-8")
        )[:4]
        cls.items = json.loads(
            (FIXTURE_DIR / "items_subset.json").read_text(encoding="utf-8")
        )
        cls.players = json.loads(
            (FIXTURE_DIR / "pro_players_subset.json").read_text(encoding="utf-8")
        )

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temporary.name) / "data"
        self.data_dir.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def client(self, team_pages, **kwargs):
        return FakeApiClient(
            team_pages,
            leagues=kwargs.pop("leagues", self.leagues),
            heroes=kwargs.pop("heroes", self.heroes),
            items=kwargs.pop("items", self.items),
            players=kwargs.pop("players", self.players),
            **kwargs,
        )

    def execute(self, client, *, dry_run=False):
        output = io.StringIO()
        with redirect_stdout(output):
            summary = reference.run(
                Namespace(dry_run=dry_run),
                client=client,
                data_dir=self.data_dir,
            )
        return summary, output.getvalue()

    def write_local_ndjson(self, rows, filename="2026-08.ndjson"):
        matches_dir = self.data_dir / "matches"
        matches_dir.mkdir(exist_ok=True)
        (matches_dir / filename).write_text(
            "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
        )

    def write_existing_teams(self, rows):
        reference_dir = self.data_dir / "reference"
        reference_dir.mkdir(exist_ok=True)
        pq.write_table(
            pa.Table.from_pylist(rows, schema=TEAM_SCHEMA),
            reference_dir / "teams.parquet",
        )

    def snapshot(self):
        return {
            path.relative_to(self.data_dir).as_posix(): path.read_bytes()
            for path in self.data_dir.rglob("*")
            if path.is_file()
        }

    def test_paging_stops_on_first_short_page(self):
        client = self.client([[team(2), team(1)]])

        rows, summary = reference.walk_teams(client)

        self.assertEqual({1, 2}, set(rows))
        self.assertEqual(1, summary.pages_walked)
        self.assertEqual([("/teams", {"page": 0})], client.calls)

    def test_full_final_page_requires_following_empty_page(self):
        full_page = [team(team_id) for team_id in range(1, 1001)]
        client = self.client([full_page, []])

        rows, summary = reference.walk_teams(client)

        self.assertEqual(1000, len(rows))
        self.assertEqual(2, summary.pages_walked)
        self.assertEqual(
            [("/teams", {"page": 0}), ("/teams", {"page": 1})],
            client.calls,
        )

    def test_paging_raises_at_hard_ceiling(self):
        team_pages = [
            [team(team_id)] for team_id in range(reference.MAX_TEAM_PAGES)
        ]
        client = self.client(team_pages)

        with patch.object(reference, "TEAM_PAGE_SIZE", 1):
            with self.assertRaisesRegex(RuntimeError, "100-page ceiling"):
                reference.walk_teams(client)

        self.assertEqual(
            [
                ("/teams", {"page": page})
                for page in range(reference.MAX_TEAM_PAGES)
            ],
            client.calls,
        )

    def test_duplicate_team_ids_collapse_and_first_occurrence_wins(self):
        full_page = [team(team_id) for team_id in range(1, 1001)]
        full_page[0] = team(1, name="first")
        client = self.client([full_page, [team(1, name="second"), team(1001)]])

        rows, summary = reference.walk_teams(client)

        self.assertEqual(1001, len(rows))
        self.assertEqual(1, summary.team_duplicates_dropped)
        self.assertEqual("first", rows[1]["name"])

    def test_supplemental_diff_excludes_existing_parquet_ids(self):
        self.write_existing_teams([team(2, name="cached")])
        self.write_local_ndjson(
            [{"radiant_team_id": 1, "dire_team_id": 2},
             {"radiant_team_id": 3, "dire_team_id": None}]
        )
        detail = dict(self.team_detail, team_id=3, name="supplemental")
        client = self.client([[team(1)]], supplemental={3: detail})

        summary, _ = self.execute(client)

        supplemental_calls = [path for path, _ in client.calls if path.startswith("/teams/")]
        self.assertEqual(["/teams/3"], supplemental_calls)
        self.assertEqual(1, summary.supplemental_succeeded)
        self.assertEqual(
            summary.local_distinct_team_ids,
            summary.local_ids_resolved_by_walk
            + summary.supplemental_attempted
            + summary.local_ids_already_cached,
        )
        rows = pq.read_table(
            self.data_dir / "reference" / "teams.parquet"
        ).to_pylist()
        self.assertEqual([1, 2, 3], [row["team_id"] for row in rows])

    def test_supplemental_cap_reports_deferred_ids(self):
        self.write_local_ndjson(
            [
                {"radiant_team_id": team_id, "dire_team_id": None}
                for team_id in range(1, 603)
            ]
        )
        supplemental = {
            team_id: dict(self.team_detail, team_id=team_id)
            for team_id in range(1, 601)
        }
        client = self.client([[]], supplemental=supplemental)

        summary, output = self.execute(client, dry_run=True)

        self.assertEqual(600, summary.supplemental_attempted)
        self.assertEqual(600, summary.supplemental_succeeded)
        self.assertEqual(2, summary.supplemental_deferred)
        self.assertEqual(
            summary.local_distinct_team_ids,
            summary.local_ids_resolved_by_walk
            + summary.local_ids_already_cached
            + summary.supplemental_attempted
            + summary.supplemental_deferred,
        )
        self.assertIn("supplemental_deferred=2", output)

    def test_supplemental_404_is_nonfatal_and_other_ids_land(self):
        self.write_local_ndjson(
            [{"radiant_team_id": 10, "dire_team_id": 11}]
        )
        missing = HTTPError("test", 404, "not found", {}, None)
        client = self.client(
            [[]],
            supplemental={
                10: missing,
                11: dict(self.team_detail, team_id=11, name="found"),
            },
        )
        try:
            summary, output = self.execute(client)
        finally:
            missing.close()

        self.assertEqual(2, summary.supplemental_attempted)
        self.assertEqual(1, summary.supplemental_succeeded)
        self.assertEqual(1, summary.supplemental_failed)
        self.assertIn("supplemental_failed_team_id=10 http_status=404", output)
        rows = pq.read_table(
            self.data_dir / "reference" / "teams.parquet"
        ).to_pylist()
        self.assertEqual([11], [row["team_id"] for row in rows])

    def test_every_output_is_sorted_and_uses_its_schema(self):
        client = self.client(
            [[team(3), team(1), team(2, tag="")]],
            leagues=list(reversed(self.leagues)),
            heroes=list(reversed(self.heroes)),
            players=list(reversed(self.players)),
        )

        self.execute(client)

        expectations = {
            "teams.parquet": ("team_id", TEAM_SCHEMA),
            "leagues.parquet": ("leagueid", LEAGUE_SCHEMA),
            "heroes.parquet": ("id", HERO_SCHEMA),
            "items.parquet": ("id", ITEM_SCHEMA),
            "players.parquet": ("account_id", REFERENCE_PLAYER_SCHEMA),
        }
        for filename, (key, schema) in expectations.items():
            with self.subTest(filename=filename):
                table = pq.read_table(self.data_dir / "reference" / filename)
                self.assertTrue(table.schema.equals(schema))
                values = table.column(key).to_pylist()
                self.assertEqual(sorted(values), values)
        teams = pq.read_table(
            self.data_dir / "reference" / "teams.parquet"
        ).to_pylist()
        self.assertEqual("", next(row for row in teams if row["team_id"] == 2)["tag"])

    def test_dry_run_reads_everything_and_writes_no_files(self):
        self.write_local_ndjson(
            [{"radiant_team_id": 1, "dire_team_id": None}]
        )
        before = self.snapshot()
        client = self.client([[team(1)]])

        _, output = self.execute(client, dry_run=True)

        self.assertEqual(before, self.snapshot())
        self.assertIn("DRY RUN: zero filesystem writes performed", output)
        self.assertIn(("/proPlayers", None), client.calls)
        self.assertIn(("/constants/items", None), client.calls)

    def test_local_team_ids_cover_ndjson_late_and_parquet(self):
        self.write_local_ndjson(
            [{"radiant_team_id": 1, "dire_team_id": 2}]
        )
        self.write_local_ndjson(
            [{"radiant_team_id": 3, "dire_team_id": None}], "late.ndjson"
        )
        matches_dir = self.data_dir / "matches"
        row = {field.name: None for field in MATCH_SCHEMA}
        row.update(
            {
                "match_id": 1,
                "radiant_team_id": 4,
                "dire_team_id": 5,
            }
        )
        pq.write_table(
            pa.Table.from_pylist([row], schema=MATCH_SCHEMA),
            matches_dir / "2026-07.parquet",
        )

        inventory = reference.read_local_match_inventory(self.data_dir)
        self.assertEqual({1, 2, 3, 4, 5}, set(inventory.team_ids))
        self.assertEqual(3, inventory.match_ids_seen)
        self.assertEqual(3, len(inventory.files_read))


if __name__ == "__main__":
    unittest.main()
