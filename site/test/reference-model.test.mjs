import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openDuckDB } from '../src/data/duckdb.mjs';
import {
  HERO_ICON_BASE_URL,
  ReferenceResolver,
  loadReferences,
} from '../src/data/references.mjs';
import { createMatchSummary } from '../src/presentation/match-summary.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/references/', import.meta.url));

function sqlPath(filePath) {
  return `'${filePath.replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

async function referenceFixtureRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dotainfo-step12-references-'));
  const resolvedTemp = path.resolve(tmpdir());
  assert.ok(path.resolve(root).startsWith(`${resolvedTemp}${path.sep}`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });

  const database = await openDuckDB();
  try {
    for (const seedName of await readdir(FIXTURES)) {
      const source = path.join(FIXTURES, seedName);
      const target = path.join(root, seedName.replace('.ndjson', '.parquet'));
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

test('reference Parquet loads all four indexes without filtering nullable is_pro rows', async (t) => {
  const referenceRoot = await referenceFixtureRoot(t);
  const references = await loadReferences({ referenceRoot });

  assert.deepEqual(references.counts, { teams: 3, leagues: 2, players: 2, heroes: 2 });
  const player = references.resolvePlayer(100);
  assert.equal(player.referenceFound, true);
  assert.equal(player.name.display, 'Alice');
  assert.equal(player.fantasyRole, 2);
  assert.equal(player.isPro, null);
  assert.equal(player.team.teamId, 1);
});

test('team resolution trims names and exposes explicit fallback and no-logo states', () => {
  const references = new ReferenceResolver({
    teams: [
      { team_id: 1, name: ' Current Name ', tag: 'TAG', logo_url: ' https://logo.test/1 ' },
      { team_id: 2, name: '  ', tag: null, logo_url: ' ' },
      { team_id: 3, name: ' ', tag: ' RECOVERED ', logo_url: null },
      { team_id: 4, name: '', tag: '  ', logo_url: null },
    ],
  });

  const current = references.resolveTeam({ teamId: 1, denormalizedName: 'Snapshot Name' });
  assert.equal(current.name.display, 'Current Name');
  assert.equal(current.name.source, 'reference-current');
  assert.deepEqual(current.logo, { status: 'available', url: 'https://logo.test/1' });

  const snapshot = references.resolveTeam({ teamId: 2, denormalizedName: ' Snapshot Name ' });
  assert.equal(snapshot.name.display, 'Snapshot Name');
  assert.equal(snapshot.name.source, 'match-write-time');
  assert.deepEqual(snapshot.logo, { status: 'missing', url: null });

  const absentReference = references.resolveTeam({
    teamId: 999,
    denormalizedName: ' Unreferenced Snapshot ',
  });
  assert.equal(absentReference.referenceFound, false);
  assert.equal(absentReference.name.display, 'Unreferenced Snapshot');
  assert.deepEqual(absentReference.logo, { status: 'missing', url: null });

  const tagFallback = references.resolveTeam({ teamId: 3, denormalizedName: '\t' });
  assert.equal(tagFallback.name.status, 'available');
  assert.equal(tagFallback.name.display, 'RECOVERED');
  assert.equal(tagFallback.name.source, 'reference-tag');

  const noNameOrTag = references.resolveTeam({ teamId: 4, denormalizedName: ' ' });
  assert.equal(noNameOrTag.name.status, 'missing');
  assert.equal(noNameOrTag.name.display, 'Team name unavailable');
  assert.equal(noNameOrTag.name.source, null);

  const missing = references.resolveTeam({ teamId: null, denormalizedName: ' \t ' });
  assert.equal(missing.name.status, 'missing');
  assert.equal(missing.name.display, 'Team name unavailable');
  assert.deepEqual(missing.logo, { status: 'missing', url: null });
});

test('league, player, and hero resolution preserve open and undocumented values', () => {
  const references = new ReferenceResolver({
    leagues: [{ leagueid: 10, name: 'League', tier: 'reference-tier', banner: null }],
    players: [
      {
        account_id: 100,
        name: 'Player',
        fantasy_role: 7,
        is_pro: null,
        team_id: null,
      },
    ],
    heroes: [
      {
        id: 1,
        name: 'npc_dota_hero_antimage',
        localized_name: 'Anti-Mage',
        roles: ['Carry'],
      },
    ],
  });

  const league = references.resolveLeague({
    leagueId: 10,
    denormalizedName: 'Snapshot League',
    leagueTier: 'future-tier-not-in-an-enum',
  });
  assert.equal(league.tier.display, 'future-tier-not-in-an-enum');
  assert.equal(league.tier.source, 'match-write-time');
  const fallbackLeague = references.resolveLeague({
    leagueId: 999,
    denormalizedName: ' Snapshot League ',
    leagueTier: 'another-new-tier',
  });
  assert.equal(fallbackLeague.referenceFound, false);
  assert.equal(fallbackLeague.name.display, 'Snapshot League');
  assert.equal(fallbackLeague.name.source, 'match-write-time');

  const player = references.resolvePlayer(100);
  assert.equal(player.referenceFound, true);
  assert.equal(player.fantasyRole, 7);
  assert.equal(player.isPro, null);
  assert.equal(references.resolvePlayer(999).name.status, 'missing');

  const hero = references.resolveHero(1);
  assert.equal(hero.name.display, 'Anti-Mage');
  assert.equal(
    hero.icon.url,
    'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/antimage.png',
  );
  assert.equal(
    HERO_ICON_BASE_URL,
    'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/',
  );
  assert.deepEqual(references.resolveHero(999).icon, { status: 'missing', url: null });
});

test('one shared summary definition covers teams, result, score, league, duration, patch, and date', () => {
  const references = new ReferenceResolver({
    teams: [
      { team_id: 1, name: 'Radiant', logo_url: null },
      { team_id: 2, name: '', logo_url: 'https://logo.test/dire' },
    ],
    leagues: [{ leagueid: 10, name: 'League', tier: 'professional', banner: null }],
  });
  const summary = createMatchSummary(
    {
      match_id: 123,
      start_time: 1767225600,
      duration: 1800,
      leagueid: 10,
      league_name: 'League Snapshot',
      league_tier: 'new-tier',
      radiant_team_id: 1,
      dire_team_id: 2,
      radiant_team_name: 'Radiant Snapshot',
      dire_team_name: 'Dire Snapshot',
      radiant_win: false,
      radiant_score: 12,
      dire_score: 22,
      patch: ' 7.41 ',
    },
    references,
  );

  assert.deepEqual(Object.keys(summary), [
    'matchId',
    'teams',
    'result',
    'score',
    'league',
    'duration',
    'patch',
    'date',
  ]);
  assert.equal(summary.teams.radiant.name.display, 'Radiant');
  assert.equal(summary.teams.dire.name.display, 'Dire Snapshot');
  assert.equal(summary.result.winner, 'dire');
  assert.deepEqual(summary.score, { status: 'available', radiant: 12, dire: 22 });
  assert.equal(summary.league.tier.display, 'new-tier');
  assert.deepEqual(summary.duration, { status: 'available', value: 1800 });
  assert.equal(summary.patch.display, '7.41');
  assert.equal(summary.date.isoUtc, '2026-01-01T00:00:00.000Z');

  const incomplete = createMatchSummary(
    {
      match_id: 124,
      start_time: 1767225600,
      duration: null,
      leagueid: 10,
      league_name: 'League Snapshot',
      league_tier: 'new-tier',
      radiant_team_id: null,
      dire_team_id: null,
      radiant_team_name: null,
      dire_team_name: null,
      radiant_win: null,
      radiant_score: null,
      dire_score: null,
      patch: null,
    },
    references,
  );
  assert.deepEqual(incomplete.result, { status: 'missing', winner: null });
  assert.deepEqual(incomplete.score, { status: 'missing', radiant: null, dire: null });
  assert.deepEqual(incomplete.duration, { status: 'missing', value: null });
  assert.equal(incomplete.patch.status, 'missing');
  assert.equal(incomplete.teams.radiant.name.status, 'missing');
});
