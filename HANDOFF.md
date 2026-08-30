# Dota 2 Pro Stats — Implementation Handoff (v0 + v1)

**Audience:** an autonomous coding agent (Codex).
**Scope:** v0 and v1 only. Do not implement anything under "Deferred."

---

## 1. What we're building

A zero-cost static website for **Dota 2 professional match data**: results, drafts, and
box scores. Data comes from the public OpenDota API, is slimmed and stored as Parquet in
this repo, and is rendered to static HTML by Astro at build time. No servers, no database,
no runtime API calls from the browser.

**v0** — ingest pipeline only. Scheduled GitHub Actions fetch new pro matches and reference
data and commit data files. No website.

**v1** — an Astro site reading those Parquet files at build time. Two page types: a home
feed of recent matches, and a match detail page. Deployed to Cloudflare Pages.

---

## 2. Verified facts (do not re-derive these)

Baseline facts measured against the live OpenDota database on 2026-08-25 unless otherwise
dated. Counts marked approximate grow over time:

| Fact | Value |
|---|---|
| Pro matches since 2021-01-01 | **~147,495 as of 2026-08-30 and growing** (147,224 on 2026-08-25) |
| Distinct leagues | 960 |
| Earliest `start_time` | 1609488182 (2021-01-01) |
| Latest `start_time` | 1787645902 (2026-08-25, live) |
| Average new pro matches | **~71/day** |

Daily pro match volume varies from 0 to ~190; the ~71/day figure is a long-run average
across 2,067 days including TI and major seasons. Observed: 2026-08-17, 2026-08-18,
2026-08-26, and 2026-08-27 had zero matches; 2026-08-29 had 189, of which 164 came from a
single league. A low-count run is not evidence of pipeline failure.

API base URL: `https://api.opendota.com/api`

**Quota budget (all free tiers):**

| Resource | Limit | Projected use |
|---|---|---|
| OpenDota API calls | 50,000/month | ~2,250/month (4.5%) |
| Cloudflare Pages builds | 500/month | 120/month |
| GitHub Actions minutes | unlimited (public repo) | ~250 min/month |
| Cloudflare bandwidth | unmetered (static) | — |

**Do not increase the cron frequency past every 6 hours.** Hourly would be 720 builds/month
and exceed the Cloudflare Pages free tier.

**API key:** not required at this volume. Start keyless. Only if you observe repeated HTTP
429s, add support for an `OPENDOTA_API_KEY` env var appended as `?api_key=`. Do not make
the key mandatory.

---

## 3. Hard rules

These are the constraints that make the project viable. Violating any one of them breaks it.

1. **Never store a raw `/matches/{id}` response.** A full response is 1–3 MB (per-minute
   arrays, chat logs, purchase logs, teamfight objects). At 71 matches/day that is ~150 MB/day
   into git. Slim to the exact field list in §5 at ingest time, before writing anything.
2. **Monthly shards are append-only.** Shard by the match's `start_time`, never its ingestion
   time. A month remains hot through the seventh day of the following month and is compacted
   on or after the eighth day. Once compacted, a closed month is never rewritten. If a match
   for an already-closed month appears, write it to `data/matches/late.ndjson`; readers must
   UNION the late-arrival data with the monthly shards.
3. **Do not filter matches out at ingest.** Store `league_tier` and let the site filter.
   Discarding rows is irreversible; filtering at render time is not.
4. **Never commit secrets.** API key, if ever added, lives in GitHub Actions secrets only.
5. **One bad match must not abort a run.** Record failures in `data/failed.ndjson` and
   continue. Retry them on the next run. After five failed attempts, move the record to
   `data/failed_permanent.ndjson` so it is no longer retried. A successful retry is removed
   from `data/failed.ndjson`.
6. **Respect rate limits.** Sleep ≥1.1s between REST calls. Treat the documented 60/minute
   ceiling as burst-sensitive, not as a guaranteed steady-state rate. On HTTP 429, honor
   `Retry-After` when present; otherwise retry the same request with exponential backoff from
   1.1s. Retry at most five times within the run. Those in-run 429 retries do not increment the
   match's failure-queue attempt count. If all five are exhausted, record one failure whose
   `last_error` identifies persistent rate-limiting. Sleep ≥5s between `/explorer` calls — that
   endpoint queries their production Postgres directly.

---

## 4. Storage design

All data lives in git. At the field list below, the full 2021→now dataset is roughly
**120–150 MB of Parquet**, which is comfortably inside GitHub's limits and clones fast enough
for Cloudflare builds.

A first real compaction measurement used the 299-match 2026-08 incremental shard:

| Table | NDJSON | Parquet | Compression |
|---|---:|---:|---:|
| matches | 308,092 bytes | 135,194 bytes | 2.3:1 |
| players | 1,884,111 bytes | 171,175 bytes | 11.0:1 |
| draft | 504,555 bytes | 11,690 bytes | 43.2:1 |
| **total** | **2,696,758 bytes** | **318,059 bytes** | **8.5:1** |

A linear extrapolation to 147,495 matches is 156.9 MB / 149.63 MiB, at the top of the
120–150 MB projection rather than comfortably inside it. This is only one 299-match file;
Parquet compresses better at larger row-group sizes, so real monthly shards of roughly 2,000
matches should make that extrapolation pessimistic.

The measured sample has both `radiant_gold_adv` and `radiant_xp_adv` populated for all 299
matches (11,098 list elements in each column), so its measured size includes those arrays.
Historical backfilled rows will leave them null, while every parsed incremental match will
continue adding their per-minute arrays at roughly 71 matches/day indefinitely.

Two formats, by lifecycle stage:

- **Hot month** — `data/matches/2026-08.ndjson`, appended to on every run. Newline-delimited
  JSON because appends produce clean git deltas. Shards are selected from `start_time`.
- **Grace period** — the previous month remains hot through the seventh day of the current
  month. On or after the eighth, compact it from `.ndjson` to `.parquet`, commit both the new
  file and deletion of the old one, and never touch the closed shard again.
- **Closed months** — `data/matches/2026-07.parquet`.
- **Late arrivals** — a match whose `start_time` belongs to an already-compacted month is
  appended to `data/matches/late.ndjson`; readers UNION it with the monthly shards.

If the repo ever exceeds ~500 MB, the escape hatch is to move `data/` to GitHub Release
assets. Do not build that now. Re-evaluate this threshold and escape hatch after the first
two real monthly Parquet shards exist; they will provide a trustworthy per-month figure that
the 299-match sample cannot.

```
repo/
  ingest/
    fetch.py          # incremental: new matches since cursor
    backfill.py       # one-time historical load, run locally, NOT in CI
    compact.py        # grace-period month-close ndjson -> parquet
    reference.py      # weekly refresh of the four reference datasets
    slim.py           # shared field-mapping logic
    schema.py         # pyarrow schemas, single source of truth
    .backfill-checkpoint.json  # local-only resumable backfill state, gitignored
  data/
    state.json        # {"last_match_id": int, "last_run_utc": str}
    failed.ndjson     # retry queue: one failure object per line
    failed_permanent.ndjson
    .run-summary.json # local/CI run counts, gitignored
    matches/          # YYYY-MM.ndjson (hot) | YYYY-MM.parquet (closed) | late.ndjson
    players/          # YYYY-MM.ndjson | .parquet   (10 rows per match)
    draft/            # YYYY-MM.ndjson | .parquet   (variable rows, including zero)
    reference/
      teams.parquet  players.parquet  leagues.parquet  heroes.parquet
  site/               # Astro
  .github/workflows/
    ingest.yml
    reference.yml
```

Each line in `data/failed.ndjson` and `data/failed_permanent.ndjson` is exactly:

```json
{"match_id": 123, "first_failed_utc": "ISO-8601 UTC", "attempts": 1, "last_error": "message"}
```

---

## 5. Field lists

Derived from the live OpenDota Postgres schema. **These are exhaustive — store exactly these
columns and no others.** Every field omitted here costs a full re-backfill to add later, so
the list is deliberately slightly generous.

### `data/matches/` — one row per match

```
match_id                bigint    PK
start_time              bigint    unix seconds
duration                int       seconds
leagueid                int
league_name             text      denormalized from leagues
league_tier             text      open-ended string or null; "excluded" observed
series_id               int
series_type             int       0=bo1, 1=bo3, 2=bo5
radiant_team_id         int
dire_team_id            int
radiant_team_name       text      name as of row write time; null when team_id is null
dire_team_name          text      name as of row write time; null when team_id is null
radiant_captain         bigint
dire_captain            bigint
radiant_win             bool
radiant_score           int
dire_score              int
first_blood_time        int
game_mode               int
lobby_type              int
patch                   text      normalized version string — REQUIRED for meta analysis
is_parsed               bool      derive as (version is not null)
tower_status_radiant    int
tower_status_dire       int
barracks_status_radiant int
barracks_status_dire    int
radiant_gold_adv        list<int> per-minute gold lead; null when unparsed
radiant_xp_adv          list<int> per-minute xp lead; null when unparsed
```

The advantage-array source distinction is path-specific. REST `/matches/{id}` returns
`radiant_gold_adv` and `radiant_xp_adv` for parsed matches; all 299 matches in the measured
2026-08 incremental sample populated both columns, with 11,098 elements in each. Only the SQL
Explorer backfill path cannot practically reconstruct them, so historical backfilled rows
leave them null.

The `league_tier` domain is open-ended. Do not hardcode an enum; the live API has returned
`"excluded"` in addition to the currently documented public tiers.

A 2026-08-30 SQL null sweep over 147,495 matches found `series_id` and `series_type` null on
209 rows (0.14%), and both captain fields null on 1,781 rows (1.21%). Seven rows (0.005%) are
null across `radiant_win`, both score fields, `first_blood_time`, `game_mode`, `lobby_type`,
and all four tower/barracks status fields. Hard rule 3 still applies: retain these matches,
and the site must render them without crashing.

**Team names.** No historical team name exists in any source. OpenDota's
`matches.radiant_team_name` and `matches.dire_team_name` are NULL for 100% of the measured
2021+ pro dataset (verified 147,493/147,493 at measurement time). REST `$.radiant_name` and
`$.radiant_team.name` both return the team's current name; the same applies to dire.

Consequently, `radiant_team_name` and `dire_team_name` hold the team's name as of when the
row was written. Incremental rows are near-accurate because they are written hours after the
match. Backfilled rows carry present-day names for matches years old. This is the ceiling of
what the data supports, not a defect to fix.

- `backfill.py` sources team names by joining `teams` on `team_id`.
- `team_id` is the durable identifier. All joins, URLs, and aggregation keys use `team_id`;
  never key on a name.
- The site must not imply names are historical. Do not caption a 2021 match as if that were
  the team's name at the time.
- `slim.py` keeps preferring `$.radiant_name` over `$.radiant_team.name` (and the dire
  equivalents) in case OpenDota corrects this later. That preference is harmless today.
- Of 147,495 matches measured on 2026-08-30, 5,038 (3.42%) have a NULL
  `radiant_team_id`, and 5,449 (3.69%) have a NULL `dire_team_id`. A separate join to the
  current `teams` table produced exactly the same null counts for `rt.name` and `dt.name`,
  establishing that every non-null team ID resolved to a team row. This join result says
  nothing about the historical `matches.radiant_team_name` / `matches.dire_team_name`
  columns described above. Null-ID matches retain a null corresponding name and must render
  without one.

A 2026-by-month SQL sweep on 2026-08-30 found no systematic recent rise in null team IDs;
instead, the August spike was entirely event-specific. August had 116/621 (18.68%) null
`radiant_team_id` and 111/621 (17.87%) null `dire_team_id`, and every one belonged to league
20134: 116/185 (62.70%) radiant and 111/185 (60.00%) dire. The other 436 August matches had
zero null team IDs. The 299-match incremental sample contains those same 116 and 111 nulls,
so its apparent 38.80%/37.12% rate is a sampling-composition effect. Nameless rendering is
therefore not the general recent case, but it is common within an affected event and must be
treated as normal presentation rather than an exceptional error.

The REST `/matches/{id}` response supplies `patch` as an integer index. `fetch.py` must GET
`/constants/patch` once per run, build an `{id: name}` lookup, and pass it to `slim_match`.
Both ingest paths must persist the same version-string format such as `"7.41"`: REST maps the
integer through the live lookup, while SQL reads the already-text `match_patch.patch` column.
If an index is absent from the live lookup, `slim_match` writes null and `fetch.py` records
the raw index in `.run-summary.json` under `unknown_patch_indices`; the raw integer is never
persisted in a match row and the run continues. `constants_patch.json` is an offline test
fixture only. This lookup is v0 ingest work; the v1 `dotaconstants` deferral applies only to
hero icons. `/constants/patch` grows as patches are released; never pin the lookup, because a
pinned copy would write null for every future patch.

Explicitly excluded: `chat`, `objectives`, `teamfights`, `cosmetics`, `draft_timings`,
`replay_salt`, `match_seq_num`, `cluster`, `engine`, `human_players`, `positive_votes`,
`negative_votes`. These are the bulk of the payload and are not rendered in v1.

### `data/players/` — ten rows per match

```
match_id bigint, account_id bigint, player_slot int, is_radiant bool (derive: player_slot < 128),
hero_id int, hero_variant int, kills int, deaths int, assists int,
last_hits int, denies int, gold_per_min int, xp_per_min int, net_worth int, level int,
hero_damage int, tower_damage bigint, hero_healing bigint,
stuns real, teamfight_participation real,
obs_placed int, sen_placed int, camps_stacked int, rune_pickups int,
lane int, lane_role int, is_roaming bool, leaver_status int,
item_0..item_5 int, backpack_0..backpack_3 int, item_neutral int
```

`player_matches` has 90 columns; the ~55 omitted ones are JSON and array blobs
(`times`, `gold_t`, `purchase_log`, `damage`, `ability_uses`, …). They are where the
megabytes live. Do not store them.

Fields including `stuns`, `teamfight_participation`, `lane_role`, and `is_roaming` are null
for unparsed matches. Handle nulls; do not drop the rows.

`backpack_3` is absent from REST player responses, so `fetch.py` always writes it as null.
It exists as a real `player_matches` SQL column, but all 4,350 rows in the bounded 2026-07
sweep were null. Retain the schema column, but do not assume the SQL backfill can populate it
without further historical evidence.

Apart from `backpack_3`, a bounded SQL null sweep found no null §5 player fields among 4,350
rows in 2026-07. Among 11,130 rows in 2026-06, exactly 60 rows (0.54%) were null for `stuns`,
`teamfight_participation`, `obs_placed`, `sen_placed`, `camps_stacked`, `rune_pickups`,
`lane`, `lane_role`, and `is_roaming`; all other §5 player fields had zero nulls.

### `data/draft/` — variable rows per match, including zero

```
match_id bigint, is_pick bool, hero_id int, team smallint (0=radiant, 1=dire), ord smallint
```

The live REST path maps the `/matches/{id}` response's `picks_bans` array. REST names its
ordering field `order`; normalize it to the schema's `ord`. The SQL backfill path reads the
`picks_bans` table and maps its existing `ord` column.

Drafts are variable-length and may be absent entirely; never assert exactly 24 rows. In the
2021+ SQL population measured on 2026-08-30, `game_mode=2` averaged between 23 and 24 rows
across 145,714 drafted matches, while `game_mode=22` averaged between 16 and 17 across 413.
Another 1,368 of 147,495 matches (0.93%) had no `picks_bans` rows. The 1,368 count was derived
as total eligible matches minus drafted matches because the direct anti-join timed out.

### `data/reference/` — refreshed weekly in v0

Reference ID widths intentionally match their PostgreSQL source tables: `teams.team_id` and
`leagues.leagueid` are `bigint` (int64). The same logical IDs in `matches` — `leagueid`,
`radiant_team_id`, and `dire_team_id` — are `integer` (int32). JSON numbers cannot confirm
those widths. The first `/teams` page had a maximum `team_id` of 10,232,231; the complete
page walk raised that maximum to 10,240,390, and `/leagues` had a maximum `leagueid` of
65,019. All are within signed int32. Keep the int64 reference schemas, but treat their width
as a PostgreSQL-derived assertion that REST neither confirms nor contradicts.

- `teams.parquet` — `team_id bigint, name, tag, logo_url` from `/teams`
- `players.parquet` — `account_id, name, country_code, fantasy_role, team_id, team_name, team_tag, is_pro` from REST `/proPlayers`
- `leagues.parquet` — `leagueid bigint, name, tier, banner` from `/leagues`
- `heroes.parquet` — `id, name, localized_name, primary_attr, attack_type, roles` from `/heroes`

The 2026-08-30 REST contract capture established:

- `/teams` is paginated at 1,000 objects. Pages 0–21 contained 1,000 objects each and page
  22 contained 504: 23 pages and 22,504 returned objects total. The page walk contained
  21,970 distinct `team_id` values because 534 rows were duplicates across pages. Deduplicate
  by `team_id` when constructing the reference table.
- The 2021+ pro match data contains 22,504 distinct non-null team IDs. Of those, 21,970
  appeared in that `/teams` page walk and 534 (2.37%) did not. This is a non-trivial reference
  coverage gap: `teams.parquet` cannot resolve every non-null team ID currently stored in the
  match data. No resolution has been selected yet.
- `/leagues.tier` returned `null`, `"amateur"`, `"excluded"`, `"premium"`, and
  `"professional"`. The domain is open-ended and must never be hardcoded as an enum.
- `/proPlayers.fantasy_role` is an integer code whose meaning the API does not supply.
- Of 5,327 `/proPlayers` objects, `is_pro` was null on 4,851 and `true` on all 476 non-null
  rows; `false` was never observed. It carries no discriminating information and must not be
  used as a predicate.
- Observed null counts were: `/teams` page-0 `logo_url` 96/1,000; `/leagues.tier`
  105/10,127 and `banner` 9,895/10,127; `/proPlayers.country_code`, `fantasy_role`, and
  `team_id` 58/5,327 each; `team_name` and `team_tag` 186/5,327 each; and `is_pro`
  4,851/5,327.

Hero **icons** are not in the API. Pinning `odota/dotaconstants` and recording its commit SHA
belongs to v1 only; do not do it in v0.

The existing `slim_team`, `slim_reference_player`, `slim_league`, and `slim_hero` helpers are
unvalidated. Step 6 must capture endpoint-specific reference fixtures before relying on them.

---

## 6. v0 — ingest pipeline

### `ingest/fetch.py`

```
read data/state.json -> last_match_id
read data/failed.ndjson -> retry queue
GET /constants/patch                             # once per run -> {id: name}
  if the lookup request fails: abort before fetching or writing matches or advancing state
GET /proMatches                                  # 100 newest, descending
collect ids > last_match_id
  if all 100 are new, page back with ?less_than_match_id= until overlap is found
combine genuinely new ids with retryable failed ids
for each id (ascending):
    GET /matches/{id}
    slim(response, patch_lookup) -> append rows to matches/, players/, draft/
    if patch index is unknown: persist null and add index to run summary
    select one shard month from match start_time and apply it to all three tables
    if the start_time month is already compacted, use the late-arrival path
    on success, remove the id from the retry queue
    on HTTP 429, retry in-run per hard rule 6 without incrementing failure attempts
    on failure, update failed.ndjson; after attempt 5 move it to failed_permanent.ndjson
    sleep 1.1s
write state.json (highest new match_id processed)
run compact.py for every eligible hot month
write data/.run-summary.json with run counts
```

Bootstrap: if `state.json` is absent, do not estimate a match ID from a timestamp. Page
`/proMatches` backward until a page contains a match with `start_time` older than `now - 7d`.
Set the initial cursor to the lowest `match_id` in that page, then process forward. Match IDs
are monotonic but not time-linear, so a date-to-ID estimate is guesswork. In the run summary,
`cursor_before` records this selected lowest ID. There is no page-count cap: after bootstrap,
if all 100 rows are newer than the saved cursor, continue paging until an overlap, a short or
empty page, or a pagination error is encountered.

`data/.run-summary.json` is gitignored and overwritten on every non-dry run. Its exact shape
is:

```json
{
  "run_utc": "ISO-8601 UTC",
  "matches_fetched": 0,
  "matches_failed": 0,
  "retries_attempted": 0,
  "retries_succeeded": 0,
  "retries_permanent": 0,
  "api_calls": 0,
  "unknown_patch_indices": [],
  "shards_written": [],
  "late_rows_written": 0,
  "cursor_before": 0,
  "cursor_after": 0,
  "duration_seconds": 0.0
}
```

`--dry-run` guarantees no filesystem or Git writes: no shards, state, failure queues,
compaction, run summary, commit, or push. It prints what it would do and exits. `--limit N`
limits the number of real matches processed so a five-match dry run is observable. The cursor
advances only to the highest contiguous new ID actually attempted in that limited batch, never
to the highest ID merely discovered.

`fetch.py` never performs Git operations. The workflow stages, commits, and pushes only when
tracked data changed. If there is nothing new, it exits without a commit, avoiding a needless
Cloudflare build. During bootstrap, limited runs consume the discovered backlog in ascending
order and advance the cursor only through matches actually attempted. A no-op run is expected
only after that bootstrap backlog has been fully consumed.

### `ingest/compact.py`

Compaction runs only after `fetch.py` has durably written its match rows, failure queues, and
cursor state. A rollover failure therefore leaves the completed fetch intact and fails the
run with the hot NDJSON available for a later retry. `fetch.py --dry-run` invokes compaction
only in dry-run mode, and a `/constants/patch` failure aborts before compaction as well as
before any fetch writes.

Eligibility is evaluated from an explicit reference date: a month remains hot through the
seventh day of the following month and becomes eligible on the eighth. All three datasets
for a month form one lifecycle unit. Compaction refuses a month if any Parquet destination
already exists or if the three NDJSON sources are incomplete. It loads each source with the
corresponding `schema.py` schema, writes all three Parquet files to temporary paths, reads
them back, and verifies exact row counts and schemas before publishing any of them. Only
after all three verified files have been published are the NDJSON sources removed. The
command reports the before/after row count for each table; `--dry-run` reports eligible
months and row counts without filesystem writes.

`test_real_august_shards_round_trip_every_row_and_column` asserts exact null-position and
null-count preservation for `stuns` and `teamfight_participation`, but the 299-match August
sample has zero nulls in both columns because every sampled match was parsed. That part of
the real-data assertion is currently vacuous; the synthetic tests in `test_compact.py` cover
the actual null round-trip case.

### `ingest/reference.py`

Refreshes all four reference Parquet files weekly. `/teams` must be paged forward until a
page contains fewer than 1,000 objects, then deduplicated by `team_id`; it required 23 pages
on 2026-08-30. With one call each to `/leagues`, `/heroes`, and `/proPlayers`, that refresh
required 26 REST calls rather than four. It uses the exact schemas defined in §5 and observes
the REST rate limit.

### `.github/workflows/ingest.yml`

- `on: schedule: cron: "0 */6 * * *"` plus `workflow_dispatch`
- `concurrency: group: ingest, cancel-in-progress: false` — overlapping runs would corrupt
  `state.json`
- `permissions: contents: write`
- Commit with the `github-actions[bot]` identity
- Run `fetch.py`, log `data/.run-summary.json`, then run `git add -A data` and use
  `git diff --cached --quiet` as the guard before committing and pushing. The ordinary
  `git diff --quiet` does not detect first-run untracked shards.

### `.github/workflows/reference.yml`

- Run weekly plus `workflow_dispatch`
- `permissions: contents: write`
- Commit with the `github-actions[bot]` identity only when reference data changed

### `ingest/backfill.py` — run locally, once, never in CI

Loads 2021-01-01 → present via `/explorer` SQL. Per-match REST calls are not an option here:
roughly 147,493 and growing would consume three months of quota.

Chunk by month (68 months), keyset-paginated within each chunk so a row cap or timeout
cannot silently truncate results:

```sql
SELECT m.match_id, m.start_time, m.duration, m.leagueid, l.name AS league_name,
       l.tier AS league_tier, m.series_id, m.series_type,
       m.radiant_team_id, m.dire_team_id,
       rt.name AS radiant_team_name, dt.name AS dire_team_name,
       m.radiant_captain, m.dire_captain, m.radiant_win, m.radiant_score, m.dire_score,
       m.first_blood_time, m.game_mode, m.lobby_type, mp.patch,
       m.version IS NOT NULL AS is_parsed,
       m.tower_status_radiant, m.tower_status_dire,
       m.barracks_status_radiant, m.barracks_status_dire
FROM matches m
LEFT JOIN leagues l ON l.leagueid = m.leagueid
LEFT JOIN match_patch mp ON mp.match_id = m.match_id
LEFT JOIN teams rt ON rt.team_id = m.radiant_team_id
LEFT JOIN teams dt ON dt.team_id = m.dire_team_id
WHERE m.leagueid > 0
  AND m.start_time >= :start AND m.start_time < :end
  AND m.match_id > :cursor
ORDER BY m.match_id
LIMIT 2000
```

Parallel queries against `player_matches` and `picks_bans` for the same match_id window.
Expect roughly 400–600 explorer calls total.

Requirements: write each completed historical month directly to `.parquet`; make the script
resumable from the gitignored `ingest/.backfill-checkpoint.json`; on timeout, halve the window
and retry. A crash at month 50 must not cost the first 49. Source team names from the `teams`
joins shown above. If a team ID is null, write the corresponding team name as null, flag the
row, and continue.

`radiant_gold_adv` / `radiant_xp_adv` are not practical to backfill via explorer. Leave them
null for historical rows and populate them going forward. The match page must render without
the gold graph.

The script must provide a `--dry-run` that validates query construction and keyset pagination
against mocked responses without calling the live API or writing data. Do not run the live
backfill without explicit user approval.

### Open questions

- **Backfill/incremental overlap:** Backfill will re-cover months that incremental ingest
  already wrote, creating two sources for the same `match_id`. Deduplication and precedence
  rules are undecided. Resolve before step 9.

### v0 acceptance criteria

- [ ] Two consecutive scheduled runs complete, the second adding only genuinely new matches
- [ ] `state.json` advances; no duplicate `match_id` in any shard
- [ ] Date-driven compaction on or after the eighth produces a `.parquet` and removes the
      corresponding `.ndjson`
- [ ] A deliberately corrupted match id lands in `failed.ndjson` without failing the run
- [ ] **Step 4:** a match with a null team ID stores the corresponding team name as null and
      completes without error
- [ ] A run with no new matches produces no commit
- [ ] Backfill `--dry-run` validates query construction and keyset pagination against mocked
      responses without live API calls or data writes
- [ ] **Step 8:** backfill joins team names through `teams.team_id`; rows with a null team ID
      retain a null name, are flagged, and do not abort the run
- [ ] **Separate step 7, explicit approval required:** backfill completes for at least one
      historical month and matches the count from an independent `SELECT count(*)` for that
      window

---

## 7. v1 — the site

**Stack:** Astro (static output), DuckDB via `duckdb-node` to read Parquet at build time,
Observable Plot for charts, plain CSS. No React, no Tailwind, no UI framework.

**Routes:**

- `/` — most recent 100 matches. Team names, score, duration, league, relative time.
  Default the view to `league_tier IN ('premium','professional')`; the tier filter is why
  we stored it.
- `/matches/[id]` — draft order (picks and bans, both teams, in `ord` sequence), both boxscores
  (hero, K/D/A, LH/DN, GPM/XPM, net worth, items), and the gold-advantage graph when
  `radiant_gold_adv` is non-null. If the match has no draft rows, render a clean
  draft-unavailable state just as an unparsed match renders without the gold graph.

**Build scope — this is a hard constraint.** Cloudflare caps builds at 20 minutes. Do not
pre-render all roughly 147,495-and-growing match pages. Pre-render **only matches from the
last 90 days** (~6,400 pages). Older matches resolve through a catch-all route that reads a small
per-month JSON index client-side.

**Deploy:** Cloudflare Pages, connected to the repo, building on push to `main`. The ingest
job's commits trigger builds automatically.

### v1 acceptance criteria

- [ ] `npm run build` completes in under 10 minutes locally
- [ ] Home feed renders with correct team names and results
- [ ] A match page renders the full draft when present, a clean unavailable state when absent,
      and both boxscores
- [ ] A parsed match shows the gold graph; an unparsed one renders cleanly without it
- [ ] A match older than 90 days is still reachable
- [ ] Deployed and publicly accessible

---

## 8. Deferred — do not build

v2 full historical backfill in CI · v3 team/player/league pages · v4 hero meta dashboard ·
DuckDB-WASM in the browser · live match ticker · search · user accounts · any paid service.

If a v0/v1 decision would foreclose one of these, note it in the PR description rather than
building ahead.

---

## 9. Setup (step 0)

The target repository is the existing public `lewfi/dotainfo` repository. Repository creation
and cloning are complete.

1. Scaffold the structure in §4.
2. Confirm Actions is enabled and workflow write permissions are on. The repository owner
   confirms public visibility and Actions write permissions externally.
