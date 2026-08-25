# dotainfo

Spec: HANDOFF.md in repo root. It is the source of truth for scope,
field lists, storage format, and cadence.

## Canonical implementation order

Refer to steps by these numbers only. Do not renumber.

1. Scaffold §4 directory structure and initial data files
2. ingest/schema.py (pyarrow schemas)
3. ingest/slim.py (API response -> row mapping, §5)
4. ingest/fetch.py with --dry-run and --limit N
5. ingest/compact.py + rollover integration + tests/test\_compact.py
6. ingest/reference.py + weekly refresh workflow
7. .github/workflows/ingest.yml
8. ingest/backfill.py + checkpoint format (write it, do not run it)
9. Live backfill run — requires explicit approval, not part of v0

## Never

- Store a raw /matches/{id} response
- Rewrite a closed monthly shard
- Filter matches out at ingest
- Run backfill.py against the live API without explicit approval
- Commit when there is nothing new to commit
- Set cron more frequently than every 6 hours
- Sleep <1.1s between REST calls, <5s between /explorer calls

## Always

- Shard by match start\_time, never by ingestion month
- Ask when the spec is ambiguous; do not pick a direction and build on it
- Verify by running, not by reasoning. Show the output.
- Update HANDOFF.md when a decision changes the spec, in the same commit
- Start each step assuming no prior conversation context
