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
10. **Static-site scaffold.** Add the pinned Node/Astro toolchain, static-output configuration,
    minimal page shell, and package scripts. Approval gate: a clean install and production
    build succeed from scratch and emit a runnable static index without reading live APIs.
11. **Local data catalog and query layer.** Add DuckDB-backed readers that UNION Parquet, hot
    NDJSON, and late NDJSON, use explicit UTC cutoffs, prune shards/columns, and expose tested
    home/detail queries. Approval gate: an offline audit reproduces the committed match,
    30/90/180-day, tier, and duplicate counts in this appendix.
    Completion gate: reproduce 146,875 matches across 67 backfilled months in 75,620,523
    bytes; tier totals of 110,786 professional, 12,718 premium, and 23,371 excluded; 1,367
    matches with no draft rows; and exactly one match with a player row count other than ten.
    Successful query execution alone is insufficient.
12. **Reference and presentation model.** Resolve teams, leagues, players, and heroes with
    denormalized-name fallbacks and explicit missing-logo/name states; define a shared match
    summary model used by both page types; pin the v1 hero-icon source if approved. Approval
    gate: tests cover complete joins, the 655 empty/whitespace name appearances, the 7,058
    matches with a null team ID, and all 127 draft heroes.
13. **Home feed and tier control.** Render the newest 100 matches with results, duration,
    league, relative time, and a visible tier filter. Approval gate: ordering and tier counts
    match the offline query, all-tier and premium-plus-professional views are both testable,
    and the chosen default is explicitly approved.
14. **Recent full match pages and dynamic pre-render budget.** Build the full page and
    pre-render it only for the measured trailing 90-day set, including boxscores, draft, and
    advantage graph when available. Approval gate: normal, no-draft, null-team,
    empty/whitespace-name, and null-advantage fixtures render; generated route count equals
    the data-layer count for an injected build clock.
15. **Historical summary artifacts and catch-all route.** Generate one match-only JSON payload
    per committed month (68 currently) plus the range manifest, then use them to render the
    client-side summary for older IDs. Approval gate: generated payloads exclude both
    advantage arrays and total
    88,248,288 raw / 8,644,307 gzipped bytes for the current fixture; known old IDs—including
    7485890286—render correct teams, result, score, league, duration, patch, and date; unknown
    and range-gap IDs produce a clean not-found state; overlapping future ranges check every
    candidate. Step 14 and step 15 remain separate because the former owns pre-rendered
    full-detail pages and a moving 90-day route set, while the latter owns persistent monthly
    summary artifacts and client-side routing. Their shared summary UI contract is established
    in step 12 so the split does not duplicate presentation logic.
16. **Accessibility, responsive styling, and build profiling.** Finish the plain-CSS visual
    system, keyboard/focus behavior, metadata, error states, and reproducible timing output.
    Approval gate: accessibility checks pass, representative narrow/wide renders are reviewed,
    and a clean local production build completes under ten minutes.
17. **Cloudflare deployment.** Add only the deployment configuration needed for the approved
    static build and connect the production project. Approval gate: the public deployment is
    reachable, the home and old/new match routes work, and the measured build remains below
    Cloudflare's 20-minute cap.

## Never

- Store a raw /matches/{id} response anywhere under data/
- Rewrite a closed monthly shard
- Filter matches out at ingest
- Run backfill.py against the live API without explicit approval
- Commit when there is nothing new to commit
- Set cron more frequently than every 6 hours
- Sleep <1.1s between REST calls, <5s between /explorer calls

## Always

- Shard by match start\_time, never by ingestion month
- Committed test fixtures under tests/fixtures/ are exempt from the
  raw-response rule and are required. They are the offline contract
  against the API's actual response shape.
- Ask when the spec is ambiguous; do not pick a direction and build on it
- Verify by running, not by reasoning. Show the output.
- Before reporting `git rev-parse origin/main`, run `git fetch origin` first; treat unequal
  HEAD and origin/main as a failed step to report, not a status line to paste.
- Update HANDOFF.md when a decision changes the spec, in the same commit
- Start each step assuming no prior conversation context
