from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date
from email.message import Message
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import pyarrow as pa
import pyarrow.parquet as pq

from ingest.backfill import (
    EXPLORER_INTERVAL_SECONDS,
    EXPLORER_RATE_LIMIT_RETRIES,
    ExplorerClient,
    ExplorerRateLimitError,
    ExplorerTimeout,
    MATCH_QUERY_COLUMNS,
    MonthRows,
    ZeroPlayerRowsError,
    build_draft_query,
    build_match_query,
    build_player_query,
    fetch_month_rows,
    last_fully_closed_month,
    main,
    run_backfill,
    write_month,
)
from ingest.fetch import append_rows_atomically as real_append_rows_atomically
from ingest.schema import DRAFT_SCHEMA, MATCH_SCHEMA, PLAYER_SCHEMA
from ingest.slim import slim_sql_draft, slim_sql_match, slim_sql_player


class ScriptedExplorer:
    def __init__(self, responses: list[object]) -> None:
        self.responses = list(responses)
        self.queries: list[str] = []

    def query(self, sql: str):
        self.queries.append(sql)
        if not self.responses:
            raise AssertionError("unexpected explorer query")
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def match_source(match_id: int, *, patch_name: str = "7.41") -> dict[str, object]:
    row: dict[str, object] = {name: None for name in MATCH_QUERY_COLUMNS}
    row.update(
        {
            "match_id": match_id,
            "start_time": 1609459200 + match_id,
            "patch": patch_name,
            "is_parsed": True,
            "radiant_team_id": None,
            "radiant_team_name": "cleared by mapper",
            "dire_team_id": None,
            "dire_team_name": "cleared by mapper",
        }
    )
    return row


def player_sources(match_id: int) -> list[dict[str, object]]:
    slots = list(range(5)) + list(range(128, 133))
    return [{"match_id": match_id, "player_slot": slot} for slot in slots]


def rate_limit_error(retry_after: str | None = None) -> HTTPError:
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return HTTPError("https://example.test", 429, "Too Many Requests", headers, None)


def match_row(match_id: int, *, gold: list[int] | None = None) -> dict[str, object]:
    row = {name: None for name in MATCH_SCHEMA.names}
    row.update(
        {
            "match_id": match_id,
            "start_time": 1609459200 + match_id,
            "patch": "7.41",
            "is_parsed": True,
            "radiant_gold_adv": gold,
            "radiant_xp_adv": gold,
        }
    )
    return row


def player_row(match_id: int, slot: int = 0) -> dict[str, object]:
    row = {name: None for name in PLAYER_SCHEMA.names}
    row.update(
        {"match_id": match_id, "player_slot": slot, "is_radiant": slot < 128}
    )
    return row


def draft_row(match_id: int, ord_value: int = 0) -> dict[str, object]:
    row = {name: None for name in DRAFT_SCHEMA.names}
    row.update(
        {
            "match_id": match_id,
            "is_pick": True,
            "hero_id": 1,
            "team": 0,
            "ord": ord_value,
        }
    )
    return row


def write_ndjson(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows)
    path.write_text(content, encoding="utf-8", newline="\n")


def write_existing_hot_month(data_dir: Path, month: str, match_id: int) -> None:
    write_ndjson(
        data_dir / "matches" / f"{month}.ndjson",
        [match_row(match_id, gold=[50, 75])],
    )
    write_ndjson(
        data_dir / "players" / f"{month}.ndjson", [player_row(match_id)]
    )
    write_ndjson(data_dir / "draft" / f"{month}.ndjson", [draft_row(match_id)])


class BackfillTests(unittest.TestCase):
    def test_keyset_pagination_advances_and_terminates(self) -> None:
        client = ScriptedExplorer(
            [
                [match_source(10), match_source(20)],
                player_sources(10) + player_sources(20),
                [{"match_id": 20, "is_pick": True, "hero_id": 1, "team": 0, "ord": 0}],
                [match_source(30)],
                player_sources(30),
                [],
                [],
            ]
        )

        rows = fetch_month_rows(client, "2021-01", initial_page_size=2)

        match_queries = [query for query in client.queries if "backfill:matches" in query]
        self.assertEqual(len(match_queries), 3)
        self.assertIn("m.match_id > 0", match_queries[0])
        self.assertIn("m.match_id > 20", match_queries[1])
        self.assertIn("m.match_id > 30", match_queries[2])
        self.assertEqual([row["match_id"] for row in rows.matches], [10, 20, 30])
        self.assertTrue(all(row["radiant_win"] is None for row in rows.matches))
        self.assertEqual(rows.null_team_id_matches, 3)
        self.assertEqual(rows.pages, 2)
        self.assertEqual(rows.zero_draft_match_ids, [10, 30])
        self.assertFalse(client.responses)

        player_query = build_player_query("2021-01", 0, 20)
        draft_query = build_draft_query("2021-01", 0, 20)
        self.assertIn("pm.match_id > 0 AND pm.match_id <= 20", player_query)
        self.assertIn("pb.match_id > 0 AND pb.match_id <= 20", draft_query)
        self.assertIn("pb.ord", draft_query)
        self.assertNotIn("LIMIT", player_query)
        self.assertNotIn("LIMIT", draft_query)

    def test_timeout_halves_window_and_retries_same_cursor(self) -> None:
        client = ScriptedExplorer(
            [
                ExplorerTimeout("mock timeout"),
                [match_source(10)],
                player_sources(10),
                [],
                [],
            ]
        )

        with redirect_stdout(io.StringIO()):
            rows = fetch_month_rows(client, "2021-01", initial_page_size=4)

        match_queries = [query for query in client.queries if "backfill:matches" in query]
        self.assertIn("m.match_id > 0", match_queries[0])
        self.assertIn("LIMIT 4", match_queries[0])
        self.assertIn("m.match_id > 0", match_queries[1])
        self.assertIn("LIMIT 2", match_queries[1])
        self.assertEqual(rows.pages, 1)
        self.assertGreaterEqual(EXPLORER_INTERVAL_SECONDS, 5.0)

    def test_explorer_client_spaces_calls_by_at_least_five_seconds(self) -> None:
        now = [0.0]
        sleeps: list[float] = []

        def sleeper(seconds: float) -> None:
            sleeps.append(seconds)
            now[0] += seconds

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        def opener(request, timeout):
            now[0] += 30.0
            return Response(b'{"rows": []}')

        client = ExplorerClient(
            opener=opener,
            sleeper=sleeper,
            clock=lambda: now[0],
        )
        client.query("SELECT 1")
        client.query("SELECT 2")

        self.assertEqual(sleeps, [EXPLORER_INTERVAL_SECONDS])
        self.assertGreaterEqual(sleeps[0], 5.0)

    def test_explorer_client_honors_retry_after_on_http_429(self) -> None:
        now = [0.0]
        sleeps: list[float] = []
        responses: list[object] = [rate_limit_error("7"), b'{"rows": []}']

        def sleeper(seconds: float) -> None:
            sleeps.append(seconds)
            now[0] += seconds

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                self.close()

        def opener(request, timeout):
            response = responses.pop(0)
            if isinstance(response, BaseException):
                raise response
            return Response(response)

        client = ExplorerClient(
            opener=opener, sleeper=sleeper, clock=lambda: now[0]
        )
        self.assertEqual(client.query("SELECT 1"), [])
        self.assertEqual(sleeps, [7.0])
        self.assertFalse(responses)

    def test_explorer_client_stops_after_five_rate_limit_retries(self) -> None:
        now = [0.0]
        sleeps: list[float] = []
        calls = [0]

        def sleeper(seconds: float) -> None:
            sleeps.append(seconds)
            now[0] += seconds

        def opener(request, timeout):
            calls[0] += 1
            raise rate_limit_error()

        client = ExplorerClient(
            opener=opener, sleeper=sleeper, clock=lambda: now[0]
        )
        with self.assertRaisesRegex(ExplorerRateLimitError, "five|5"):
            client.query("SELECT 1")

        self.assertEqual(calls[0], EXPLORER_RATE_LIMIT_RETRIES + 1)
        for expected in [1.1, 2.2, 4.4, 8.8, 17.6]:
            self.assertTrue(
                any(abs(actual - expected) < 1e-9 for actual in sleeps),
                f"missing exponential delay {expected} in {sleeps}",
            )

    def test_tail_short_player_count_halves_and_retries_same_cursor(self) -> None:
        client = ScriptedExplorer(
            [
                [match_source(10), match_source(20)],
                player_sources(10) + player_sources(20)[:2],
                [],
                [match_source(10)],
                player_sources(10),
                [],
                [match_source(20)],
                player_sources(20)[:2],
                [],
                [],
            ]
        )
        output = io.StringIO()
        with redirect_stdout(output):
            rows = fetch_month_rows(client, "2021-01", initial_page_size=2)

        match_queries = [
            query for query in client.queries if "backfill:matches" in query
        ]
        self.assertIn("m.match_id > 0", match_queries[0])
        self.assertIn("LIMIT 2", match_queries[0])
        self.assertIn("m.match_id > 0", match_queries[1])
        self.assertIn("LIMIT 1", match_queries[1])
        self.assertIn("SUSPECTED PLAYER TRUNCATION", output.getvalue())
        self.assertEqual(rows.zero_player_match_ids, [])
        self.assertEqual(rows.player_row_count_anomalies, {20: 2})
        self.assertEqual([row["match_id"] for row in rows.matches], [10, 20])

    def test_interior_short_player_count_is_recorded_as_anomaly(self) -> None:
        client = ScriptedExplorer(
            [
                [match_source(10), match_source(20)],
                player_sources(10)[:2] + player_sources(20),
                [],
                [],
            ]
        )
        output = io.StringIO()
        with redirect_stdout(output):
            rows = fetch_month_rows(client, "2021-01", initial_page_size=2)

        self.assertNotIn("SUSPECTED PLAYER TRUNCATION", output.getvalue())
        self.assertEqual(rows.zero_player_match_ids, [])
        self.assertEqual(rows.player_row_count_anomalies, {10: 2})
        self.assertEqual(len(rows.players), 12)

    def test_zero_player_rows_abort_month_and_name_match(self) -> None:
        client = ScriptedExplorer(
            [
                [match_source(10)],
                [],
                [],
            ]
        )
        with self.assertRaisesRegex(
            ZeroPlayerRowsError,
            r"month=2021-01 match_ids=\[10\]; aborting month",
        ):
            fetch_month_rows(client, "2021-01", initial_page_size=1)

    def test_first_match_page_must_cover_every_selected_sql_column(self) -> None:
        source = match_source(10)
        del source["duration"]
        client = ScriptedExplorer([[source]])
        with self.assertRaisesRegex(ValueError, "missing expected columns: duration"):
            fetch_month_rows(client, "2021-01", initial_page_size=2)

    def test_checkpoint_resume_skips_completed_months(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            data_dir = root / "data"
            checkpoint_path = root / "checkpoint.json"
            checkpoint_path.write_text(
                json.dumps({"version": 1, "completed_months": ["2021-01"]}),
                encoding="utf-8",
            )
            client = ScriptedExplorer([[]])

            with redirect_stdout(io.StringIO()):
                summary = run_backfill(
                    client,
                    data_dir=data_dir,
                    checkpoint_path=checkpoint_path,
                    run_date=date(2021, 3, 12),
                    start_month="2021-01",
                    initial_page_size=2,
                )

            self.assertEqual(summary.resumed_months, ["2021-01"])
            self.assertEqual(summary.completed_months, ["2021-02"])
            self.assertEqual(len(client.queries), 1)
            february_start = 1612137600
            self.assertIn(f"m.start_time >= {february_start}", client.queries[0])
            checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            self.assertEqual(
                checkpoint["completed_months"], ["2021-01", "2021-02"]
            )

    def test_upper_bound_uses_compaction_boundary(self) -> None:
        self.assertEqual(last_fully_closed_month(date(2026, 9, 3)), "2026-07")
        self.assertEqual(last_fully_closed_month(date(2026, 9, 12)), "2026-08")

    def test_run_can_be_bounded_to_one_month(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            client = ScriptedExplorer([[]])
            with redirect_stdout(io.StringIO()):
                summary = run_backfill(
                    client,
                    data_dir=root / "data",
                    checkpoint_path=root / "checkpoint.json",
                    run_date=date(2026, 9, 12),
                    only_month="2026-08",
                )
            self.assertEqual(summary.completed_months, ["2026-08"])
            self.assertEqual(len(client.queries), 1)

    def test_run_can_be_bounded_to_small_number_of_months(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            client = ScriptedExplorer([[]])
            with redirect_stdout(io.StringIO()):
                summary = run_backfill(
                    client,
                    data_dir=root / "data",
                    checkpoint_path=root / "checkpoint.json",
                    run_date=date(2021, 3, 12),
                    max_months=1,
                )
            self.assertEqual(summary.completed_months, ["2021-01"])
            self.assertEqual(len(client.queries), 1)

    def test_run_summary_derives_player_anomaly_counts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            client = ScriptedExplorer(
                [
                    [match_source(10), match_source(20)],
                    player_sources(10)[:2] + player_sources(20),
                    [],
                    [],
                ]
            )
            output = io.StringIO()
            with redirect_stdout(output):
                summary = run_backfill(
                    client,
                    data_dir=root / "data",
                    checkpoint_path=root / "checkpoint.json",
                    run_date=date(2021, 3, 12),
                    only_month="2021-01",
                    initial_page_size=2,
                )

            self.assertEqual(summary.zero_player_matches, 0)
            self.assertEqual(summary.player_row_count_anomalies, {10: 2})
            self.assertIn(
                "zero_player_matches=0 player_row_count_anomalies=1",
                output.getvalue(),
            )

    def test_write_time_dedup_keeps_one_match_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_dir = Path(temporary_directory) / "data"
            write_existing_hot_month(data_dir, "2021-01", 1)
            fetched = MonthRows(
                matches=[slim_sql_match(match_source(1)), slim_sql_match(match_source(2))],
                players=[
                    slim_sql_player({"match_id": 1, "player_slot": 0}),
                    slim_sql_player({"match_id": 2, "player_slot": 128}),
                ],
                draft=[
                    slim_sql_draft(
                        {"match_id": 1, "is_pick": True, "hero_id": 2, "team": 0, "ord": 0}
                    ),
                    slim_sql_draft(
                        {"match_id": 2, "is_pick": True, "hero_id": 3, "team": 1, "ord": 0}
                    ),
                ],
            )

            result = write_month(data_dir, "2021-01", fetched)

            table = pq.read_table(data_dir / "matches" / "2021-01.parquet")
            self.assertEqual(table.column("match_id").to_pylist(), [1, 2])
            self.assertEqual(result.duplicate_matches_skipped, 1)
            self.assertEqual(result.matches_written, 1)
            self.assertFalse((data_dir / "matches" / "2021-01.ndjson").exists())

    def test_rest_precedence_preserves_existing_gold_advantage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_dir = Path(temporary_directory) / "data"
            paths = {
                "matches": data_dir / "matches" / "2021-01.parquet",
                "players": data_dir / "players" / "2021-01.parquet",
                "draft": data_dir / "draft" / "2021-01.parquet",
            }
            for path in paths.values():
                path.parent.mkdir(parents=True, exist_ok=True)
            pq.write_table(
                pa.Table.from_pylist([match_row(1, gold=[100, 200])], schema=MATCH_SCHEMA),
                paths["matches"],
            )
            pq.write_table(
                pa.Table.from_pylist([player_row(1)], schema=PLAYER_SCHEMA),
                paths["players"],
            )
            pq.write_table(
                pa.Table.from_pylist([draft_row(1)], schema=DRAFT_SCHEMA),
                paths["draft"],
            )
            before = paths["matches"].read_bytes()
            fetched = MonthRows(matches=[slim_sql_match(match_source(1))])

            result = write_month(data_dir, "2021-01", fetched)

            self.assertFalse(result.wrote_files)
            self.assertEqual(paths["matches"].read_bytes(), before)
            table = pq.read_table(paths["matches"])
            self.assertEqual(table.column("radiant_gold_adv").to_pylist(), [[100, 200]])

    def test_new_rows_for_closed_month_append_to_all_late_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_dir = Path(temporary_directory) / "data"
            paths = {
                "matches": data_dir / "matches" / "2021-01.parquet",
                "players": data_dir / "players" / "2021-01.parquet",
                "draft": data_dir / "draft" / "2021-01.parquet",
            }
            for path in paths.values():
                path.parent.mkdir(parents=True, exist_ok=True)
            pq.write_table(
                pa.Table.from_pylist([match_row(1, gold=[100])], schema=MATCH_SCHEMA),
                paths["matches"],
            )
            pq.write_table(
                pa.Table.from_pylist([player_row(1)], schema=PLAYER_SCHEMA),
                paths["players"],
            )
            pq.write_table(
                pa.Table.from_pylist([draft_row(1)], schema=DRAFT_SCHEMA),
                paths["draft"],
            )
            parquet_before = {name: path.read_bytes() for name, path in paths.items()}
            fetched = MonthRows(
                matches=[match_row(1), match_row(2)],
                players=[player_row(1), player_row(2)],
                draft=[draft_row(1), draft_row(2)],
            )

            result = write_month(data_dir, "2021-01", fetched)
            duplicate_result = write_month(data_dir, "2021-01", fetched)

            self.assertEqual(result.write_target, "late")
            self.assertEqual(result.matches_written, 1)
            self.assertEqual(duplicate_result.matches_written, 0)
            self.assertEqual(
                [json.loads(line)["match_id"] for line in (data_dir / "matches" / "late.ndjson").read_text(encoding="utf-8").splitlines()],
                [2],
            )
            self.assertEqual(
                [json.loads(line)["match_id"] for line in (data_dir / "players" / "late.ndjson").read_text(encoding="utf-8").splitlines()],
                [2],
            )
            self.assertEqual(
                [json.loads(line)["match_id"] for line in (data_dir / "draft" / "late.ndjson").read_text(encoding="utf-8").splitlines()],
                [2],
            )
            for name, path in paths.items():
                self.assertEqual(path.read_bytes(), parquet_before[name])

    def _assert_interrupted_late_write_recovers(self, fail_on_call: int) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_dir = Path(temporary_directory) / "data"
            parquet_rows = {
                "matches": ([match_row(1, gold=[100])], MATCH_SCHEMA),
                "players": ([player_row(1)], PLAYER_SCHEMA),
                "draft": ([draft_row(1)], DRAFT_SCHEMA),
            }
            for name, (rows, schema) in parquet_rows.items():
                path = data_dir / name / "2021-01.parquet"
                path.parent.mkdir(parents=True, exist_ok=True)
                pq.write_table(pa.Table.from_pylist(rows, schema=schema), path)

            fetched = MonthRows(
                matches=[match_row(2)],
                players=[player_row(2, slot) for slot in range(10)],
                draft=[draft_row(2, 0), draft_row(2, 1)],
            )
            append_calls = [0]

            def interrupted_append(path, rows):
                append_calls[0] += 1
                if append_calls[0] == fail_on_call:
                    raise KeyboardInterrupt("simulated process termination")
                real_append_rows_atomically(path, rows)

            with patch(
                "ingest.backfill.append_rows_atomically",
                side_effect=interrupted_append,
            ):
                with self.assertRaises(KeyboardInterrupt):
                    write_month(data_dir, "2021-01", fetched)

            result = write_month(data_dir, "2021-01", fetched)

            late_rows = {
                name: [
                    json.loads(line)
                    for line in (data_dir / name / "late.ndjson")
                    .read_text(encoding="utf-8")
                    .splitlines()
                ]
                for name in ("matches", "players", "draft")
            }
            self.assertEqual(result.matches_written, 1)
            self.assertEqual(
                [row["match_id"] for row in late_rows["matches"]], [2]
            )
            self.assertEqual(len(late_rows["players"]), 10)
            self.assertEqual(
                sorted(row["player_slot"] for row in late_rows["players"]),
                list(range(10)),
            )
            self.assertEqual(len(late_rows["draft"]), 2)
            self.assertEqual(
                sorted(row["ord"] for row in late_rows["draft"]), [0, 1]
            )

    def test_late_write_recovers_after_draft_append_interruption(self) -> None:
        self._assert_interrupted_late_write_recovers(fail_on_call=2)

    def test_late_write_recovers_after_player_append_interruption(self) -> None:
        self._assert_interrupted_late_write_recovers(fail_on_call=3)

    def test_zero_match_month_creates_no_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_dir = Path(temporary_directory) / "data"
            result = write_month(data_dir, "2021-01", MonthRows())
            self.assertFalse(result.wrote_files)
            self.assertEqual(list(data_dir.rglob("*.parquet")), [])

    def test_dry_run_is_offline_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            data_dir = root / "data"
            checkpoint_path = root / "checkpoint.json"
            before = sorted(path.relative_to(root) for path in root.rglob("*"))

            with patch(
                "ingest.backfill.ExplorerClient",
                side_effect=AssertionError("dry-run instantiated live client"),
            ):
                output = io.StringIO()
                with redirect_stdout(output):
                    exit_code = main(
                        [
                            "--dry-run",
                            "--data-dir",
                            str(data_dir),
                            "--checkpoint",
                            str(checkpoint_path),
                        ]
                    )

            after = sorted(path.relative_to(root) for path in root.rglob("*"))
            self.assertEqual(exit_code, 0)
            self.assertEqual(after, before)
            self.assertIn("live_api_calls=0", output.getvalue())
            self.assertIn("filesystem_writes=0", output.getvalue())
            self.assertIn("mock_keyset_cursors=[0, 102, 103]", output.getvalue())
            self.assertIn("null_team_id_matches=3", output.getvalue())
            self.assertIn("zero_player_match_ids=[]", output.getvalue())
            self.assertIn(
                "mock_complete_player_page_match_ids=[101, 102]",
                output.getvalue(),
            )
            self.assertIn(
                "mock_deliberate_player_anomaly={103: 2}",
                output.getvalue(),
            )

    def test_no_arguments_refuses_live_execution(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as raised:
                main([])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("usage:", stderr.getvalue())

    def test_match_query_uses_month_keyset_and_limit(self) -> None:
        query = build_match_query("2021-01", 123, 456)
        self.assertIn("m.start_time >= 1609459200", query)
        self.assertIn("m.start_time < 1612137600", query)
        self.assertIn("m.match_id > 123", query)
        self.assertIn("ORDER BY m.match_id", query)
        self.assertIn("LIMIT 456", query)


if __name__ == "__main__":
    unittest.main()
