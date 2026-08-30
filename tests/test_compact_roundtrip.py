from __future__ import annotations

import json
import math
import shutil
import tempfile
import unittest
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from ingest import compact


class RealDataCompactRoundTripTests(unittest.TestCase):
    MONTH = "2026-08"
    EXPECTED_ROWS = {"matches": 299, "players": 2_990, "draft": 7_170}
    FULL_DATASET_MATCHES = 147_495

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.data_dir = Path(cls.temporary.name) / "data"
        cls.source_rows = {}
        cls.ndjson_sizes = {}

        repository_data = Path(__file__).resolve().parents[1] / "data"
        for table_name in compact.TABLE_SCHEMAS:
            source = repository_data / table_name / f"{cls.MONTH}.ndjson"
            destination = cls.data_dir / table_name / source.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            cls.ndjson_sizes[table_name] = source.stat().st_size
            cls.source_rows[table_name] = [
                json.loads(line)
                for line in source.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]

        compact.compact_month(cls.data_dir, cls.MONTH, date(2026, 9, 8))
        cls.parquet_tables = {
            table_name: pq.read_table(
                cls.data_dir / table_name / f"{cls.MONTH}.parquet"
            )
            for table_name in compact.TABLE_SCHEMAS
        }
        cls.parquet_sizes = {
            table_name: (
                cls.data_dir / table_name / f"{cls.MONTH}.parquet"
            ).stat().st_size
            for table_name in compact.TABLE_SCHEMAS
        }

        ndjson_total = sum(cls.ndjson_sizes.values())
        parquet_total = sum(cls.parquet_sizes.values())
        scale = cls.FULL_DATASET_MATCHES / cls.EXPECTED_ROWS["matches"]
        projection_bytes = parquet_total * scale
        print(
            "ROUNDTRIP_SIZES "
            + " ".join(
                f"{name}_ndjson={cls.ndjson_sizes[name]} "
                f"{name}_parquet={cls.parquet_sizes[name]}"
                for name in compact.TABLE_SCHEMAS
            )
        )
        print(
            f"ROUNDTRIP_TOTALS ndjson={ndjson_total} parquet={parquet_total} "
            f"projection_147495_bytes={projection_bytes:.0f} "
            f"projection_147495_MiB={projection_bytes / (1024 * 1024):.2f}"
        )

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_real_august_shards_round_trip_every_row_and_column(self):
        for table_name, expected_rows in self.EXPECTED_ROWS.items():
            self.assertEqual(expected_rows, len(self.source_rows[table_name]))
            self.assertEqual(expected_rows, self.parquet_tables[table_name].num_rows)
            self.assertTrue(
                self.parquet_tables[table_name].schema.equals(
                    compact.TABLE_SCHEMAS[table_name]
                )
            )

        source_matches = self.source_rows["matches"]
        parquet_matches = self.parquet_tables["matches"].to_pylist()
        nullable_match_fields = (
            "radiant_team_id",
            "dire_team_id",
            "radiant_team_name",
            "dire_team_name",
            "series_id",
            "series_type",
            "radiant_captain",
            "dire_captain",
        )
        null_counts = {}
        for field_name in nullable_match_fields:
            source_null_rows = [
                index
                for index, row in enumerate(source_matches)
                if row[field_name] is None
            ]
            parquet_null_rows = [
                index
                for index, row in enumerate(parquet_matches)
                if row[field_name] is None
            ]
            self.assertEqual(source_null_rows, parquet_null_rows, field_name)
            for index in source_null_rows:
                self.assertIsNone(parquet_matches[index][field_name])
            null_counts[field_name] = len(source_null_rows)

        for field_name in (
            "radiant_team_id",
            "dire_team_id",
            "radiant_team_name",
            "dire_team_name",
            "series_id",
            "series_type",
        ):
            self.assertGreater(null_counts[field_name], 0, field_name)
            self.assertLess(null_counts[field_name], len(source_matches), field_name)
        print(
            "ROUNDTRIP_MATCH_NULLS "
            + " ".join(f"{name}={count}" for name, count in null_counts.items())
        )

        players = self.parquet_tables["players"]
        source_players = self.source_rows["players"]
        parquet_players = players.to_pylist()
        real_null_counts = {}
        for field_name in ("stuns", "teamfight_participation"):
            source_null_rows = [
                index
                for index, row in enumerate(source_players)
                if row[field_name] is None
            ]
            parquet_null_rows = [
                index
                for index, row in enumerate(parquet_players)
                if row[field_name] is None
            ]
            self.assertEqual(source_null_rows, parquet_null_rows, field_name)
            self.assertEqual(len(source_null_rows), players[field_name].null_count)
            self.assertTrue(pa.types.is_float32(players.schema.field(field_name).type))
            for index in source_null_rows:
                self.assertIsNone(parquet_players[index][field_name])
            real_null_counts[field_name] = len(source_null_rows)
        print(
            "ROUNDTRIP_PLAYER_NULLS "
            + " ".join(
                f"{name}={count}" for name, count in real_null_counts.items()
            )
        )

        backpack_field = players.schema.field("backpack_3")
        self.assertTrue(backpack_field.nullable)
        self.assertTrue(pa.types.is_int32(backpack_field.type))
        self.assertEqual(self.EXPECTED_ROWS["players"], players["backpack_3"].null_count)
        self.assertTrue(all(row["backpack_3"] is None for row in players.to_pylist()))

        source_draft_counts = Counter(
            row["match_id"] for row in self.source_rows["draft"]
        )
        parquet_draft_rows = self.parquet_tables["draft"].to_pylist()
        parquet_draft_counts = Counter(row["match_id"] for row in parquet_draft_rows)
        self.assertEqual(source_draft_counts, parquet_draft_counts)
        short_match_ids = sorted(
            match_id for match_id, count in source_draft_counts.items() if count == 23
        )
        self.assertEqual(6, len(short_match_ids))
        parquet_orders = defaultdict(list)
        for row in parquet_draft_rows:
            parquet_orders[row["match_id"]].append(row["ord"])
        for match_id in short_match_ids:
            self.assertEqual(23, parquet_draft_counts[match_id])
            self.assertEqual(list(range(23)), parquet_orders[match_id])
        print(f"ROUNDTRIP_23_DRAFT_MATCH_IDS {short_match_ids}")

        difference_counts = Counter()
        examples = []
        for table_name in compact.TABLE_SCHEMAS:
            source_rows = self.source_rows[table_name]
            parquet_rows = self.parquet_tables[table_name].to_pylist()
            field_names = compact.TABLE_SCHEMAS[table_name].names
            for row_index, (source_row, parquet_row) in enumerate(
                zip(source_rows, parquet_rows, strict=True)
            ):
                self.assertEqual(field_names, list(source_row), table_name)
                self.assertEqual(field_names, list(parquet_row), table_name)
                for field_name in field_names:
                    source_value = source_row[field_name]
                    parquet_value = parquet_row[field_name]
                    if table_name == "players" and field_name in (
                        "stuns",
                        "teamfight_participation",
                    ):
                        if source_value is None or parquet_value is None:
                            if source_value is not parquet_value:
                                difference_counts[
                                    (table_name, field_name, "null")
                                ] += 1
                            continue
                        if not math.isclose(
                            source_value,
                            parquet_value,
                            rel_tol=1e-6,
                        ):
                            difference_counts[
                                (table_name, field_name, "tolerance")
                            ] += 1
                            if len(examples) < 20:
                                examples.append(
                                    {
                                        "table": table_name,
                                        "row": row_index,
                                        "column": field_name,
                                        "source": source_value,
                                        "parquet": parquet_value,
                                    }
                                )
                        continue
                    value_changed = source_value != parquet_value
                    type_changed = type(source_value) is not type(parquet_value)
                    if not value_changed and not type_changed:
                        continue
                    change = (
                        "value+type"
                        if value_changed and type_changed
                        else "value"
                        if value_changed
                        else "type"
                    )
                    difference_counts[(table_name, field_name, change)] += 1
                    if len(examples) < 20:
                        examples.append(
                            {
                                "table": table_name,
                                "row": row_index,
                                "column": field_name,
                                "source": source_value,
                                "source_type": type(source_value).__name__,
                                "parquet": parquet_value,
                                "parquet_type": type(parquet_value).__name__,
                            }
                        )

        self.assertEqual(
            {},
            dict(difference_counts),
            "NDJSON values/types changed during compaction; "
            f"counts={dict(difference_counts)} examples={examples}",
        )


if __name__ == "__main__":
    unittest.main()
