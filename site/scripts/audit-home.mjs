import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import { createCatalog, readableShards } from '../src/data/catalog.mjs';
import { buildClockEpoch } from '../src/data/clock.mjs';
import { openDuckDB, queryRows, sourceUnionSql } from '../src/data/duckdb.mjs';
import { DataReader } from '../src/data/queries.mjs';
import { loadReferences } from '../src/data/references.mjs';
import { createHomeFeedViews } from '../src/presentation/home-feed.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tierPredicate(tiers) {
  if (tiers === null) return 'TRUE';
  const values = tiers.filter((tier) => tier !== null);
  const clauses = [];
  if (values.length > 0) {
    clauses.push(`league_tier IN (${values.map(sqlString).join(', ')})`);
  }
  if (tiers.includes(null)) clauses.push('league_tier IS NULL');
  return clauses.length === 0 ? 'FALSE' : `(${clauses.join(' OR ')})`;
}

function tierSelected(tier, tiers) {
  return tiers === null || tiers.includes(tier);
}

function tierCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.league_tier, (counts.get(row.league_tier) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => {
      if (left === null) return 1;
      if (right === null) return -1;
      return left.localeCompare(right);
    })
    .map(([tier, count]) => ({ tier, count }));
}

async function directHome(connection, catalog, { clock, limit, tiers }) {
  const endEpoch = buildClockEpoch(clock);
  const union = sourceUnionSql(
    readableShards(catalog, 'matches'),
    'matches',
    ['match_id', 'start_time', 'league_tier'],
  );
  const rows = await queryRows(
    connection,
    `SELECT * FROM (\n${union}\n) AS all_rows `
      + `WHERE start_time < ${endEpoch} AND ${tierPredicate(tiers)} `
      + `ORDER BY start_time DESC, match_id DESC LIMIT ${limit}`,
  );
  const startEpoch = rows.at(-1)?.start_time ?? endEpoch;
  const rangeRows = await queryRows(
    connection,
    `SELECT league_tier FROM (\n${union}\n) AS all_rows `
      + `WHERE start_time >= ${startEpoch} AND start_time < ${endEpoch}`,
  );
  return Object.freeze({
    matchIds: Object.freeze(rows.map((row) => row.match_id)),
    tierCounts: Object.freeze(tierCounts(rangeRows)),
    hiddenCount: rangeRows.reduce(
      (count, row) => count + (tierSelected(row.league_tier, tiers) ? 0 : 1),
      0,
    ),
    range: Object.freeze({ startEpoch, endEpoch }),
  });
}

const clock = argument('--clock');
const limit = Number(argument('--limit') ?? 100);
if (!clock || !Number.isInteger(limit) || limit <= 0) {
  console.error('usage: npm run audit:home -- --clock YYYY-MM-DDTHH:mm:ssZ [--limit N]');
  process.exit(2);
}

const catalog = await createCatalog();
const references = await loadReferences();
const reader = await DataReader.create(catalog);
let home;
try {
  home = await createHomeFeedViews({ reader, references, clock, limit });
} finally {
  reader.close();
}

const database = await openDuckDB();
const comparisons = [];
try {
  for (const view of home.views.slice(0, 2)) {
    const direct = await directHome(database.connection, catalog, {
      clock,
      limit,
      tiers: view.selectedTiers,
    });
    const rendered = Object.freeze({
      matchIds: Object.freeze(view.matches.map((match) => match.matchId)),
      tierCounts: view.tierCounts,
      hiddenCount: view.hiddenCount,
      range: view.range,
    });
    comparisons.push(Object.freeze({ id: view.id, rendered, direct }));
    console.log(`STEP13_${view.id.toUpperCase()}_RENDERED=${JSON.stringify(rendered)}`);
    console.log(`STEP13_${view.id.toUpperCase()}_DIRECT=${JSON.stringify(direct)}`);
  }
} finally {
  database.close();
}

const defaultComparison = comparisons.find((comparison) => comparison.id === 'default');
const allComparison = comparisons.find((comparison) => comparison.id === 'all');
const assertions = Object.freeze({
  defaultHasRequestedLimit: defaultComparison.rendered.matchIds.length === limit,
  allHasRequestedLimit: allComparison.rendered.matchIds.length === limit,
  defaultOrderingMatchesOfflineQuery: isDeepStrictEqual(
    defaultComparison.rendered.matchIds,
    defaultComparison.direct.matchIds,
  ),
  allOrderingMatchesOfflineQuery: isDeepStrictEqual(
    allComparison.rendered.matchIds,
    allComparison.direct.matchIds,
  ),
  defaultTierCountsMatchOfflineQuery: isDeepStrictEqual(
    defaultComparison.rendered.tierCounts,
    defaultComparison.direct.tierCounts,
  ),
  allTierCountsMatchOfflineQuery: isDeepStrictEqual(
    allComparison.rendered.tierCounts,
    allComparison.direct.tierCounts,
  ),
  defaultHiddenCountMatchesOfflineQuery:
    defaultComparison.rendered.hiddenCount === defaultComparison.direct.hiddenCount,
  allHiddenCountMatchesOfflineQuery:
    allComparison.rendered.hiddenCount === allComparison.direct.hiddenCount,
});

console.log(`STEP13_CLOCK=${clock}`);
console.log(`STEP13_LIMIT=${limit}`);
console.log(`STEP13_AVAILABLE_TIERS=${JSON.stringify(home.availableTiers)}`);
console.log(`STEP13_ASSERTIONS=${JSON.stringify(assertions)}`);
assert.ok(Object.values(assertions).every(Boolean), 'Step 13 home assertions failed');
console.log('STEP13_STATUS=PASS');
