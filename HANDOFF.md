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
| Backfill-query matches on 2026-08-30 | **147,524** with `leagueid > 0` and `start_time >= 1609459200` |
| Distinct leagues | 960 |
| Earliest `start_time` | 1609488182 (2021-01-01) |
| Latest `start_time` | 1787645902 (2026-08-25, live) |
| Average new pro matches | **~71/day** |

The 147,524 observation uses the exact league and time predicates queried by backfill. It is
a separate same-day population from the approximate 147,495 figure above; the predicates are
not interchangeable.

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

The first real month-scale historical shard was produced by the approved step 9 backfill of
2023-12 on 2026-08-30. Its 2,025 matches occupy 1,056,583 bytes across matches (93,168),
players (897,785), and draft (65,630), or 521.77 bytes per match. Monthly volume ranges from
435 to 2,693 matches, and Parquet compresses better at larger row-group sizes, so that rate is
a central estimate from one mid-sized month rather than a per-match constant across months.
A linear projection from it across the measured 147,524-match backfill population is
76,973,506 bytes / 73.41 MiB.

The comparison relevant to the ~500 MB escape hatch is source-specific. The 299-match REST
sample extrapolated to 156.9 MB / 149.63 MiB with `radiant_gold_adv` and `radiant_xp_adv`
populated, while the 2,025-match SQL sample extrapolates to 73.41 MiB with both arrays null.
The difference between those projections is dominated by the advantage arrays, with shard
size and row-group compression adding further variation. Repository growth is therefore
primarily a question of how many months are REST-populated rather than backfilled. The SQL
estimate is informative for the roughly 65 historical backfill months that make up most of
the dataset, but it understates future incremental months and neither sample alone confirms
or refutes the original 120–150 MB projection for the mixed population.

The next approved step 9 batch covered the full 2021 calendar year and provides a better
historical estimate across varying monthly volumes. Its 16,807 matches occupy 9,005,271 bytes
across the 36 match, player, and draft Parquet files, or 535.80 bytes per match. This revises
the historical SQL-backfill estimate from the single-month 521.77 figure to a full-year
weighted average; it retains the same null-advantage-array caveat and still does not estimate
the size of REST-populated months.

The approved 2022 batch adds 24,951 matches in 12,867,408 bytes, or 515.71 bytes per match.
Across all 25 backfilled months committed so far—2021-01 through 2022-12 plus 2023-12—the
running measurement is 43,783 matches in 22,929,262 bytes, or 523.70 bytes per match. This
combined rate supplements rather than replaces the 521.77 single-month and 535.80 full-2021
observations; all three describe SQL-backfilled rows with null advantage arrays.

The approved 2023-01 through 2023-11 batch adds 28,477 matches in 14,462,480 bytes, or
507.8653 bytes per match. Across all 36 backfilled months now committed—2021-01 through
2023-12—the running measurement is 72,260 matches in 37,391,742 bytes, or 517.4611 bytes
per match. Like the earlier historical measurements, these rows have null advantage arrays.

The approved 2024 batch adds 29,994 matches in 15,374,830 bytes, or 512.5969 bytes per
match. Across all 48 backfilled months now committed—2021-01 through 2024-12—the running
measurement is 102,254 matches in 52,766,572 bytes, or 516.0343 bytes per match. These are
again SQL-backfilled rows with null advantage arrays.

The approved 2025 batch adds 30,805 matches in 15,677,229 bytes, or 508.9183 bytes per
match. Across all 60 backfilled months now committed—2021-01 through 2025-12—the running
measurement is 133,059 matches in 68,443,801 bytes, or 514.3869 bytes per match. These are
again SQL-backfilled rows with null advantage arrays.

The final approved closed-history batch, 2026-01 through 2026-07, adds 13,816 matches in
7,176,722 bytes, or 519.4501 bytes per match. Across all 67 backfilled months now
committed—2021-01 through 2026-07—the measurement is 146,875 matches in 75,620,523 bytes,
or 514.8631 bytes per match. These are likewise SQL-backfilled rows with null advantage
arrays. Finding 23's tier totals leave a 649-match residual after those closed months: 473
professional, 147 premium, and 29 excluded. A later Explorer query over August 1-30 found
472 professional, 147 premium, and 29 excluded, or 648 total, so the residual reconciles to
within one professional match. The previously recorded independently measured 621-match
August count is inconsistent with that result and is withdrawn; there is no remaining
±28-match uncertainty to classify. The full `[1785542400, 1788220800)` August query found
484 professional, 147 premium, and 29 excluded matches, or 660 total.

Two formats, by lifecycle stage:

- **Hot month** — `data/matches/2026-08.ndjson`, appended to on every run. Newline-delimited
  JSON because appends produce clean git deltas. Shards are selected from `start_time`.
- **Grace period** — the previous month remains hot through the seventh day of the current
  month. On or after the eighth, compact it from `.ndjson` to `.parquet`, commit both the new
  file and deletion of the old one, and never touch the closed shard again.
- **Closed months** — `data/matches/2026-07.parquet`.
- **Late arrivals** — a match whose `start_time` belongs to an already-compacted month is
  appended to `data/matches/late.ndjson`. Its player and draft rows are appended to the
  parallel `data/players/late.ndjson` and `data/draft/late.ndjson` files. Readers UNION each
  late-arrival table with that table's monthly shards.

If the repo ever exceeds ~500 MB, the escape hatch is to move `data/` to GitHub Release
assets. Do not build that now. Re-evaluate this threshold and escape hatch after the first
two real monthly Parquet shards exist; they will provide a trustworthy per-month figure that
the 299-match sample cannot.

Reference-data history contributes separately to that threshold. `data/reference/teams.parquet`
is 1.48 MB, and git stores a full copy each time this binary file changes. At a weekly refresh
cadence, changes to this file alone add roughly 77 MB of repository growth per year.

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
    players/          # YYYY-MM.ndjson | .parquet | late.ndjson (normally 10 rows/match)
    draft/            # YYYY-MM.ndjson | .parquet | late.ndjson (variable, including zero)
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

The first 36 committed backfill months, 2021-01 through 2023-12, contain 59,807
`professional` and 12,453 `premium` matches and no `excluded` or null-tier row. The 2024
batch is the first direct test of the arithmetic implication recorded before that run:
`excluded` first appears in 2024-05, and the year contains 26,362 professional, 121 premium,
and 3,511 excluded matches. SQL and Parquet agree exactly. Across all 48 committed months,
the totals are therefore 86,169 professional, 12,574 premium, and 3,511 excluded, with no
null-tier row. Finding 23 measured the full backfill population at 111,259 professional,
12,865 premium, and 23,400 excluded matches. The implication partly held: excluded matches
are confined to the recent era and premium matches are scarce, but 2024 accounts for only
3,511 of the 23,400 excluded population. Arithmetic now leaves roughly 45,270 matches in
2025 and 2026-01 through 2026-07: 25,090 professional, 291 premium, and 19,889 excluded.
Those remaining counts are implications to test, not measurements. The observed shift still
puts v1's premium-plus-professional default view in question for the recent era.

The 2025 batch confirms and sharpens that shift. SQL and Parquet agree on 20,100
professional, 144 premium, and 10,561 excluded matches: excluded is 34.28% of the year,
while every premium match belongs to league 18324, The International 2025. The excluded
ramp was not monotonic. It fell from 39.2% in 2024-12 to 27.3% in 2025-01, plateaued between
roughly 26% and 34% through October, then accelerated to 58.5% in November and 69.1% in
December. Destiny League and successive Dota 2 Space League IDs dominate most months;
Ultras Dota Pro League and European Pro League also become substantial late in the year.
Across all 60 committed months the measured tier totals are 106,269 professional, 12,718
premium, and 14,072 excluded. Relative to finding 23, arithmetic then left 4,990
professional, 147 premium, and 9,328 excluded matches for 2026 onward. The later closed
2026-01 through 2026-07 batch accounts for 4,517 professional, zero premium, and 9,299
excluded, leaving the directly recomputed residual of 473 professional, 147 premium, and 29
excluded.

The 2026-01 through 2026-07 batch directly measures 4,517 professional, zero premium, and
9,299 excluded matches. Excluded shares are 51.43%, 71.71%, 81.02%, 69.01%, 81.65%, 52.11%,
and 14.71% from January through July. The November/December 2025 surge therefore continued
at high levels through May, eased in June, and collapsed in July rather than continuing as a
monotonic ramp. May is the high point: its 2,025 excluded matches are spread across fourteen
leagues, led by Destiny League (570), Ultras Dota Pro League (428), Dota 2 Space League
(263), SIVVIT League (137), and 刀塔扭蛋杯 (123). Across all 67 committed months, measured
tier totals are 110,786 professional, 12,718 premium, and 23,371 excluded, with no null-tier
row.

Annual premium counts, recomputed from the committed Parquet through 2025 and from the bounded
August Explorer result for 2026, are:

| Year | Premium matches |
|---:|---:|
| 2021 | 4,694 |
| 2022 | 3,881 |
| 2023 | 3,878 |
| 2024 | 121 |
| 2025 | 144 |
| 2026 through August | 147 |

The 2021-2025 figures are unchanged. The closed 2026-01 through 2026-07 months contain zero
premium matches, but that is not a 2026 year total: league 19719, The International 2026,
ran from 2026-08-13 through 2026-08-23 and contributes all 147 August premium matches.

**Cross-path coverage question.** The current committed 2026-08 REST shard has 340 rows:
328 professional, 12 premium, and zero excluded. The SQL-backed closed months immediately
before it are 67.31% excluded overall and remain 14.71% excluded even in July. That tension
is still evidence worth retaining, and HANDOFF finding 7's earlier “no `/proMatches`
coverage gap” conclusion predates excluded-tier leagues. The earlier July-share scale
estimate suggested roughly 91 excluded matches, but it used the now-withdrawn 621-match
August count and was explicitly not an August tier measurement; the bounded query instead
measures 29 excluded matches.

All 29 excluded matches occurred on August 1-3, while the REST shard begins at
`2026-08-22T07:17:23Z`, so there is no excluded-tier overlap to compare. The September 12
backfill reads SQL and will return those 29 whether or not `/proMatches` omits excluded-tier
leagues. It therefore cannot settle the cross-path question. Current data leave the question
unresolvable; resolving it requires a future window in which excluded matches exist while
`fetch.py` is live.

The overlapping live-tier evidence is stronger. Within the exact span from the first REST row
at `2026-08-22T07:17:23Z` through the shard's last row at `2026-08-31T22:41:16Z`, REST and
SQL agree on every per-day professional and premium count and on every null-team-ID count.
The REST daily tier counts are premium 5 and 7 on August 22-23, then professional 13, 20,
44, 189, 50, and 12 on August 24, 25, 28, 29, 30, and 31. The corresponding daily null
radiant/dire counts are 0/0, 0/0, 0/0, 0/0, 11/7, 97/96, 10/8, and 0/0. In untrimmed UTC
day buckets, the only discrepancy is a boundary effect: SQL has four additional TI matches
on August 22 that started before the shard's first row. This is evidence of no REST coverage
defect for the professional and premium tiers that were live during the overlap.

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

Rendering must apply the same absent-value rule to the denormalized match-row name columns as
to `/teams` reference objects: null, empty, and whitespace-only after trimming all mean “name
unavailable.” An offline 2026-08-31 read of all 147,202 committed match rows found 655
match-side appearances whose team ID is non-null but whose corresponding name is absent by
that rule. None is a true null: 647 are `""`, seven are `" "`, and one is `"  "`. They span
74 team IDs and 48 months, from 2021-01 through 2026-05. The step 9 null-ID/null-name mask
checks remain correct for the invariant they tested, but they cannot detect this rendering
case because an empty or whitespace-only string is non-null. The earlier conclusion based on
nine reference-missing appearances was therefore too narrow, not evidence that the step 9
checks failed.

A 2026-by-month SQL sweep on 2026-08-30 found no systematic recent rise in null team IDs.
Instead, committed observations show that null IDs concentrate in qualifier and open events;
a single event can account for almost an entire month's spike, or the spike can be diffuse
across several events, and neither shape is anomalous. In 2022-06, 989/2,990 matches had at
least one null team ID, with 969 in league 14284, Perfect World Super Challenge—all 969
matches in that league—and 971 matches null on both sides. In 2023-11, 391 of 441 null-team
matches belonged to league 15909, ESL One Kuala Lumpur Qualifiers. By contrast, 2021-11 was
diffuse: its 345/2,293 null-team matches were spread across Intel World Open, four DPC
regional qualifiers, a Douyu invitational, a show match, and a few smaller events. A direct
read of the committed 2026-08 REST shard finds 118/340 null radiant IDs and 111/340 null dire
IDs across its actual `2026-08-22T07:17:23Z` through `2026-08-31T22:41:16Z` UTC span; these
are shard-snapshot rates, not full-month rates. Every null belongs to league 20134, which has
192 rows in the shard, while the other 148 shard rows have none. The concentration is again
event-specific and is a sampling-composition effect. Nameless rendering remains normal
presentation within affected events rather than an exceptional error.

Direct reads of the 2022 shards find 1,322 matches with at least one null team ID: 1,280 are
`professional` and 42 are `premium`. The 42 premium rows occur in four DPC qualifier leagues.
Thus 100% of 2022's null-team matches survive v1's premium-plus-professional default view;
the tier filter does not reduce nameless rendering for that year.

The 2024 shards contain 1,506 matches with at least one null team ID, all of them
`professional`. January is the only month above 10%: 522/3,104 (16.82%). Its concentration
is again event-shaped: league 16140, ESL One Birmingham 2024 Qualifiers, contributes 204;
league 16077, NADCL Season 6, contributes 137; league 16053, DreamLeague Season 22
Qualifiers, contributes 134; the remaining 47 are spread across six smaller events.

The 2025 shards contain 1,567 matches with at least one null team ID. January and March are
the only months above 10%. January has 331/2,972 (11.14%), all professional: DreamLeague
Season 25 Qualifiers contributes 163, ESL One Raleigh 2025 Qualifiers 150, and two smaller
leagues 18. March has 334/2,408 (13.87%), all professional: DreamLeague Season 26 Qualifiers
contributes 158, league 17508 Internet League 137, two SIVVIT league IDs 34, and two smaller
events 5. Other 2025 months remain below 10%; a small number of their null-team matches are
excluded rather than professional, reinforcing that tier must be measured rather than
assumed.

The committed 2023-12 backfill shard provides a dated direct comparison: on 2026-08-30 it
contained 40/2,025 (1.98%) null `radiant_team_id` values and 40/2,025 (1.98%) null
`dire_team_id` values. The corresponding name was null on exactly the same 40 rows on each
side, with zero null-ID/non-null-name violations. This single-month observation supports the
conclusion that August's 18.68%/17.87% spike was specific to league 20134 rather than a trend.

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

### `data/players/` — normally ten rows per match

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

A 2026-08-30 SQL Explorer measurement over all 147,524 matches with `leagueid > 0` and
`start_time >= 1609459200` found 147,523 with exactly ten `player_matches` rows and one with
exactly two rows. Matches with at least one player row and eligible matches both totalled
147,524, so zero matches had zero player rows. That zero is derived by subtraction of the two
counts, not measured with a direct anti-join.

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

The approved 2023-12 backfill provided the first direct per-match measurement: on 2026-08-30,
21 of its 2,025 committed matches (1.04%) had no draft rows. This is one month's direct
observation, while the 1,368 figure above is a population-wide subtraction; neither should be
presented as a universal no-draft rate. These committed match IDs are v1 test cases for the
draft-unavailable state:

```
7466773359, 7468132951, 7468463913, 7476366318, 7477639498, 7480470163,
7480944910, 7480980391, 7484575133, 7485890286, 7485948611, 7488997459,
7489024640, 7490725357, 7498635492, 7500212286, 7504389815, 7507298211,
7511221269, 7511263243, 7514555162
```

Match 7485890286 is also the only known match in the measured 2021+ population with a
`player_matches` row count other than ten: it has two player rows. One committed record
therefore exercises both the short-player anomaly and draft-unavailable cases.

The committed direct no-draft observations form a series, not a universal rate: 167/16,807
(0.99%) in 2021, 174/24,951 (0.70%) in 2022, 157/28,477 (0.55%) in 2023-01 through
2023-11, 21/2,025 (1.04%) in 2023-12, 240/29,994 (0.80%) in 2024, and 448/30,805
(1.45%) in 2025. The 2026-01 through 2026-07 observation is 160/13,816 (1.158%). The
running committed total is 1,367/146,875 (0.931%): 1,152/110,786 professional (1.040%),
50/12,718 premium (0.393%), and 165/23,371 excluded (0.706%). Professional no-draft rates
for January through July are 0.306%, 0.969%, 1.092%, 0.517%, 0.440%, 0.938%, and 0.539%; no
month exceeds 2%, so the 2025 rise to a 2.07% professional yearly rate did not remain
elevated in this chunk.

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

- `/teams` is paginated at 1,000 objects and must be paged until a page returns fewer than
  1,000. As of the first 2026-08-30 observation, that was 23 pages: pages 0–21 of 1,000
  and page 22 of 504, for 22,504 objects containing 21,970 distinct `team_id` values and
  534 duplicate rows. A later 2026-08-30 dry run returned 22,506 objects containing 21,972
  distinct IDs, with page 22 at 506 and duplicates unchanged at 534. Deduplicate by
  `team_id`.
- The page walk is lossy and the loss is deterministic. It is a defect in the endpoint, not
  a gap in the data. On 2026-08-30, `SELECT count(*) FROM teams`, the number of rows served
  by a walk, and the number of distinct non-null team IDs in all-history pro matches were
  each 22,504, so every match-used team ID existed in the `teams` table at that point. This
  triple equality is a point-in-time relationship expected to hold as all three counts grow
  together, not three fixed numbers. Two complete walks produced identical membership and
  the same 534 duplicates on that date. An exhaustive offset walk over an N-row result serves
  N rows, so 534 rows served twice necessarily means 534 rows never served: the "534
  duplicates" and "534 missing" figures are the same subtraction, not a coincidence.
  `/teams` is rating-ordered and rating has very large ties (a 0-1 record rates exactly 984,
  a 1-0 record exactly 1016), so an offset walk across the tie plateau both duplicates and
  drops rows at page boundaries.
- No code may depend on 23 pages, 22,504 rows, or 534 duplicates. The walk terminates on a
  short or empty page, and the supplemental pass covers whatever the walk drops.
- The omitted teams are individually retrievable. `GET /teams/{team_id}` returned HTTP 200
  with a complete object for three sampled walk-missing IDs (1989737, 4326732, 6490258),
  carrying the same keys as page-walk entries: `team_id`, `rating`, `wins`, `losses`,
  `last_match_time`, `delta`, `match_id`, `name`, `tag`, `logo_url`. A SQL check confirmed
  all ten sampled missing IDs are present in the `teams` table.
- Scope as measured on 2026-08-30: all-history, 534 of 22,504 match-used IDs (2.37%) were
  absent from a walk. Within the project's 2021+ boundary there were 8,921 distinct non-null
  team IDs, of which 8,609 appeared in a walk and 312 (3.50%) did not. These population
  counts grow over time. An earlier contract report labeled the unbounded all-history figure
  as 2021+; it was not.
- Team objects carry empty strings as well as nulls: sampled walk-missing teams included a
  null `logo_url` and an empty-string `tag`. Treat empty string and null as equivalent
  "absent" at render.
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

`test_real_august_shards_round_trip_every_row_and_column` derives row counts from the committed
append-only shard rather than pinning them, so scheduled ingest growth does not invalidate the
test. It asserts exact null-position and null-count preservation for `stuns` and
`teamfight_participation`; the original 299-match measurement had zero nulls in both columns
because every sampled match was parsed. The synthetic tests in `test_compact.py` cover the
actual null round-trip case even while the growing real shard continues to have no such nulls.

### `ingest/reference.py`

Refreshes all four reference Parquet files weekly using the exact schemas defined in §5 and
observing the REST rate limit. `/teams` is paged forward until a page contains fewer than
1,000 objects, then deduplicated by `team_id` with the first occurrence winning. One call
each to `/leagues`, `/heroes`, and `/proPlayers` makes 26 calls in the observed steady state:
23 team pages plus three other endpoints.

Because the `/teams` walk is deterministically lossy, each refresh also collects distinct
non-null team IDs from every local match NDJSON, Parquet, and late-arrival shard. It subtracts
IDs returned by the current walk and IDs already cached in `data/reference/teams.parquet`,
then requests the remaining IDs in ascending order from `/teams/{team_id}`. The existing
Parquet is the only supplemental cache; there is no separate state file. At most 600 IDs are
attempted per refresh, with the remainder reported as deferred to the next week. A 404 or
other non-200 response is counted and reported but does not abort the run. A refresh with a
large supplemental backlog can therefore make up to 626 REST calls.

Supplemental rows are merged into `teams.parquet` with ordinary team rows. A supplementally
fetched team that remains absent from later page walks is not refreshed again, so its name,
tag, and logo can become stale indefinitely. This is intentional: the stored schema excludes
rating, and the affected teams are overwhelmingly single-match teams.

Every output is sorted deterministically before writing: teams by `team_id`, leagues by
`leagueid`, heroes by `id`, and players by `account_id`. `/teams` is rating-ordered and its
order changes as ratings change; stable sorting prevents an unchanged weekly refresh from
producing a meaningless Parquet diff, commit, and Cloudflare build. `--dry-run` performs all
API and local reads, prints paging, deduplication, supplemental, and per-file row counts, and
writes nothing.

### `.github/workflows/ingest.yml`

- `on: schedule: cron: "0 */6 * * *"` plus `workflow_dispatch`
- `concurrency: group: ingest, cancel-in-progress: false` — overlapping runs would corrupt
  `state.json`
- `permissions: contents: write`
- Commit with the `github-actions[bot]` identity
- Run `fetch.py`, then print `data/.run-summary.json` to the Actions log. The summary is
  gitignored and is never staged.
- If `fetch.py` exits non-zero, do not run the summary or commit steps and do not preserve any
  workspace writes. `fetch.py` writes every pending match/player/draft shard first, then both
  failure queues, then `state.json`; state therefore cannot advance while shard writes are
  incomplete. A fatal mid-write error can still leave a partial workspace with the old state,
  so committing any part of a failed run is unsafe. Discarding the runner workspace makes the
  next scheduled run retry from the last committed cursor.
- Snapshot successful generated changes with `git stash --include-untracked` scoped to
  `data/`. This dynamically preserves modified files, new shards, and compaction deletions
  without hardcoding filenames. The ignored run summary and unchanged reference files are not
  included, so restoring the snapshot cannot overwrite a concurrent reference refresh.
- Fetch `origin/main`, reset hard to that tip, restore the snapshot, run `git add -A data`, and
  use `git diff --cached --quiet` as the no-change guard before committing and pushing. The
  ordinary `git diff --quiet` does not detect first-run untracked shards. A non-fast-forward
  push repeats the fetch/reset/restore/stage/commit cycle, with at most three attempts. Do not
  use pull, rebase, or a binary merge strategy.

### `.github/workflows/reference.yml`

- Run weekly plus `workflow_dispatch`
- `permissions: contents: write`
- Commit with the `github-actions[bot]` identity only when reference data changed

This workflow is the pattern for `ingest.yml` in step 7: use `setup-python` with the pinned
Python version, install from `requirements.txt`, and generate the data before synchronizing
with the remote. Preserve the generated outputs in a temporary directory outside the worktree,
then fetch `origin/main`, reset the worktree to that tip, restore the generated outputs, stage
the relevant data subdirectory, and use `git diff --cached --quiet` as the no-change guard
before committing and pushing. If the push is rejected as non-fast-forward, repeat that
fetch/reset/restore/stage/commit cycle with a bounded retry count.

Do not rebase generated data commits. The Parquet files are regenerated binary output, not
edited source: when both the remote tip and the current run contain a version, the freshly
generated version is authoritative. Git cannot merge the binary content, so rebasing a stale
run onto a remote reference refresh can produce an add/add conflict instead of resolving the
race.

### `ingest/backfill.py` — run locally, once, never in CI

Loads 2021-01-01 → present via `/explorer` SQL. Per-match REST calls are not an option here:
roughly 147,493 and growing would consume three months of quota.

Chunk by calendar month from 2021-01 through the run-date-derived upper bound,
keyset-paginated within each chunk so a row cap or timeout cannot silently truncate
results:

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

Parallel queries against `player_matches` and `picks_bans` use the same match-ID window. The
`LIMIT 2000` shown above applies only to the match query. The player and draft queries carry
no `LIMIT`; they are bounded by `match_id > :cursor AND match_id <= :window_end`. Count
`player_matches` rows per match before accepting a page. Because results are ordered by
`match_id, player_slot`, a short contiguous suffix at the highest match IDs is treated as
suspected server-side truncation; "short" here includes counts from zero through nine. If the
page can still be reduced, halve it and retry the same cursor using the same path as a timeout
before classifying any tail count. Player-tail suspicion can halve at most three times per
month; three successive full-window reductions take the normal 2,000-match window through
1,000 and 500 to 250. A shorter final page can reduce farther only when fewer matches remain
in the month. After that cap, further short tails are classified normally instead of shrinking
the rest of the month; timeout-triggered halving does not consume this budget and keeps its
existing behavior. The per-month completion summary reports both the number of player-tail
halvings and whether the cap was reached. Exactly ten rows is normal. Once halving
has bottomed out, the player-tail cap has been exhausted, or a short count is away from the
tail, classify the observation: one through nine is a data anomaly that is retained and
reported, while zero aborts the month with the match ID in the error and has no override. Zero
was absent from the measured population and is the remaining signal of silent truncation at a
one-match window. Counts above ten are also recorded as non-truncation anomalies. A successful
result has no zero-player field; fatal IDs are reported by `ZeroPlayerRowsError`.
Zero `picks_bans` rows are valid (about 0.93% of matches) and are reported but do not abort.
Expect roughly 400–600 explorer calls total.

The hard upper bound is the last fully closed month, computed from the run date by reusing
`compact.py`'s eligibility rule. A month stays hot through the seventh of the following month:
on September 3 the bound is July, while on September 12 it is August. Backfill must never
write the current hot month. Doing so could create a thin month that compaction seals
permanently on the eighth even though closed shards are never rewritten.

REST data always has precedence over SQL backfill data. REST is the only source for
`radiant_gold_adv` and `radiant_xp_adv`, so replacing a REST-written match with its SQL row
would silently destroy that match's gold graph. Deduplication occurs at write time: immediately
before publishing a month, read its existing match IDs from monthly NDJSON or Parquet and the
late-arrival shard, skip those matches and all of their backfilled player/draft rows, and retain
the existing rows unchanged. This preserves the v0 acceptance criterion that each match shard
itself contains no duplicate `match_id`; readers must not be responsible for repairing overlap.

If an eligible month has already been compacted, new SQL-only match rows are late arrivals,
not an error. Never rewrite its Parquet files. Append the new match rows to
`data/matches/late.ndjson` and their corresponding child rows to
`data/players/late.ndjson` and `data/draft/late.ndjson`, using the same schema-shaped NDJSON
rows and atomic append helper as `fetch.py`. Apply write-time match-ID deduplication against
both the closed Parquet shard and existing `matches/late.ndjson`; an existing REST match
therefore protects its match, player, and draft rows together. A valid zero-draft match simply
adds no draft row. This path is required for the measured 2026-08 case. Once August is
sealed, derive the outstanding set from the sealed shard rather than pinning a moving count:
outstanding matches equal `660 - sealed August rows`, split as `484 - sealed professional
rows`, `147 - sealed premium rows`, and `29 - sealed excluded rows`.

Snapshot computed at `2026-09-01T19:12:35Z` from fetched `origin/main`
`6d95899965dac59120294a475ded3e026bbf5d59`: the committed shard has 340 rows split
328/12/0, leaving 320 SQL-only rows split 156 professional, 135 premium, and 29 excluded.
The snapshot is roughly two fifths premium because of The International 2026, not
overwhelmingly professional; recompute it after later ingest runs or compaction.

The three late files cannot be published as one filesystem-atomic group. Publish draft first,
players second, and the match deduplication key last. Before each child append, remove rows
whose match IDs already occur in that child's own `late.ndjson`. Therefore an interruption
after either child append is resumable: the next pass skips the already-complete child set,
adds the missing child set, and publishes the match key last. Once the match key exists, both
children are already durable, so REST-first match deduplication cannot strand them.

Write each completed historical month directly to `.parquet`, with all three tables staged and
verified before publication. Existing eligible NDJSON rows may be carried into that first
Parquet publication, but an existing closed Parquet shard is never rewritten. If a month has no
matches and no existing NDJSON, publish no files and still checkpoint the completed month.

The gitignored `ingest/.backfill-checkpoint.json` has version 1 and records the sorted
`completed_months`, the most recent `last_eligible_month`, and `updated_utc`. Save it atomically
after each month, including an empty month, so a crash at month 50 does not cost the first 49.
On an Explorer timeout, halve the keyset page limit and retry the same cursor; if a one-match
window still times out, fail without advancing the checkpoint. Source team names from the
`teams` joins shown above. If a team ID is null, write the corresponding team name as null and
continue without dropping the match; report such rows in the month's `null_team_id_matches`
summary count rather than adding a schema column.

Live execution is fail-closed: invoking the module without arguments prints usage and exits
non-zero. `--execute-live` is the explicit opt-in required to contact `/explorer` and write
data. Step 9 can be bounded without editing code by passing `--month YYYY-MM` for exactly one
fully closed month or `--max-months N` for a small number of incomplete checkpoint months.
`--dry-run` remains entirely mocked and cannot be combined with `--execute-live`.

Explorer spacing is measured from the completion of response reading, so even a query that
takes longer than five seconds is followed by at least a five-second pause before the next
call. HTTP 429 responses honor `Retry-After`; without it they use exponential backoff from
1.1 seconds, with at most five in-run retries. On the first non-empty match page, the returned
column names must cover every selected match column before nullable schema projection occurs.

`radiant_gold_adv` / `radiant_xp_adv` are not practical to backfill via explorer. Leave them
null for historical rows and populate them going forward. The match page must render without
the gold graph.

The script must provide a `--dry-run` that validates query construction and keyset pagination
against mocked responses without calling the live API or writing data. Do not run the live
backfill without explicit user approval.

The explicitly approved step 9 run on 2026-08-30 processed only 2023-12. It completed two
match pages with seven Explorer query calls in 39.382 seconds. No `TIMEOUT`,
`TRUNCATED PLAYER TAIL`, or `PLAYER TAIL HALVING CAP REACHED` line appeared, so this run
provided no evidence of an Explorer row cap. Direct reads of the published Parquet files
verified 2,025 match rows with 2,025 distinct match IDs; 20,242 player rows, with exactly ten
per match except match 7485890286 at two; and 48,091 draft rows, with contiguous `ord` values
and 21 matches having no draft rows. No match had zero player rows. Both advantage columns
were null on all 2,025 matches. Null team IDs and names matched exactly at 40 radiant and 40
dire rows, with no null-ID/non-null-name violation. The three 2023-12 NDJSON shards were
absent after publication, and the gitignored checkpoint records 2023-12 as completed.

A second explicitly approved bounded invocation selected exactly 2021-01 through 2021-12,
skipping the already checkpointed 2023-12 month, and completed all twelve in 321.282 seconds
with 51 Explorer query calls. No `TIMEOUT`, `TRUNCATED PLAYER TAIL`,
`PLAYER TAIL HALVING CAP REACHED`, or player-row anomaly appeared. Direct Parquet reads found
16,807 distinct matches with no within- or cross-month duplicate match IDs, and every monthly
count matched one independent grouped Explorer query over the 2021 window. All match rows had
null advantage arrays, every null team ID had a matching null team name on the same side, and
the checkpoint now records all twelve 2021 months plus 2023-12 as completed.

A third explicitly approved bounded invocation selected exactly 2022-01 through 2022-12 and
completed all twelve in 462.122 seconds with 66 Explorer query calls. No `TIMEOUT`,
`TRUNCATED PLAYER TAIL`, `PLAYER TAIL HALVING CAP REACHED`, or player-row anomaly appeared.
Direct Parquet reads found 24,951 distinct matches with no duplicate match IDs within 2022 or
across any of the 25 backfilled months. Every monthly count matched one independent grouped
Explorer query over `[1640995200, 1672531200)`, both advantage columns were null throughout,
and every null team ID had a corresponding null team name on the same side. The checkpoint
now records all twelve months of 2021 and 2022 plus 2023-12 as completed.

A fourth explicitly approved bounded invocation selected exactly 2023-01 through 2023-11,
skipping completed 2023-12, and completed all eleven in 559.051 seconds with 77 Explorer
query calls. No `TIMEOUT`, `TRUNCATED PLAYER TAIL`, `PLAYER TAIL HALVING CAP REACHED`, or
player-row anomaly line appeared. Direct Parquet reads found 28,477 distinct matches with no
duplicate match IDs within the batch or across all 36 backfilled months; both advantage
columns were null throughout, and every null team ID had a corresponding null team name on
the same side. The batch occupies 14,462,480 bytes, or 507.8653 bytes per match; all 36
months contain 72,260 matches at 517.4611 bytes per match. The first independent verification
attempt failed with HTTP 400 because shell quoting stripped SQL literals. A replacement
verification issued from a Python file through `ExplorerClient` grouped the exact
`[1672531200, 1701388800)` window by UTC month and league tier: every monthly total and tier
distribution matched Parquet, with no `excluded` or null-tier row.

A fifth explicitly approved bounded invocation selected exactly 2024-01 through 2024-12 and
completed all twelve in 489.988 seconds with 84 Explorer query calls. No `TIMEOUT`,
`TRUNCATED PLAYER TAIL`, `PLAYER TAIL HALVING CAP REACHED`, or player-row anomaly line
appeared. Direct Parquet reads found 29,994 distinct matches with no duplicate match IDs
within 2024 or across all 48 backfilled months. Every 2024 match has exactly ten player rows,
both advantage columns are null throughout, and every null team ID has a corresponding null
team name on the same side. The batch occupies 15,374,830 bytes, or 512.5969 bytes per
match; all 48 months contain 102,254 matches at 516.0343 bytes per match. An independent
Explorer query grouped `[1704067200, 1735689600)` by UTC month and league tier; every monthly
total and tier distribution matched Parquet. The year contains 26,362 professional, 121
premium, and 3,511 excluded matches, with excluded first appearing in May. This partly
confirms the prior recent-era tier implication while leaving most excluded matches to be
measured in 2025-2026. The 2024 no-draft observation is 240/29,994 (0.80%).

A sixth explicitly approved bounded invocation selected exactly 2025-01 through 2025-12 and
completed all twelve in 481.413 seconds with 84 Explorer query calls. No `TIMEOUT`,
`TRUNCATED PLAYER TAIL`, `PLAYER TAIL HALVING CAP REACHED`, or player-row anomaly line
appeared. Direct Parquet reads found 30,805 distinct matches with no duplicate match IDs
within 2025 or across all 60 backfilled months. Every 2025 match has exactly ten player rows,
both advantage columns are null throughout, and every null team ID has a corresponding null
team name on the same side. The batch occupies 15,677,229 bytes, or 508.9183 bytes per
match; all 60 months contain 133,059 matches at 514.3869 bytes per match. An independent
Explorer query grouped `[1735689600, 1767225600)` by UTC month and league tier; every monthly
total and tier distribution matched Parquet. The year contains 20,100 professional, 144
premium, and 10,561 excluded matches. The excluded share plateaued near 26-34% through
October before jumping to 58.5% in November and 69.1% in December. The 2025 no-draft
observation is 448/30,805 (1.45%).

A seventh and final closed-history invocation selected exactly 2026-01 through 2026-07 and
completed all seven in 233.887 seconds with 43 Explorer query calls. No `TIMEOUT`,
`TRUNCATED PLAYER TAIL`, `PLAYER TAIL HALVING CAP REACHED`, or player-row anomaly line
appeared. Direct Parquet reads found 13,816 distinct matches, no duplicate match ID within
the batch or across all 67 backfilled months, exactly ten player rows per selected match,
null advantage arrays throughout, and exact correspondence between null team IDs and names.
The only all-history player anomaly remains match 7485890286 with two rows. An independent
Explorer query grouped `[1767225600, 1785542400)` by UTC month and league tier; every monthly
total and tier distribution matched Parquet. January alone exceeded 10% null-team matches at
369/2,693 (13.70%), concentrated in DreamLeague Season 28 Qualifiers (141), ESL One
Birmingham 2026 Qualifiers (152), 肛宝联赛-老婆杯 (41), and SIVVIT League (33), with two
single-match leagues. The batch occupies 7,176,722 bytes (519.4501 bytes per match), and all
67 months occupy 75,620,523 bytes (514.8631 bytes per match). The pre-run 2026-08 NDJSON
remained byte-identical at 338,692 bytes and SHA-256
`191e237866b5d1ca8350dec80fcc804350c420c3f69d60182e689ba9be7f9730`; no 2026-08
Parquet was created. The checkpoint records all months through 2026-07. The 2026-08 month is
still outstanding as a separate explicitly bounded run on or after 2026-09-12, when it will
be the first live exercise of the late-arrival path against an existing REST shard.

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
- [x] **Step 9, explicit approval required:** backfill completes for at least one
      historical month and matches the count from an independent `SELECT count(*)` for that
      window

---

## 7. v1 — the site

**Stack:** Astro (static output), DuckDB via `duckdb-node` to read Parquet at build time,
Observable Plot for charts, plain CSS. No React, no Tailwind, no UI framework.

**Routes:**

- `/` — most recent 100 matches. Team names, score, duration, league, relative time.
  Default the view to `league_tier IN ('premium','professional')`; the tier filter is why
  we stored it. Do not assume this filter reduces nameless rendering: all 1,322 null-team
  matches committed for 2022 are premium or professional and survive it. The 2024 backfill
  directly establishes the recent tier shift: excluded first appears in May and reaches
  3,511 matches for the year, while only 121 matches are premium. The 2025 backfill then
  finds 10,561 excluded matches (34.28%) and only 144 premium, with excluded reaching 69.1%
  in December. The 2026-01 through 2026-07 backfill directly finds another 9,299 excluded
  matches and no premium matches in those seven closed months; The International 2026 then
  contributes 147 premium matches in August. Excluded exceeds half of every month from
  January through June, peaks at 81.65% in May, and falls to 14.71% in July. The
  premium-plus-professional default would hide most matches in several recent months, so
  revisit whether it is appropriate for the home feed and 90-day window.
- `/matches/[id]` has two page types divided by the build's trailing-90-day boundary:
  - **Full recent page:** pre-rendered for matches inside the window, with draft order (picks
    and bans, both teams, in `ord` sequence), both boxscores (hero, K/D/A, LH/DN, GPM/XPM,
    net worth, items), and the gold-advantage graph when `radiant_gold_adv` is non-null. If
    the match has no draft rows, render a clean draft-unavailable state just as an unparsed
    match renders without the gold graph.
  - **Historical summary page:** rendered client-side for older matches from the selected
    per-month JSON payload. It shows teams, result, score, league, duration, patch, and date,
    with no draft, boxscores, or advantage graph. This meaningful summary is what “reachable”
    means for an older match in v1; it is not a full-detail page.

Both page types apply the same absent-name rule. The committed data contains 7,058 matches
with at least one null team ID and 655 match-side appearances whose non-null team ID has an
empty or whitespace-only denormalized name after trimming. Each case renders without a team
name and without an error.

**Build scope — this is a hard constraint.** Cloudflare caps builds at 20 minutes. Do not
pre-render all roughly 147,495-and-growing match pages. Pre-render **only matches from the
last 90 days**. Do not size the 90-day pre-render window from the ~71/day long-run average.
The trailing-90-day match count is volatile in both directions: 2026-01 through 2026-03
totalled 7,294 matches, above the original ~6,400 estimate, while 2026-06 through 2026-08
totalled 2,169. Plan for a 2,000–7,500 page range, and count the real window at build time
rather than assuming a figure. Older matches resolve through a catch-all route that first
uses the compact month/minimum-ID/maximum-ID range manifest and then reads the candidate
month's summary JSON client-side. The payload is the match row excluding
`radiant_gold_adv` and `radiant_xp_adv`; its match IDs provide the per-month existence check.
Across the current 68 months, those 68 payloads occupy 88,248,288 bytes raw and 8,644,307
bytes gzipped—about 127 KB gzipped per month on average. With the shared manifest, the
summary design adds 69 deployment files.

Cloudflare Pages constrains this design to 20,000 files on the Free plan, 25 MiB per asset,
and a 20-minute build timeout. Full-page monthly JSON is rejected: four measured months
exceed 25 MiB, and three more are within 1% below the limit, making the design both invalid
for current data and fragile as shards grow. IDs-only JSON is also rejected because it would
reduce “reachable” to an unavailable notice rather than a meaningful destination.

**Deploy:** Cloudflare Pages, connected to the repo, building on push to `main`. The ingest
job's commits trigger builds automatically.

### v1 acceptance criteria

- [ ] `npm run build` completes in under 10 minutes locally
- [ ] Home feed renders with correct team names and results
- [ ] A recent full match page renders the full draft when present, a clean unavailable state
      when absent, and both boxscores
- [ ] A parsed match shows the gold graph; an unparsed one renders cleanly without it
- [ ] A match older than 90 days renders its summary page with the correct teams, result, and
      league; an unknown match ID produces a clean not-found state rather than an error
- [ ] Null-ID, empty-name, and whitespace-only-name teams render without a name or an error on
      both full and summary pages
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

Python 3.14.5 is the pinned project and CI interpreter. The ingest pipeline's only
third-party runtime dependency is PyArrow; its exact version is pinned in `requirements.txt`,
and CI installs dependencies from that file.

1. Scaffold the structure in §4.
2. Confirm Actions is enabled and workflow write permissions are on. The repository owner
   confirms public visibility and Actions write permissions externally.

---

## Appendix A. Committed-data readiness analysis for v1

This is a measured finding, not a change to §7. It was produced offline on 2026-08-31 from
the committed files under `data/` only, with an explicit analysis clock of
`2026-08-31T00:00:00Z`. Trailing windows are half-open intervals ending at that instant.
The dataset contains 147,202 unique matches: 146,875 complete SQL-backfilled rows through
2026-07 plus the partial 327-row 2026-08 REST shard. Every window below includes that partial
August shard; the missing August population can change both counts and tier shares.

### Pre-render budget

| Window | Start epoch | Matches | Excluded | Premium | Professional |
|---|---:|---:|---:|---:|---:|
| 30 days | 1785542400 | 327 | 0 | 12 | 315 |
| 90 days | 1780358400 | 1,781 | 587 | 12 | 1,182 |
| 180 days | 1772582400 | 9,046 | 6,148 | 12 | 2,886 |

The committed 90-day count is below §7's 2,000-page planning floor only because August is
partial. For this appendix's half-open window ending `2026-08-31T00:00:00Z`, replacing its
327 committed rows with the later measured 648 rows through August 30 gives 2,102 pages,
inside the 2,000–7,500 range. That SQL population is 29 excluded, 147 premium, and 472
professional; relative to the appendix snapshot, the added rows are 29 excluded, 135
premium, and 157 professional.

### Default-view behavior

The current `premium` plus `professional` default keeps 100/100 newest matches (100%),
443/500 newest (88.600%), and 1,194/1,781 in the committed trailing 90 days (67.041%). The
newest 100 are all `professional`; the newest 500 are 57 `excluded`, 12 `premium`, and 431
`professional`. The 90-day set is 587 `excluded`, 12 `premium`, and 1,182 `professional`.
The newest samples are compositionally biased because the partial REST shard contains no
`excluded` rows.

| Closed month | Total | Kept | Kept share | Excluded | Premium | Professional |
|---|---:|---:|---:|---:|---:|---:|
| 2025-08 | 2,651 | 1,790 | 67.522% | 861 | 0 | 1,790 |
| 2025-09 | 3,011 | 2,152 | 71.471% | 859 | 144 | 2,008 |
| 2025-10 | 2,993 | 1,976 | 66.021% | 1,017 | 0 | 1,976 |
| 2025-11 | 2,477 | 1,029 | 41.542% | 1,448 | 0 | 1,029 |
| 2025-12 | 2,130 | 658 | 30.892% | 1,472 | 0 | 658 |
| 2026-01 | 2,693 | 1,308 | 48.570% | 1,385 | 0 | 1,308 |
| 2026-02 | 2,188 | 619 | 28.291% | 1,569 | 0 | 619 |
| 2026-03 | 2,413 | 458 | 18.981% | 1,955 | 0 | 458 |
| 2026-04 | 2,494 | 773 | 30.994% | 1,721 | 0 | 773 |
| 2026-05 | 2,480 | 455 | 18.347% | 2,025 | 0 | 455 |
| 2026-06 | 1,113 | 533 | 47.889% | 580 | 0 | 533 |
| 2026-07 | 435 | 371 | 85.287% | 64 | 0 | 371 |

**Finding and recommendation, pending approval:** the same default appears to keep 100% of
the newest feed while hiding 69–82% of several recent closed months. That discontinuity is a
source-path artifact, not a stable user-facing definition of relevance. v1 should default to
all tiers and expose tier as a visible control, with `premium` plus `professional` available
as an explicit selection. Do not silently retain the current default. This recommendation is
recorded for review; §7 remains unchanged.

### Match-page completeness

| Scope | Matches | No draft | Null radiant team | Null dire team | Either team null | Both advantage arrays null | All ten result fields null |
|---|---:|---:|---:|---:|---:|---:|---:|
| All committed | 147,202 | 1,367 | 5,040 | 5,449 | 7,058 | 146,875 | 7 |
| Trailing 90 days | 1,781 | 12 | 145 | 141 | 193 | 1,454 | 0 |

`radiant_gold_adv` and `radiant_xp_adv` have identical null masks in this snapshot: each is
null on the same 146,875 all-history rows and the same 1,454 trailing-90-day rows. That is a
source distinction: every closed SQL-backfilled row is null, while all 327 partial-August
REST rows populate both arrays. The seven rows null across `radiant_win`, both scores,
`first_blood_time`, `game_mode`, `lobby_type`, and all four tower/barracks fields are present:

```
7445599470, 7468132951, 7477639498, 7480980391, 7484575133,
7485890286, 7488997459
```

### Reference-join readiness

The match shards use 8,918 distinct non-null team IDs, while `teams.parquet` contains 22,019
IDs. There are 271 used IDs absent from the reference file, covering 330 match-side
appearances. The match rows preserve a denormalized name for 321 appearances, so those render
a name but lack reference-provided logos and cannot support a complete future team page. The
remaining nine appearances across seven missing reference IDs are part of, but do not define,
the broader rendering-name gap:

| Team ID | Appearances | Match IDs |
|---:|---:|---|
| 8215149 | 1 | 6227089721 |
| 8606585 | 1 | 6289118475 |
| 9265443 | 1 | 7457724604 |
| 9736535 | 1 | 8250351584 |
| 9742000 | 3 | 8260467074, 8261805473, 8261983238 |
| 9776501 | 1 | 8299524108 |
| 9906348 | 1 | 8509545723 |

The rendering-relevant measurement must not be restricted to reference-missing IDs. Across
both sides of every committed match, the predicate `team_id IS NOT NULL AND (name IS NULL OR
trim(name) = '')` finds 655 appearances across 74 team IDs: 319 radiant and 336 dire. The
observed forms are 647 empty strings, seven single spaces, one double space, and zero true
nulls. The ten team IDs with the most appearances are 9149320 (185), 8442908 (176), 9256255
(80), 9238262 (24), 9736263 (23), 9336632 (18), 8829931 (13), 9855039 (11), 9651524 (8),
and 2886796 (5). These appearances occur from 2021-01 through 2026-05.

All 964 distinct non-null league IDs used by matches occur among the 10,127 IDs in
`leagues.parquet`; there is no league-reference gap. All 127 distinct non-null draft hero IDs
occur among the 127 IDs in `heroes.parquet`; there is no draft-hero gap. Match rows already
carry denormalized league names, while draft rows do not carry hero names, so a future hero
gap would directly affect draft rendering whereas the measured league set is doubly covered.

### Build-time read cost

| `data/` area | Files | Bytes |
|---|---:|---:|
| `matches/` | 69 | 7,118,598 |
| `players/` | 69 | 66,143,189 |
| `draft/` | 69 | 5,310,299 |
| `reference/` | 5, including `.gitkeep` | 1,978,183 |
| root data files | 3 | 83 |
| **Total** | **215** | **80,550,352** |

The current newest 100 all live in `data/matches/2026-08.ndjson`, so an implementation that
uses shard names to prune files needs zero monthly fact-Parquet bytes for the home query and
reads 338,692 bytes of hot match NDJSON. Projected reference column chunks add 1,747,458
Parquet bytes if all team, player, league, and hero lookups are loaded, for 2,086,150 bytes
including the hot match file.

The 90-day set touches the 2026-06 and 2026-07 Parquet shards plus August NDJSON. For the
exact §7 match, box-score, and draft projections, Parquet metadata reports 51,330 compressed
match-column bytes, 409,400 player-column bytes, and 50,705 draft-column bytes: 511,435 fact
bytes after column pruning. The six complete fact files total 896,610 bytes without pruning.
Adding projected reference columns makes the Parquet scan 2,258,893 bytes. The three August
NDJSON files total 2,951,560 bytes, producing a 5,210,453-byte projected working input. Even
the complete committed `data/` tree is only 80,550,352 bytes, so data volume is not plausibly
the binding constraint for either the 20-minute platform cap or the under-10-minute local
acceptance target. Page generation and framework overhead should be measured instead.

### Catch-all route index

The measurement below serializes each month's sorted IDs as a compact JSON array plus one LF.
The filename supplies the month, so `match_id` is the only per-row routing field.

| Month | IDs | Bytes | Month | IDs | Bytes |
|---|---:|---:|---|---:|---:|
| 2021-01 | 1,578 | 17,360 | 2024-01 | 3,104 | 34,146 |
| 2021-02 | 1,318 | 14,500 | 2024-02 | 2,367 | 26,039 |
| 2021-03 | 1,136 | 12,498 | 2024-03 | 2,966 | 32,628 |
| 2021-04 | 1,367 | 15,039 | 2024-04 | 2,183 | 24,015 |
| 2021-05 | 1,353 | 14,885 | 2024-05 | 2,420 | 26,622 |
| 2021-06 | 847 | 9,319 | 2024-06 | 2,635 | 28,987 |
| 2021-07 | 1,398 | 15,380 | 2024-07 | 2,409 | 26,501 |
| 2021-08 | 1,308 | 14,390 | 2024-08 | 2,437 | 26,809 |
| 2021-09 | 1,432 | 15,754 | 2024-09 | 2,571 | 28,283 |
| 2021-10 | 1,225 | 13,477 | 2024-10 | 2,288 | 25,170 |
| 2021-11 | 2,293 | 25,225 | 2024-11 | 2,565 | 28,217 |
| 2021-12 | 1,552 | 17,074 | 2024-12 | 2,049 | 22,541 |
| 2022-01 | 1,555 | 17,107 | 2025-01 | 2,972 | 32,694 |
| 2022-02 | 1,630 | 17,932 | 2025-02 | 2,334 | 25,676 |
| 2022-03 | 2,046 | 22,508 | 2025-03 | 2,408 | 26,490 |
| 2022-04 | 1,893 | 20,825 | 2025-04 | 2,535 | 27,887 |
| 2022-05 | 2,089 | 22,981 | 2025-05 | 2,273 | 25,005 |
| 2022-06 | 2,990 | 32,892 | 2025-06 | 2,381 | 26,193 |
| 2022-07 | 2,433 | 26,765 | 2025-07 | 2,640 | 29,042 |
| 2022-08 | 2,235 | 24,587 | 2025-08 | 2,651 | 29,163 |
| 2022-09 | 1,798 | 19,780 | 2025-09 | 3,011 | 33,123 |
| 2022-10 | 1,675 | 18,427 | 2025-10 | 2,993 | 32,925 |
| 2022-11 | 1,852 | 20,374 | 2025-11 | 2,477 | 27,249 |
| 2022-12 | 2,755 | 30,307 | 2025-12 | 2,130 | 23,432 |
| 2023-01 | 2,589 | 28,481 | 2026-01 | 2,693 | 29,625 |
| 2023-02 | 2,719 | 29,911 | 2026-02 | 2,188 | 24,070 |
| 2023-03 | 2,591 | 28,503 | 2026-03 | 2,413 | 26,545 |
| 2023-04 | 2,704 | 29,746 | 2026-04 | 2,494 | 27,436 |
| 2023-05 | 2,429 | 26,721 | 2026-05 | 2,480 | 27,282 |
| 2023-06 | 2,780 | 30,582 | 2026-06 | 1,113 | 12,245 |
| 2023-07 | 2,655 | 29,207 | 2026-07 | 435 | 4,787 |
| 2023-08 | 2,471 | 27,183 | 2026-08 partial | 327 | 3,599 |
| 2023-09 | 2,257 | 24,829 |  |  |  |
| 2023-10 | 2,186 | 24,048 |  |  |  |
| 2023-11 | 3,096 | 34,058 |  |  |  |
| 2023-12 | 2,025 | 22,277 |  |  |  |

All 68 current month indexes contain 147,202 IDs in 1,619,358 bytes. Only 145,421 matches
are older than the 90-day boundary; indexes limited to those IDs occupy 1,599,763 bytes,
including 94 June IDs in 1,036 bytes and no July or partial-August IDs. Monthly files are
3.6–34.1 KB and align with the source shards, so one index per month is the right storage and
cache granularity.

The routing premise was measured directly rather than assumed. Across the 68 committed
months, zero pairs of inclusive `[min_match_id, max_match_id]` ranges overlap. A compact JSON
array of `{month,min_match_id,max_match_id}` objects occupies 4,897 bytes raw or 1,083 bytes
under deterministic gzip. In the current data, that manifest maps any in-range match ID to
exactly one candidate month without fetching a monthly index; the selected monthly index is
then needed only to confirm that the ID actually exists. Zero overlap is an observed property,
consistent with finding 6's zero month crossings, not a permanent guarantee. If a future
month overlaps an existing range, routing must return every candidate month and check each
candidate's ID index rather than choosing one arbitrarily.

### Historical catch-all payload decision

The following offline measurement uses one compact UTF-8 JSON file plus LF per committed
month. “Full” is `{"matches":[full rows],"players":[full rows],"draft":[full rows]}`;
“match-only” contains full match rows with `radiant_gold_adv` and `radiant_xp_adv` removed;
“IDs-only” is the sorted ID array. Each gzip size is from compressing that month's payload
independently with level 9 and `mtime=0`.

| Month | Full raw | Full gzip | Match-only raw | Match-only gzip | IDs raw | IDs gzip |
|---|---:|---:|---:|---:|---:|---:|
| 2021-01 | 13,840,475 | 1,585,387 | 962,186 | 96,337 | 17,360 | 6,431 |
| 2021-02 | 11,534,730 | 1,295,772 | 791,978 | 78,009 | 14,500 | 5,777 |
| 2021-03 | 9,923,414 | 1,117,759 | 675,684 | 63,233 | 12,498 | 4,968 |
| 2021-04 | 11,970,930 | 1,354,356 | 828,296 | 80,159 | 15,039 | 5,974 |
| 2021-05 | 11,845,940 | 1,339,269 | 814,863 | 77,112 | 14,885 | 5,893 |
| 2021-06 | 7,411,342 | 833,911 | 501,213 | 44,517 | 9,319 | 3,772 |
| 2021-07 | 12,228,927 | 1,382,764 | 834,234 | 74,902 | 15,380 | 6,099 |
| 2021-08 | 11,433,004 | 1,294,962 | 787,187 | 71,488 | 14,390 | 5,697 |
| 2021-09 | 12,546,978 | 1,412,579 | 860,220 | 75,063 | 15,754 | 6,218 |
| 2021-10 | 10,729,802 | 1,210,375 | 727,390 | 64,087 | 13,477 | 5,352 |
| 2021-11 | 20,111,369 | 2,293,808 | 1,384,548 | 131,133 | 25,225 | 9,530 |
| 2021-12 | 13,617,075 | 1,539,027 | 944,374 | 88,077 | 17,074 | 6,745 |
| 2022-01 | 13,638,111 | 1,543,725 | 944,404 | 88,718 | 17,107 | 6,812 |
| 2022-02 | 14,300,320 | 1,634,919 | 981,659 | 93,425 | 17,932 | 7,073 |
| 2022-03 | 17,938,401 | 2,047,473 | 1,245,228 | 120,152 | 22,508 | 8,723 |
| 2022-04 | 16,593,154 | 1,891,021 | 1,146,316 | 111,764 | 20,825 | 8,138 |
| 2022-05 | 18,340,872 | 2,106,202 | 1,258,805 | 122,614 | 22,981 | 8,976 |
| 2022-06 | 26,234,143 | 3,011,336 | 1,802,314 | 163,673 | 32,892 | 12,609 |
| 2022-07 | 21,379,057 | 2,458,154 | 1,478,285 | 148,201 | 26,765 | 10,340 |
| 2022-08 | 19,585,608 | 2,244,912 | 1,332,769 | 132,118 | 24,587 | 9,532 |
| 2022-09 | 15,746,357 | 1,801,257 | 1,070,209 | 102,524 | 19,780 | 7,773 |
| 2022-10 | 14,661,775 | 1,667,643 | 995,643 | 91,631 | 18,427 | 7,272 |
| 2022-11 | 16,213,156 | 1,848,960 | 1,103,587 | 107,747 | 20,374 | 8,112 |
| 2022-12 | 24,122,864 | 2,769,458 | 1,652,335 | 168,233 | 30,307 | 11,791 |
| 2023-01 | 22,704,911 | 2,609,591 | 1,557,072 | 157,309 | 28,481 | 11,133 |
| 2023-02 | 23,850,858 | 2,747,264 | 1,634,608 | 163,207 | 29,911 | 11,529 |
| 2023-03 | 22,747,869 | 2,604,117 | 1,569,407 | 155,947 | 28,503 | 11,166 |
| 2023-04 | 23,756,753 | 2,740,226 | 1,634,457 | 163,471 | 29,746 | 11,532 |
| 2023-05 | 21,354,933 | 2,462,482 | 1,466,385 | 144,933 | 26,721 | 10,419 |
| 2023-06 | 24,441,978 | 2,825,397 | 1,677,383 | 169,469 | 30,582 | 11,772 |
| 2023-07 | 23,322,545 | 2,688,066 | 1,584,264 | 155,208 | 29,207 | 11,295 |
| 2023-08 | 21,725,829 | 2,512,555 | 1,481,722 | 145,127 | 27,183 | 10,587 |
| 2023-09 | 19,839,762 | 2,302,323 | 1,353,761 | 134,374 | 24,829 | 9,696 |
| 2023-10 | 19,221,092 | 2,223,726 | 1,307,341 | 125,419 | 24,048 | 9,373 |
| 2023-11 | 27,208,203 | 3,152,718 | 1,862,533 | 181,699 | 34,058 | 13,132 |
| 2023-12 | 17,792,091 | 2,047,900 | 1,215,310 | 119,491 | 22,277 | 8,705 |
| 2024-01 | 27,200,538 | 3,147,639 | 1,862,829 | 178,647 | 34,146 | 13,006 |
| 2024-02 | 20,802,166 | 2,409,943 | 1,414,349 | 142,577 | 26,039 | 10,066 |
| 2024-03 | 26,109,610 | 3,015,392 | 1,786,746 | 173,594 | 32,628 | 12,593 |
| 2024-04 | 19,222,532 | 2,220,194 | 1,307,290 | 128,951 | 24,015 | 9,385 |
| 2024-05 | 21,288,130 | 2,442,970 | 1,446,687 | 140,075 | 26,622 | 10,470 |
| 2024-06 | 23,136,619 | 2,688,072 | 1,591,094 | 158,481 | 28,987 | 11,246 |
| 2024-07 | 21,127,146 | 2,450,442 | 1,444,811 | 142,500 | 26,501 | 10,428 |
| 2024-08 | 21,379,472 | 2,478,639 | 1,457,000 | 145,990 | 26,809 | 10,462 |
| 2024-09 | 22,533,393 | 2,598,506 | 1,540,860 | 151,696 | 28,283 | 10,909 |
| 2024-10 | 20,067,463 | 2,326,664 | 1,363,418 | 136,280 | 25,170 | 9,691 |
| 2024-11 | 22,480,695 | 2,607,546 | 1,534,210 | 152,566 | 28,217 | 10,957 |
| 2024-12 | 17,953,077 | 2,064,836 | 1,222,751 | 120,097 | 22,541 | 8,860 |
| 2025-01 | 26,059,628 | 3,016,246 | 1,781,514 | 173,346 | 32,694 | 12,584 |
| 2025-02 | 20,483,467 | 2,376,214 | 1,402,037 | 139,706 | 25,676 | 9,981 |
| 2025-03 | 21,025,217 | 2,420,629 | 1,430,175 | 140,736 | 26,490 | 10,251 |
| 2025-04 | 22,158,155 | 2,558,463 | 1,510,584 | 153,796 | 27,887 | 10,713 |
| 2025-05 | 19,880,761 | 2,285,418 | 1,353,539 | 136,944 | 25,005 | 9,640 |
| 2025-06 | 20,803,274 | 2,383,392 | 1,429,537 | 141,512 | 26,193 | 10,211 |
| 2025-07 | 23,149,471 | 2,661,883 | 1,576,347 | 159,275 | 29,042 | 11,216 |
| 2025-08 | 23,228,399 | 2,665,471 | 1,579,954 | 163,652 | 29,163 | 11,328 |
| 2025-09 | 26,343,358 | 3,036,242 | 1,796,219 | 181,777 | 33,123 | 12,773 |
| 2025-10 | 26,186,810 | 3,012,110 | 1,788,795 | 180,515 | 32,925 | 12,689 |
| 2025-11 | 21,571,774 | 2,477,266 | 1,471,032 | 146,384 | 27,249 | 10,640 |
| 2025-12 | 18,647,954 | 2,118,472 | 1,264,299 | 122,949 | 23,432 | 9,148 |
| 2026-01 | 23,584,294 | 2,700,939 | 1,606,624 | 158,040 | 29,625 | 11,380 |
| 2026-02 | 19,154,878 | 2,196,353 | 1,300,027 | 128,506 | 24,070 | 9,309 |
| 2026-03 | 21,162,141 | 2,432,677 | 1,434,262 | 139,414 | 26,545 | 10,254 |
| 2026-04 | 21,899,400 | 2,514,688 | 1,490,128 | 144,631 | 27,436 | 10,577 |
| 2026-05 | 21,678,014 | 2,511,585 | 1,469,835 | 146,805 | 27,282 | 10,543 |
| 2026-06 | 9,775,740 | 1,125,507 | 671,647 | 63,235 | 12,245 | 4,786 |
| 2026-07 | 3,824,247 | 440,306 | 259,422 | 22,279 | 4,787 | 1,935 |
| 2026-08 partial | 2,951,596 | 376,394 | 192,296 | 18,780 | 3,599 | 1,318 |

The 68 monthly payload totals, excluding the shared manifest, are:

| Option | Raw bytes | Gzip bytes | Largest raw month | Largest gzip month |
|---|---:|---:|---|---|
| Full page | 1,290,784,047 | 148,362,492 | 2023-11: 27,208,203 | 2023-11: 3,152,718 |
| Match-only summary | 88,248,288 | 8,644,307 | 2024-01: 1,862,829 | 2025-09: 181,777 |
| IDs-only unavailable state | 1,619,358 | 629,295 | 2024-01: 34,146 | 2023-11: 13,132 |

Including the 4,897-byte raw / 1,083-byte gzipped shared manifest gives deployment payload
totals of 1,290,788,944 / 148,363,575 bytes, 88,253,185 / 8,645,390 bytes, and 1,624,255 /
630,378 bytes respectively. Each option adds 69 deployment files: 68 monthly payloads plus
the manifest.

**Decision:** use the match-only summary. For v1, “reachable” means a meaningful historical
destination containing teams, result, score, league, duration, patch, and date, but not
boxscores, draft, or advantage graph. IDs-only is rejected because a recognized-unavailable
notice is not a meaningful destination. Full-page monthly JSON is rejected because four
measured months exceed the platform's 25 MiB asset limit and three more are within 1% below
it: 2024-03 (26,109,610 bytes), 2025-01 (26,059,628), and 2025-10 (26,186,810). The match-only
payload contract is the complete match row excluding `radiant_gold_adv` and
`radiant_xp_adv`.

### Cloudflare Pages constraints checked 2026-08-31

Cloudflare's official [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
page states that Free sites may contain 20,000 files, paid plans may contain 100,000 when the
documented setting is enabled, each asset may be at most 25 MiB (26,214,400 bytes), and builds
time out after 20 minutes. All three options add only 69 files and therefore fit the file-count
limit. Match-only and IDs-only fit the individual asset limit. Full-page JSON as measured is
ruled out: 2022-06 (26,234,143), 2023-11 (27,208,203), 2024-01 (27,200,538), and 2025-09
(26,343,358) each exceed 25 MiB raw. Three additional months are within 1% below the cap, as
listed in the decision above. Serving precompressed or split payloads would be a different
design requiring its own decision and measurement. The timeout does not directly rule out
the selected summary option; actual generation time remains a step-level acceptance
measurement.

### Canonical v1 implementation sequence

These steps continue the canonical numbering in `AGENTS.md`.

10. **Static-site scaffold.** Add the pinned Node/Astro toolchain, static-output configuration,
    minimal page shell, and package scripts. Approval gate: a clean install and production
    build succeed from scratch and emit a runnable static index without reading live APIs.
11. **Local data catalog and query layer.** Add DuckDB-backed readers that UNION Parquet, hot
    NDJSON, and late NDJSON, use explicit UTC cutoffs, prune shards/columns, and expose tested
    home/detail queries. Approval gate: an offline audit reproduces the committed match, tier,
    and duplicate counts in this appendix. For an injected clock, it also computes each
    30/90/180-day window through the query layer and through an independent unpruned scan of
    every committed match shard, then asserts equal totals and tier counts. Window counts are
    reported rather than pinned because they move with each ingest run.
    `detail()` scans regular match shards sequentially, followed by late shards, without
    `match_id` range pruning, so an arbitrary old ID costs one query per shard until found.
    Match-ID ranges are non-overlapping and month-ordered across all committed monthly shards,
    so single-candidate routing is available if a build path ever needs it; step 15 already
    owns the range manifest. This is a recorded cost property, not a step 11 defect to fix.
    Completion gate: reproduce 146,875 matches across 67 backfilled months in 75,620,523
    bytes; tier totals of 110,786 professional, 12,718 premium, and 23,371 excluded; 1,367
    matches with no draft rows; and exactly one match with a player row count other than ten.
    Successful query execution alone is insufficient.
12. **Reference and presentation model.** Resolve teams, leagues, players, and heroes with
    denormalized-name fallbacks and explicit missing-logo/name states; define a shared match
    summary model used by both page types. Hero icons use the single exported base URL
    `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/`; derive the
    filename from the reference hero's machine name and do not download icon files. Approval
    gate: scan every committed match shard and assert that every team slot has a defined,
    non-empty display state and an explicit available/missing logo state, every league and
    draft hero resolves, and resolved display names are trimmed and non-empty. Report observed
    null-ID, unusable-name, missing-reference, and missing-logo counts without pinning them,
    because scheduled ingest and weekly reference refreshes can change those counts.
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
    per committed monthly match shard at gate time plus the range manifest, then use them to
    render the client-side summary for older IDs. Approval gate: generated payload count
    equals the committed monthly match-shard count at gate time; payloads exclude both
    advantage arrays; raw and gzipped byte totals are derived across all committed monthly
    match shards at gate time; known old IDs—including
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
