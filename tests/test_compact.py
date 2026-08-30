from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

from ingest import compact
from ingest.schema import DRAFT_SCHEMA, MATCH_SCHEMA, PLAYER_SCHEMA


class CompactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temporary.name) / "data"
        self.month = "2026-08"

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def match_row(match_id, **overrides):
        row = {name: None for name in MATCH_SCHEMA.names}
        row.update(
            {
                "match_id": match_id,
                "start_time": 1788070000,
                "is_parsed": False,
            }
        )
        row.update(overrides)
        return row

    @staticmethod
    def player_row(match_id, player_slot=0, **overrides):
        row = {name: None for name in PLAYER_SCHEMA.names}
        row.update(
            {
                "match_id": match_id,
                "player_slot": player_slot,
                "is_radiant": player_slot < 128,
            }
        )
        row.update(overrides)
        return row

    @staticmethod
    def draft_row(match_id, order=0, **overrides):
        row = {name: None for name in DRAFT_SCHEMA.names}
        row.update({"match_id": match_id, "ord": order})
        row.update(overrides)
        return row

    def write_rows(self, table_name, rows):
        directory = self.data_dir / table_name
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{self.month}.ndjson"
        content = "".join(
            json.dumps(row, separators=(",", ":")) + "\n" for row in rows
        )
        path.write_text(content, encoding="utf-8")
        return path

    def write_month(self, *, matches=None, players=None, draft=None):
        rows = {
            "matches": matches
            if matches is not None
            else [self.match_row(1)],
            "players": players
            if players is not None
            else [self.player_row(1)],
            "draft": draft if draft is not None else [self.draft_row(1)],
        }
        return {
            table_name: self.write_rows(table_name, table_rows)
            for table_name, table_rows in rows.items()
        }

    def snapshot(self):
        return {
            path.relative_to(self.data_dir).as_posix(): path.read_bytes()
            for path in self.data_dir.rglob("*")
            if path.is_file()
        }

    def test_grace_period_boundary_is_explicit(self):
        sources = self.write_month()

        before_boundary = compact.compact_month(
            self.data_dir, self.month, date(2026, 9, 7)
        )

        self.assertIsNone(before_boundary)
        self.assertTrue(all(path.exists() for path in sources.values()))
        self.assertFalse(
            any(path.exists() for path in compact.shard_paths(
                self.data_dir, self.month, "parquet"
            ).values())
        )

        on_boundary = compact.compact_month(
            self.data_dir, self.month, date(2026, 9, 8)
        )

        self.assertIsNotNone(on_boundary)
        self.assertFalse(any(path.exists() for path in sources.values()))

    def test_row_counts_match_all_three_parquet_tables(self):
        self.write_month(
            matches=[self.match_row(1), self.match_row(2)],
            players=[
                self.player_row(1, 0),
                self.player_row(1, 128),
                self.player_row(2, 0),
            ],
            draft=[self.draft_row(1, 0), self.draft_row(1, 1)],
        )

        result = compact.compact_month(
            self.data_dir, self.month, date(2026, 9, 8)
        )

        self.assertEqual({"matches": 2, "players": 3, "draft": 2}, result.row_counts)
        for table_name, expected_rows in result.row_counts.items():
            path = self.data_dir / table_name / f"{self.month}.parquet"
            self.assertEqual(expected_rows, pq.read_table(path).num_rows)

    def test_ndjson_is_retained_until_every_parquet_verifies(self):
        sources = self.write_month()
        original_verify = compact.verify_staged_parquet
        verified_tables = []

        def verify_while_sources_exist(path, schema, expected_rows):
            self.assertTrue(all(source.exists() for source in sources.values()))
            original_verify(path, schema, expected_rows)
            verified_tables.append(path)

        with patch.object(
            compact,
            "verify_staged_parquet",
            side_effect=verify_while_sources_exist,
        ):
            compact.compact_month(self.data_dir, self.month, date(2026, 9, 8))

        self.assertEqual(3, len(verified_tables))
        self.assertFalse(any(source.exists() for source in sources.values()))

    def test_existing_parquet_is_explicitly_refused(self):
        sources = self.write_month()
        destination = self.data_dir / "matches" / f"{self.month}.parquet"
        pq.write_table(pa.Table.from_pylist([], schema=MATCH_SCHEMA), destination)

        with self.assertRaisesRegex(
            compact.CorruptShardStateError, "mixes hot and closed shards"
        ):
            compact.compact_month(self.data_dir, self.month, date(2026, 9, 8))

        self.assertTrue(all(source.exists() for source in sources.values()))
        self.assertTrue(destination.exists())

    def test_fully_closed_month_is_explicitly_refused(self):
        for table_name, schema in compact.TABLE_SCHEMAS.items():
            destination = self.data_dir / table_name / f"{self.month}.parquet"
            destination.parent.mkdir(parents=True, exist_ok=True)
            pq.write_table(pa.Table.from_pylist([], schema=schema), destination)

        with self.assertRaisesRegex(
            compact.AlreadyCompactedError, "refusing to rewrite already-compacted month"
        ):
            compact.compact_month(self.data_dir, self.month, date(2026, 9, 8))

    def test_crash_before_first_publish_leaves_sources_and_no_partial_parquet(self):
        sources = self.write_month()

        with (
            patch.object(
                compact,
                "publish_parquet",
                side_effect=RuntimeError("simulated crash before rename"),
            ),
            self.assertRaisesRegex(RuntimeError, "simulated crash"),
        ):
            compact.compact_month(self.data_dir, self.month, date(2026, 9, 8))

        self.assertTrue(all(source.exists() for source in sources.values()))
        self.assertFalse(
            any(path.exists() for path in compact.shard_paths(
                self.data_dir, self.month, "parquet"
            ).values())
        )
        temporary_files = [
            path for path in self.data_dir.rglob("*") if path.is_file() and path.name.startswith(".")
        ]
        self.assertEqual([], temporary_files)

    def test_dry_run_writes_nothing(self):
        self.write_month()
        before = self.snapshot()

        result = compact.compact_month(
            self.data_dir,
            self.month,
            date(2026, 9, 8),
            dry_run=True,
        )

        self.assertTrue(result.dry_run)
        self.assertEqual(before, self.snapshot())

    def test_nullable_fields_and_arrow_types_round_trip(self):
        self.write_month(
            matches=[
                self.match_row(
                    1,
                    radiant_team_id=None,
                    dire_team_id=None,
                    radiant_team_name=None,
                    dire_team_name=None,
                    series_id=None,
                    series_type=None,
                    patch=None,
                )
            ]
        )

        compact.compact_month(self.data_dir, self.month, date(2026, 9, 8))

        table = pq.read_table(
            self.data_dir / "matches" / f"{self.month}.parquet"
        )
        self.assertTrue(table.schema.equals(MATCH_SCHEMA))
        row = table.to_pylist()[0]
        for name in (
            "radiant_team_id",
            "dire_team_id",
            "radiant_team_name",
            "dire_team_name",
            "series_id",
            "series_type",
            "patch",
        ):
            self.assertIsNone(row[name])
        player_table = pq.read_table(
            self.data_dir / "players" / f"{self.month}.parquet"
        )
        self.assertTrue(player_table.schema.equals(PLAYER_SCHEMA))
        player = player_table.to_pylist()[0]
        for name in ("stuns", "teamfight_participation"):
            self.assertIsNone(player[name])
            self.assertEqual(1, player_table[name].null_count)

    def test_match_without_draft_rows_compacts_with_empty_typed_draft(self):
        self.write_month(draft=[])

        result = compact.compact_month(
            self.data_dir, self.month, date(2026, 9, 8)
        )

        self.assertEqual(0, result.row_counts["draft"])
        draft = pq.read_table(
            self.data_dir / "draft" / f"{self.month}.parquet"
        )
        self.assertEqual(0, draft.num_rows)
        self.assertTrue(draft.schema.equals(DRAFT_SCHEMA))


if __name__ == "__main__":
    unittest.main()
