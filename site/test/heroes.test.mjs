import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadHeroCollection } from '../src/data/heroes.mjs';
import { openDuckDB } from '../src/data/duckdb.mjs';

function sqlPath(filePath) {
  return `'${filePath.replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

async function writeNdjson(filename, rows) {
  await writeFile(filename, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

async function heroFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dotainfo-step26-'));
  const resolvedTemp = path.resolve(tmpdir());
  assert.ok(path.resolve(root).startsWith(`${resolvedTemp}${path.sep}`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  for (const table of ['matches', 'draft', 'players', 'reference']) {
    await mkdir(path.join(root, table), { recursive: true });
  }

  await writeNdjson(path.join(root, 'matches', '2026-01.ndjson'), [
    { match_id: 1, start_time: 1767225600, radiant_win: true, patch: '7.40' },
    { match_id: 2, start_time: 1767225700, radiant_win: false, patch: '7.41' },
    { match_id: 3, start_time: 1767225800, radiant_win: null, patch: '7.41' },
    { match_id: 4, start_time: 1767225900, radiant_win: true, patch: '7.41' },
  ]);
  await writeNdjson(path.join(root, 'draft', '2026-01.ndjson'), [
    { match_id: 1, is_pick: true, hero_id: 1, team: 0, ord: 0 },
    { match_id: 1, is_pick: false, hero_id: 2, team: 1, ord: 1 },
    { match_id: 2, is_pick: true, hero_id: 1, team: 0, ord: 0 },
    { match_id: 2, is_pick: true, hero_id: 2, team: 1, ord: 1 },
    { match_id: 3, is_pick: true, hero_id: 1, team: 1, ord: 0 },
    { match_id: 3, is_pick: false, hero_id: 2, team: 0, ord: 1 },
  ]);
  await writeNdjson(path.join(root, 'players', '2026-01.ndjson'), [
    { match_id: 1, hero_id: 1, lane_role: 1 },
    { match_id: 1, hero_id: 2, lane_role: 2 },
    { match_id: 2, hero_id: 1, lane_role: 2 },
    { match_id: 2, hero_id: 2, lane_role: 3 },
    { match_id: 3, hero_id: 1, lane_role: null },
  ]);
  const referenceSeed = path.join(root, 'reference', 'heroes.ndjson');
  await writeNdjson(referenceSeed, [
    { id: 1, name: 'npc_dota_hero_antimage', localized_name: 'Anti-Mage', primary_attr: 'agi', attack_type: 'Melee', roles: ['Carry', 'Escape'] },
    { id: 2, name: 'npc_dota_hero_axe', localized_name: 'Axe', primary_attr: 'str', attack_type: 'Melee', roles: ['Initiator', 'Durable'] },
  ]);
  const database = await openDuckDB();
  try {
    await database.connection.run(`
      COPY (SELECT * FROM read_json_auto(${sqlPath(referenceSeed)}, format = 'newline_delimited'))
      TO ${sqlPath(path.join(root, 'reference', 'heroes.parquet'))} (FORMAT PARQUET)
    `);
  } finally {
    database.close();
  }
  return root;
}

test('hero collection keeps draft-less matches and null-result picks in their correct populations', async (t) => {
  const dataRoot = await heroFixture(t);
  const collection = await loadHeroCollection({
    dataRoot,
    referenceRoot: path.join(dataRoot, 'reference'),
  });
  const antiMage = collection.heroes.find((hero) => hero.heroId === 1);
  const axe = collection.heroes.find((hero) => hero.heroId === 2);

  assert.equal(collection.totalMatches, 4);
  assert.equal(collection.draftMatchCount, 3);
  assert.equal(collection.totalDraftRows, 6);
  assert.equal(collection.totalPicks, 4);
  assert.equal(collection.totalBans, 2);
  assert.equal(antiMage.pickCount, 3);
  assert.equal(antiMage.winEligiblePicks, 2);
  assert.equal(antiMage.wins, 1);
  assert.equal(antiMage.pickRate, 1);
  assert.equal(antiMage.winRate, 0.5);
  assert.equal(axe.pickCount, 1);
  assert.equal(axe.banCount, 2);
  assert.equal(axe.wins, 1);
});

test('hero collection exposes every patch, reference field, and lane-role row', async (t) => {
  const dataRoot = await heroFixture(t);
  const collection = await loadHeroCollection({
    dataRoot,
    referenceRoot: path.join(dataRoot, 'reference'),
  });
  const antiMage = collection.heroes.find((hero) => hero.heroId === 1);

  assert.deepEqual(collection.patches.map((patch) => patch.key), ['7.40', '7.41']);
  assert.deepEqual(antiMage.trends.map((trend) => trend.pickCount), [1, 2]);
  assert.deepEqual(antiMage.lanes.map((lane) => [lane.key, lane.appearances]), [
    ['1', 1],
    ['2', 1],
    ['unavailable', 1],
  ]);
  assert.equal(antiMage.attackType, 'Melee');
  assert.deepEqual(antiMage.roles, ['Carry', 'Escape']);
  assert.equal(antiMage.title, 'Anti-Mage hero — DotaInfo');
  assert.deepEqual(collection.groups.map((group) => group.id), ['str', 'agi']);
});
