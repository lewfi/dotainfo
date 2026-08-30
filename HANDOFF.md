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

Measured against the live OpenDota database on 2026-08-25:

| Fact | Value |
|---|---|
| Pro matches since 2021-01-01 | **147,224** |
| Distinct leagues | 960 |
| Earliest `start_time` | 1609488182 (2021-01-01) |
| Latest `start_time` | 1787645902 (2026-08-25, live) |
| Average new pro matches | **~71/day** |

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
6. **Respect rate limits.** Sleep ≥1.1s between REST calls (60/min ceiling). Sleep ≥5s
   between `/explorer` calls — that endpoint queries their production Postgres directly.

---

## 4. Storage design

All data lives in git. At the field list below, the full 2021→now dataset is roughly
**120–150 MB of Parquet**, which is comfortably inside GitHub's limits and clones fast enough
for Cloudflare builds.

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
assets. Do not build that now.

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
    draft/            # YYYY-MM.ndjson | .parquet   (~24 rows per match)
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
league_tier             text      premium | professional | amateur | null
series_id               int
series_type             int       0=bo1, 1=bo3, 2=bo5
radiant_team_id         int
dire_team_id            int
radiant_team_name       text      name AT TIME OF MATCH — do not drop, teams rename
dire_team_name          text
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

The REST `/matches/{id}` response supplies `patch` as an integer index. Before persistence,
map that index through `/constants/patch` to the version string (for example, `"7.35"`). The
SQL backfill's `match_patch.patch` column already supplies the version-string format. The
fixture-backed patch lookup is v0 ingest work; the v1 `dotaconstants` deferral applies only
to hero icons.

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

### `data/draft/` — ~24 rows per match

```
match_id bigint, is_pick bool, hero_id int, team smallint (0=radiant, 1=dire), ord smallint
```

The live REST path maps the `/matches/{id}` response's `picks_bans` array. Verify whether
its ordering field is named `order` during the step-3 `--limit 5` live dry run, then normalize
it to `ord`. The SQL backfill path reads the `picks_bans` table and maps its `ord` column.

### `data/reference/` — refreshed weekly in v0

Reference ID widths intentionally match their source tables: `teams.team_id` and
`leagues.leagueid` are `bigint` (int64). The same logical IDs in `matches` — `leagueid`,
`radiant_team_id`, and `dire_team_id` — are `integer` (int32). This width mismatch is real
and intentional.

- `teams.parquet` — `team_id bigint, name, tag, logo_url` from `/teams`
- `players.parquet` — `account_id, name, country_code, fantasy_role, team_id, team_name, team_tag, is_pro` from `notable_players`
- `leagues.parquet` — `leagueid bigint, name, tier, banner` from `/leagues`
- `heroes.parquet` — `id, name, localized_name, primary_attr, attack_type, roles` from `/heroes`

Hero **icons** are not in the API. Pinning `odota/dotaconstants` and recording its commit SHA
belongs to v1 only; do not do it in v0.

---

## 6. v0 — ingest pipeline

### `ingest/fetch.py`

```
read data/state.json -> last_match_id
read data/failed.ndjson -> retry queue
GET /proMatches                                  # 100 newest, descending
collect ids > last_match_id
  if all 100 are new, page back with ?less_than_match_id= until overlap is found
combine genuinely new ids with retryable failed ids
for each id (ascending):
    GET /matches/{id}
    slim -> append rows to matches/, players/, draft/ shard selected by start_time
    if the start_time month is already compacted, use the late-arrival path
    on success, remove the id from the retry queue
    on failure, update failed.ndjson; after attempt 5 move it to failed_permanent.ndjson
    sleep 1.1s
if a previous month is past its seven-day grace period: run compact.py for that month
write state.json (highest new match_id processed)
write data/.run-summary.json with run counts
```

Bootstrap: if `state.json` is absent, seed `last_match_id` from 7 days ago so the first
run is small and observable.

`--dry-run` guarantees no filesystem or Git writes: no shards, state, failure queues,
compaction, run summary, commit, or push. It prints what it would do and exits. `--limit N`
limits the number of real matches processed so a five-match dry run is observable.

`fetch.py` never performs Git operations. The workflow stages, commits, and pushes only when
tracked data changed. If there is nothing new, it exits without a commit, avoiding a needless
Cloudflare build.

### `ingest/reference.py`

Refreshes all four reference Parquet files weekly using four REST API calls. It uses the same
exact schemas defined in §5 and observes the REST rate limit.

### `.github/workflows/ingest.yml`

- `on: schedule: cron: "0 */6 * * *"` plus `workflow_dispatch`
- `concurrency: group: ingest, cancel-in-progress: false` — overlapping runs would corrupt
  `state.json`
- `permissions: contents: write`
- Commit with the `github-actions[bot]` identity
- Run `fetch.py`, log `data/.run-summary.json`, then use a `git diff --quiet` guard before
  committing and pushing tracked data

### `.github/workflows/reference.yml`

- Run weekly plus `workflow_dispatch`
- `permissions: contents: write`
- Commit with the `github-actions[bot]` identity only when reference data changed

### `ingest/backfill.py` — run locally, once, never in CI

Loads 2021-01-01 → present via `/explorer` SQL. Per-match REST calls are not an option here:
147,224 of them would consume three months of quota.

Chunk by month (68 months), keyset-paginated within each chunk so a row cap or timeout
cannot silently truncate results:

```sql
SELECT m.match_id, m.start_time, m.duration, m.leagueid, l.name AS league_name,
       l.tier AS league_tier, m.series_id, m.series_type,
       m.radiant_team_id, m.dire_team_id, m.radiant_team_name, m.dire_team_name,
       m.radiant_captain, m.dire_captain, m.radiant_win, m.radiant_score, m.dire_score,
       m.first_blood_time, m.game_mode, m.lobby_type, mp.patch,
       m.version IS NOT NULL AS is_parsed,
       m.tower_status_radiant, m.tower_status_dire,
       m.barracks_status_radiant, m.barracks_status_dire
FROM matches m
LEFT JOIN leagues l ON l.leagueid = m.leagueid
LEFT JOIN match_patch mp ON mp.match_id = m.match_id
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
and retry. A crash at month 50 must not cost the first 49.

`radiant_gold_adv` / `radiant_xp_adv` are not practical to backfill via explorer. Leave them
null for historical rows and populate them going forward. The match page must render without
the gold graph.

The script must provide a `--dry-run` that validates query construction and keyset pagination
against mocked responses without calling the live API or writing data. Do not run the live
backfill without explicit user approval.

### v0 acceptance criteria

- [ ] Two consecutive scheduled runs complete, the second adding only genuinely new matches
- [ ] `state.json` advances; no duplicate `match_id` in any shard
- [ ] Date-driven compaction on or after the eighth produces a `.parquet` and removes the
      corresponding `.ndjson`
- [ ] A deliberately corrupted match id lands in `failed.ndjson` without failing the run
- [ ] A run with no new matches produces no commit
- [ ] Backfill `--dry-run` validates query construction and keyset pagination against mocked
      responses without live API calls or data writes
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
  `radiant_gold_adv` is non-null.

**Build scope — this is a hard constraint.** Cloudflare caps builds at 20 minutes. Do not
pre-render all 147,224 match pages. Pre-render **only matches from the last 90 days**
(~6,400 pages). Older matches resolve through a catch-all route that reads a small
per-month JSON index client-side.

**Deploy:** Cloudflare Pages, connected to the repo, building on push to `main`. The ingest
job's commits trigger builds automatically.

### v1 acceptance criteria

- [ ] `npm run build` completes in under 10 minutes locally
- [ ] Home feed renders with correct team names and results
- [ ] A match page renders full draft and both boxscores
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
