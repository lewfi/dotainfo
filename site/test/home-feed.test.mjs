import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createCatalog, readableShards } from '../src/data/catalog.mjs';
import { buildClockEpoch } from '../src/data/clock.mjs';
import { openDuckDB, queryRows, sourceUnionSql } from '../src/data/duckdb.mjs';
import { DataReader } from '../src/data/queries.mjs';
import { ReferenceResolver } from '../src/data/references.mjs';
import {
  DEFAULT_HOME_TIERS,
  createHomeFeedViews,
} from '../src/presentation/home-feed.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/home-feed/', import.meta.url));
const CLOCK = '2026-02-02T00:00:00Z';

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function directTierPredicate(tiers) {
  if (tiers === null) return 'TRUE';
  const values = tiers.filter((tier) => tier !== null);
  const clauses = [];
  if (values.length > 0) {
    clauses.push(`league_tier IN (${values.map(sqlString).join(', ')})`);
  }
  if (tiers.includes(null)) clauses.push('league_tier IS NULL');
  return clauses.length === 0 ? 'FALSE' : `(${clauses.join(' OR ')})`;
}

function sortedTierCounts(rows) {
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

async function homeFixtureRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dotainfo-step13-home-'));
  assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'matches');
  await mkdir(target, { recursive: true });
  for (const name of await readdir(path.join(FIXTURES, 'matches'))) {
    await copyFile(path.join(FIXTURES, 'matches', name), path.join(target, name));
  }
  return root;
}

async function directView(connection, catalog, { clock, limit, tiers }) {
  const endEpoch = buildClockEpoch(clock);
  const union = sourceUnionSql(
    readableShards(catalog, 'matches'),
    'matches',
    ['match_id', 'start_time', 'league_tier'],
  );
  const rows = await queryRows(
    connection,
    `SELECT * FROM (\n${union}\n) AS all_rows `
      + `WHERE start_time < ${endEpoch} AND ${directTierPredicate(tiers)} `
      + `ORDER BY start_time DESC, match_id DESC LIMIT ${limit}`,
  );
  const startEpoch = rows.at(-1)?.start_time ?? endEpoch;
  const rangeRows = await queryRows(
    connection,
    `SELECT league_tier FROM (\n${union}\n) AS all_rows `
      + `WHERE start_time >= ${startEpoch} AND start_time < ${endEpoch}`,
  );
  return { rows, startEpoch, endEpoch, tierCounts: sortedTierCounts(rangeRows) };
}

test('filtered home query widens into older shards until it finds the matching limit', async (t) => {
  const dataRoot = await homeFixtureRoot(t);
  const catalog = await createCatalog({ dataRoot });
  const reader = await DataReader.create(catalog);
  t.after(() => reader.close());

  const result = await reader.home({
    clock: CLOCK,
    limit: 3,
    tiers: DEFAULT_HOME_TIERS,
  });

  assert.deepEqual(result.rows.map((row) => row.match_id), [3002, 3001, 3000]);
  assert.deepEqual(result.sources, [
    'matches/2026-01.ndjson',
    'matches/2025-12.ndjson',
  ]);
  assert.equal(result.hiddenCount, 2);
});

test('home query applies the injected upper cutoff to every selected shard', async (t) => {
  const dataRoot = await homeFixtureRoot(t);
  const catalog = await createCatalog({ dataRoot });
  const reader = await DataReader.create(catalog);
  t.after(() => reader.close());

  const result = await reader.home({
    clock: '2026-01-30T00:00:00Z',
    limit: 10,
    tiers: null,
  });

  assert.deepEqual(result.rows.map((row) => row.match_id), [3002, 3001, 3000]);
  assert.ok(result.rows.every((row) => row.start_time < result.range.endEpoch));
});

test('home views match an offline query by ordering and range-scoped tier counts', async (t) => {
  const dataRoot = await homeFixtureRoot(t);
  const catalog = await createCatalog({ dataRoot });
  const reader = await DataReader.create(catalog);
  t.after(() => reader.close());
  const references = new ReferenceResolver();
  const home = await createHomeFeedViews({
    reader,
    references,
    clock: CLOCK,
    limit: 3,
  });

  assert.deepEqual(home.availableTiers, [
    'excluded',
    'future-tier',
    'premium',
    'professional',
  ]);
  assert.deepEqual(home.views.map((view) => view.id), [
    'all',
    'top',
    'pro',
    'amateur',
    'other',
  ]);
  const other = home.views.find((view) => view.id === 'other');
  assert.deepEqual(other.selectedTiers, ['excluded', 'future-tier']);
  assert.ok(other.matches.some((match) => match.league.tier.value === 'future-tier'));
  assert.equal(other.label, 'Other');
  assert.ok(home.views.every((view) => view.days.length > 0 || view.matches.length === 0));
  assert.ok(home.views.flatMap((view) => view.days).every((day) => (
    day.leagues.flatMap((league) => league.matches).length === day.count
  )));

  const database = await openDuckDB();
  t.after(() => database.close());
  for (const view of home.views) {
    const expected = await directView(database.connection, catalog, {
      clock: CLOCK,
      limit: 3,
      tiers: view.selectedTiers,
    });
    assert.deepEqual(
      view.matches.map((match) => match.matchId),
      expected.rows.map((row) => row.match_id),
      `${view.id} ordering`,
    );
    assert.deepEqual(view.tierCounts, expected.tierCounts, `${view.id} tier counts`);
    assert.deepEqual(view.range, {
      startEpoch: expected.startEpoch,
      endEpoch: expected.endEpoch,
    });
  }
});
