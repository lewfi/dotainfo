from __future__ import annotations

import copy
import io
import json
import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

from ingest import fetch


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "match_parsed.json"


class FakeApiClient:
    def __init__(self, pro_matches, match_results, patch_response=None):
        self.pro_matches = pro_matches
        self.match_results = match_results
        self.patch_response = patch_response or [{"id": 60, "name": "7.41"}]
        self.calls = 0

    def get_json(self, path, params=None):
        self.calls += 1
        if path == "/constants/patch":
            return copy.deepcopy(self.patch_response)
        if path == "/proMatches":
            return copy.deepcopy(self.pro_matches)
        if path.startswith("/matches/"):
            match_id = int(path.rsplit("/", 1)[1])
            result = self.match_results[match_id]
            if isinstance(result, Exception):
                raise result
            return copy.deepcopy(result)
        raise AssertionError(f"unexpected API path: {path}")


class FetchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "data"
        self.root.mkdir()
        self.paths = {
            "DATA_DIR": self.root,
            "STATE_PATH": self.root / "state.json",
            "FAILED_PATH": self.root / "failed.ndjson",
            "FAILED_PERMANENT_PATH": self.root / "failed_permanent.ndjson",
            "RUN_SUMMARY_PATH": self.root / ".run-summary.json",
        }
        self.path_patch = patch.multiple(fetch, **self.paths)
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        self.temporary.cleanup()

    def payload(self, match_id, start_time=1788065955, patch_index=60):
        payload = copy.deepcopy(self.fixture)
        payload["match_id"] = match_id
        payload["start_time"] = start_time
        payload["patch"] = patch_index
        return payload

    @staticmethod
    def pro_row(match_id, start_time=1788065955):
        return {"match_id": match_id, "start_time": start_time}

    def write_state(self, match_id):
        self.paths["STATE_PATH"].write_text(
            json.dumps({"last_match_id": match_id, "last_run_utc": "test"}) + "\n",
            encoding="utf-8",
        )

    def execute(self, client, *, dry_run=False, limit=None):
        args = Namespace(
            dry_run=dry_run,
            limit=limit,
        )
        output = io.StringIO()
        with patch.object(fetch, "ApiClient", return_value=client), redirect_stdout(output):
            summary = fetch.run(args)
        return summary, output.getvalue()

    def snapshot(self):
        return {
            path.relative_to(self.root).as_posix(): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }

    def test_dry_run_writes_no_files(self):
        self.write_state(100)
        pro_matches = [
            self.pro_row(103),
            self.pro_row(102),
            self.pro_row(101),
            self.pro_row(100),
        ]
        client = FakeApiClient(
            pro_matches,
            {101: self.payload(101), 102: self.payload(102)},
        )
        before = self.snapshot()

        with patch.object(fetch, "compact_eligible_months") as compact:
            summary, output = self.execute(client, dry_run=True, limit=2)

        self.assertEqual(before, self.snapshot())
        self.assertEqual(2, summary.matches_fetched)
        self.assertIn("DRY RUN: zero filesystem writes performed", output)
        compact.assert_called_once()
        self.assertTrue(compact.call_args.kwargs["dry_run"])

    def test_patch_lookup_failure_skips_compaction(self):
        class ConstantsFailureClient(FakeApiClient):
            def get_json(self, path, params=None):
                if path == "/constants/patch":
                    raise RuntimeError("constants unavailable")
                return super().get_json(path, params)

        client = ConstantsFailureClient([], {})

        with (
            patch.object(fetch, "compact_eligible_months") as compact,
            self.assertRaisesRegex(RuntimeError, "constants unavailable"),
        ):
            self.execute(client, limit=1)

        compact.assert_not_called()
        self.assertEqual({}, self.snapshot())

    def test_compaction_failure_happens_after_fetch_data_and_state_are_written(self):
        self.write_state(100)
        client = FakeApiClient(
            [self.pro_row(101), self.pro_row(100)],
            {101: self.payload(101)},
        )

        with (
            patch.object(
                fetch,
                "compact_eligible_months",
                side_effect=RuntimeError("rollover failed"),
            ),
            self.assertRaisesRegex(RuntimeError, "rollover failed"),
        ):
            self.execute(client, limit=1)

        state = json.loads(self.paths["STATE_PATH"].read_text(encoding="utf-8"))
        self.assertEqual(101, state["last_match_id"])
        matches_path = self.root / "matches" / "2026-08.ndjson"
        self.assertTrue(matches_path.exists())
        self.assertEqual(
            [101],
            [
                json.loads(line)["match_id"]
                for line in matches_path.read_text(encoding="utf-8").splitlines()
            ],
        )

    def test_limit_advances_cursor_only_through_selected_ids(self):
        self.write_state(100)
        pro_matches = [self.pro_row(match_id) for match_id in [104, 103, 102, 101, 100]]
        client = FakeApiClient(
            pro_matches,
            {101: self.payload(101), 102: self.payload(102)},
        )

        summary, _ = self.execute(client, limit=2)

        state = json.loads(self.paths["STATE_PATH"].read_text(encoding="utf-8"))
        self.assertEqual(104, max(row["match_id"] for row in pro_matches))
        self.assertEqual(102, summary.cursor_after)
        self.assertEqual(102, state["last_match_id"])

    def test_closed_month_routes_all_rows_to_late_ndjson(self):
        self.write_state(100)
        matches_dir = self.root / "matches"
        matches_dir.mkdir()
        pq.write_table(
            pa.table({"match_id": pa.array([1], type=pa.int64())}),
            matches_dir / "2021-01.parquet",
        )
        client = FakeApiClient(
            [self.pro_row(101, 1609459200), self.pro_row(100, 1609459100)],
            {101: self.payload(101, start_time=1609459200)},
        )

        summary, _ = self.execute(client, limit=1)

        self.assertFalse((matches_dir / "2021-01.ndjson").exists())
        for dataset in ("matches", "players", "draft"):
            self.assertTrue((self.root / dataset / "late.ndjson").exists())
        self.assertEqual(35, summary.late_rows_written)

    def test_failure_queue_attempts_and_successful_retry_transitions(self):
        self.write_state(100)
        server_error = HTTPError("test", 500, "server error", {}, None)
        first_client = FakeApiClient(
            [self.pro_row(101), self.pro_row(100)],
            {101: server_error},
        )
        self.execute(first_client, limit=1)

        for expected_attempts in range(1, 5):
            failures = fetch.read_failure_queue(self.paths["FAILED_PATH"])
            self.assertEqual(expected_attempts, failures[101]["attempts"])
            self.assertNotIn(
                101, fetch.read_failure_queue(self.paths["FAILED_PERMANENT_PATH"])
            )
            if expected_attempts < 4:
                client = FakeApiClient([self.pro_row(101)], {101: server_error})
                self.execute(client, limit=1)

        fifth_client = FakeApiClient([self.pro_row(101)], {101: server_error})
        self.execute(fifth_client, limit=1)
        self.assertNotIn(101, fetch.read_failure_queue(self.paths["FAILED_PATH"]))
        permanent = fetch.read_failure_queue(self.paths["FAILED_PERMANENT_PATH"])
        self.assertEqual(5, permanent[101]["attempts"])

        retry_record = {
            "match_id": 102,
            "first_failed_utc": "test",
            "attempts": 2,
            "last_error": "test",
        }
        self.paths["FAILED_PATH"].write_text(
            fetch.json_line(retry_record) + "\n", encoding="utf-8"
        )
        success_client = FakeApiClient(
            [self.pro_row(101)],
            {102: self.payload(102)},
        )
        summary, _ = self.execute(success_client, limit=1)
        self.assertEqual(1, summary.retries_succeeded)
        self.assertNotIn(102, fetch.read_failure_queue(self.paths["FAILED_PATH"]))
        server_error.close()

    def test_transient_429_retries_in_run_without_queue_attempt(self):
        rate_limited = HTTPError(
            "test",
            429,
            "too many requests",
            {"Retry-After": "3"},
            None,
        )
        responses = [rate_limited, io.BytesIO(b'{"ok": true}')]

        def mocked_urlopen(request, timeout):
            result = responses.pop(0)
            if isinstance(result, Exception):
                raise result
            return result

        sleeps = []
        with (
            patch.object(fetch, "urlopen", side_effect=mocked_urlopen),
            patch.object(fetch.time, "sleep", side_effect=sleeps.append),
            patch.dict(fetch.os.environ, {}, clear=True),
        ):
            client = fetch.ApiClient()
            response = client.get_json("/test")

        self.assertEqual({"ok": True}, response)
        self.assertEqual(2, client.calls)
        self.assertIn(3.0, sleeps)
        self.assertFalse(self.paths["FAILED_PATH"].exists())
        rate_limited.close()

    def test_unknown_patch_is_reported_and_persisted_as_null(self):
        self.write_state(100)
        client = FakeApiClient(
            [self.pro_row(101), self.pro_row(100)],
            {101: self.payload(101, patch_index=999)},
        )

        summary, _ = self.execute(client, limit=1)

        self.assertEqual([999], summary.unknown_patch_indices)
        row = json.loads(
            (self.root / "matches" / "2026-08.ndjson")
            .read_text(encoding="utf-8")
            .splitlines()[0]
        )
        self.assertIsNone(row["patch"])


if __name__ == "__main__":
    unittest.main()
