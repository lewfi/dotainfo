import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createCatalog, lateShards } from '../src/data/catalog.mjs';
import { buildClockEpoch } from '../src/data/clock.mjs';
import { directWindowAudit } from '../src/data/direct-window-audit.mjs';
import { openDuckDB } from '../src/data/duckdb.mjs';
import { DataReader } from '../src/data/queries.mjs';
import { HOME_COLUMNS } from '../src/data/schema.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/catalog/', import.meta.url));
const TABLES = ['matches', 'players', 'draft'];

function sqlPath(filePath) {
  return `'${filePath.replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

async function copyFixtureGroup(group, dataRoot) {
  for (const table of TABLES) {
    const sourceDirectory = path.join(FIXTURES, group, table);
    const targetDirectory = path.join(dataRoot, table);
    await mkdir(targetDirectory, { recursive: true });
    for (const name of await readdir(sourceDirectory)) {
      await copyFile(path.join(sourceDirectory, name), path.join(targetDirectory, name));
    }
  }
}

async function fixtureDataRoot(t, { withLate }) {
  const root = await mkdtemp(path.join(tmpdir(), 'dotainfo-step11-'));
  const resolvedTemp = path.resolve(tmpdir());
  assert.ok(path.resolve(root).startsWith(`${resolvedTemp}${path.sep}`));
  t.after(async () => rm(root, { recursive: true, force: true }));

  await copyFixtureGroup('hot', root);
  if (withLate) {
    await copyFixtureGroup('late', root);
  }

  const database = await openDuckDB();
  try {
    for (const table of TABLES) {
      const source = path.join(FIXTURES, 'parquet-seed', table, '2025-12.ndjson');
      const target = path.join(root, table, '2025-12.parquet');
      await database.connection.run(`
        COPY (
          SELECT * FROM read_json_auto(${sqlPath(source)}, format = 'newline_delimited')
        ) TO ${sqlPath(target)} (FORMAT PARQUET)
      `);
    }
  } finally {
    database.close();
  }
  return root;
}

async function precedenceFixtureDataRoot(t) {
  const root = await fixtureDataRoot(t, { withLate: true });
  await copyFile(
    path.join(FIXTURES, 'precedence', 'matches', 'late.ndjson'),
    path.join(root, 'matches', 'late.ndjson'),
  );
  return root;
}

async function boundaryFixtureDataRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dotainfo-step11-boundaries-'));
  const resolvedTemp = path.resolve(tmpdir());
  assert.ok(path.resolve(root).startsWith(`${resolvedTemp}${path.sep}`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  for (const table of TABLES) {
    await mkdir(path.join(root, table), { recursive: true });
  }
  await copyFile(
    path.join(FIXTURES, 'late', 'matches', 'late.ndjson'),
    path.join(root, 'matches', 'late.ndjson'),
  );

  const database = await openDuckDB();
  try {
    const seedRoot = path.join(FIXTURES, 'window-boundaries', 'matches');
    for (const seedName of await readdir(seedRoot)) {
      const source = path.join(seedRoot, seedName);
      const target = path.join(root, 'matches', seedName.replace('.ndjson', '.parquet'));
      await database.connection.run(`
        COPY (
          SELECT * FROM read_json_auto(${sqlPath(source)}, format = 'newline_delimited')
        ) TO ${sqlPath(target)} (FORMAT PARQUET)
      `);
    }
  } finally {
    database.close();
  }
  return root;
}

test('catalog accepts an absent late-arrival shard', async (t) => {
  const dataRoot = await fixtureDataRoot(t, { withLate: false });
  const catalog = await createCatalog({ dataRoot });

  for (const table of TABLES) {
    assert.equal(lateShards(catalog, table).length, 0);
    assert.deepEqual(
      catalog.tables[table].map((shard) => shard.name),
      ['2025-12.parquet', '2026-01.ndjson'],
    );
  }
});

test('home query unions Parquet, hot NDJSON, and present late NDJSON', async (t) => {
  const dataRoot = await fixtureDataRoot(t, { withLate: true });
  const catalog = await createCatalog({ dataRoot });
  const reader = await DataReader.create(catalog);
  t.after(() => reader.close());

  const all = await reader.home({ limit: 10 });
  assert.deepEqual(all.rows.map((row) => row.match_id), [2002, 1500, 2001, 1001]);
  assert.deepEqual(Object.keys(all.rows[0]), HOME_COLUMNS);
  assert.deepEqual(all.sources, [
    'matches/late.ndjson',
    'matches/2026-01.ndjson',
    'matches/2025-12.parquet',
  ]);

  const newest = await reader.home({ limit: 1 });
  assert.deepEqual(newest.rows.map((row) => row.match_id), [2002]);
  assert.deepEqual(newest.sources, [
    'matches/late.ndjson',
    'matches/2026-01.ndjson',
  ]);
});

test('detail query prunes child reads to the located UTC month when late is absent', async (t) => {
  const dataRoot = await fixtureDataRoot(t, { withLate: false });
  const catalog = await createCatalog({ dataRoot });
  const reader = await DataReader.create(catalog);
  t.after(() => reader.close());

  const detail = await reader.detail(1001);
  assert.equal(detail.match.match_id, 1001);
  assert.deepEqual(detail.match.radiant_gold_adv, [0, 100]);
  assert.deepEqual(detail.players.map((row) => row.match_id), [1001]);
  assert.deepEqual(detail.draft.map((row) => row.match_id), [1001]);
  assert.deepEqual(detail.sources.matches, [
    'matches/2026-01.ndjson',
    'matches/2025-12.parquet',
  ]);
  assert.deepEqual(detail.sources.players, ['players/2025-12.parquet']);
  assert.deepEqual(detail.sources.draft, ['draft/2025-12.parquet']);

  const noDraft = await reader.detail(2001);
  assert.deepEqual(noDraft.draft, []);
  assert.equal(await reader.detail(9999), null);
});

test('detail query reads the present late-arrival fixture', async (t) => {
  const dataRoot = await fixtureDataRoot(t, { withLate: true });
  const catalog = await createCatalog({ dataRoot });
  const reader = await DataReader.create(catalog);
  t.after(() => reader.close());

  const detail = await reader.detail(1500);
  assert.equal(detail.match.match_id, 1500);
  assert.deepEqual(detail.players.map((row) => row.account_id), [5500]);
  assert.deepEqual(detail.draft.map((row) => row.hero_id), [4]);
  assert.deepEqual(detail.sources.matches, [
    'matches/2026-01.ndjson',
    'matches/2025-12.parquet',
    'matches/late.ndjson',
  ]);
  assert.ok(detail.sources.players.includes('players/late.ndjson'));
  assert.ok(detail.sources.draft.includes('draft/late.ndjson'));
});

test('detail query gives a regular REST row precedence over a duplicate late row', async (t) => {
  const dataRoot = await precedenceFixtureDataRoot(t);
  const catalog = await createCatalog({ dataRoot });
  const reader = await DataReader.create(catalog);
  t.after(() => reader.close());

  const detail = await reader.detail(1001);
  assert.equal(detail.match.league_name, 'Seed League');
  assert.equal(detail.match.duration, 1800);
  assert.deepEqual(detail.match.radiant_gold_adv, [0, 100]);
  assert.deepEqual(detail.match.radiant_xp_adv, [0, 80]);
  assert.deepEqual(detail.sources.matches, [
    'matches/2026-01.ndjson',
    'matches/2025-12.parquet',
  ]);
});

test('window query uses injected UTC half-open cutoffs and month pruning', async (t) => {
  const dataRoot = await fixtureDataRoot(t, { withLate: true });
  const catalog = await createCatalog({ dataRoot });
  const reader = await DataReader.create(catalog);
  t.after(() => reader.close());

  const clock = '2026-01-31T00:00:00Z';
  const [thirty, ninety] = await reader.windows({ clock, days: [30, 90] });
  assert.deepEqual(
    { count: thirty.count, tiers: thirty.tiers },
    { count: 3, tiers: { premium: 1, excluded: 1, professional: 1 } },
  );
  assert.deepEqual(thirty.sources, [
    'matches/2026-01.ndjson',
    'matches/late.ndjson',
  ]);
  assert.equal(ninety.count, 4);
  assert.ok(ninety.sources.includes('matches/2025-12.parquet'));
  assert.throws(() => buildClockEpoch('2026-01-31T00:00:00'), /ending in Z/);
});

test('window query filters rows across both straddling boundary months', async (t) => {
  const dataRoot = await boundaryFixtureDataRoot(t);
  const catalog = await createCatalog({ dataRoot });
  const reader = await DataReader.create(catalog);
  t.after(() => reader.close());

  const clock = '2026-01-15T00:00:00Z';
  const queryResult = await reader.window({ clock, days: 30 });
  const [directResult] = await directWindowAudit({
    clock,
    days: [30],
    matchRoot: path.join(dataRoot, 'matches'),
  });

  assert.equal(queryResult.startEpoch, 1765843200);
  assert.equal(queryResult.endEpoch, 1768435200);
  assert.deepEqual(
    { count: queryResult.count, tiers: queryResult.tiers },
    { count: 3, tiers: { professional: 2, premium: 1 } },
  );
  assert.deepEqual(
    { count: directResult.count, tiers: directResult.tiers },
    { count: 3, tiers: { professional: 2, premium: 1 } },
  );
});
