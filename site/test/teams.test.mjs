import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEAM_INDEX_TITLE,
  TEAM_PAGE_SIZE,
  createTeamCollection,
} from '../src/presentation/teams.mjs';

function match(overrides = {}) {
  return {
    match_id: 1,
    start_time: Date.UTC(2024, 0, 2) / 1_000,
    leagueid: 10,
    league_name: 'Era League',
    radiant_team_id: 1,
    dire_team_id: 2,
    radiant_team_name: 'Era Alpha',
    dire_team_name: 'Era Dominion',
    radiant_win: true,
    radiant_score: 20,
    dire_score: 10,
    ...overrides,
  };
}

const references = Object.freeze({
  teams: [
    { team_id: 1, name: 'Current Alpha', tag: 'CA', logo_url: 'https://example.invalid/alpha.png' },
    { team_id: 2, name: 'Dominion', tag: 'D2', logo_url: null },
    { team_id: 3, name: 'Dominion', tag: 'D3', logo_url: null },
    { team_id: 4, name: 'Dominion', tag: 'D4', logo_url: null },
    { team_id: 5, name: ' ', tag: 'FIVE', logo_url: null },
    { team_id: 6, name: null, tag: null, logo_url: null },
  ],
  leagues: [{ leagueid: 10, name: 'Current League' }],
  heroes: [
    { id: 1, name: 'npc_dota_hero_antimage', localized_name: 'Anti-Mage' },
    { id: 2, name: 'npc_dota_hero_axe', localized_name: 'Axe' },
  ],
});

test('team pages retain every match across fixed-size pagination', () => {
  const rows = Array.from({ length: TEAM_PAGE_SIZE + 3 }, (_, index) => match({
    match_id: index + 1,
    start_time: (Date.UTC(2024, 0, 2) / 1_000) + index,
    dire_team_id: 10_000 + index,
    dire_team_name: `Opponent ${index}`,
  }));
  const collection = createTeamCollection(rows, [], references);
  const team = collection.teams.find((candidate) => candidate.teamId === 1);
  const pages = collection.pages.filter((page) => page.teamId === 1);

  assert.equal(team.matchCount, TEAM_PAGE_SIZE + 3);
  assert.deepEqual(pages.map((page) => page.matches.length), [TEAM_PAGE_SIZE, 3]);
  assert.deepEqual(
    pages.flatMap((page) => page.matches.map((entry) => entry.matchId)),
    rows.map((row) => row.match_id).reverse(),
  );
  assert.equal(new Set(pages.flatMap((page) => page.matches.map((entry) => entry.matchId))).size, rows.length);
  assert.equal(pages[0].nextHref, '/teams/1/2/');
  assert.equal(pages[1].previousHref, '/teams/1/');
});

test('win and loss record excludes null results without dropping matches', () => {
  const rows = [
    match({ match_id: 1, radiant_win: true }),
    match({ match_id: 2, radiant_win: false }),
    match({ match_id: 3, radiant_win: null, radiant_score: null, dire_score: null }),
  ];
  const collection = createTeamCollection(rows, [], references);
  const radiant = collection.teams.find((team) => team.teamId === 1);
  const dire = collection.teams.find((team) => team.teamId === 2);

  assert.equal(radiant.matchCount, 3);
  assert.equal(radiant.wins, 1);
  assert.equal(radiant.losses, 1);
  assert.equal(radiant.decidedMatches, 2);
  assert.equal(radiant.nullResultMatches, 1);
  assert.equal(radiant.matches.find((entry) => entry.matchId === 3).result.label, 'Result unavailable');
  assert.equal(dire.wins, 1);
  assert.equal(dire.losses, 1);
});

test('title cascade uses first year and then team id while titles stay unique', () => {
  const rows = [
    match({ match_id: 1 }),
    match({ match_id: 2, radiant_team_id: 2, dire_team_id: 20, start_time: Date.UTC(2023, 0, 1) / 1_000 }),
    match({ match_id: 3, radiant_team_id: 3, dire_team_id: 30, start_time: Date.UTC(2024, 0, 1) / 1_000 }),
    match({ match_id: 4, radiant_team_id: 4, dire_team_id: 40, start_time: Date.UTC(2024, 6, 1) / 1_000 }),
  ];
  const collection = createTeamCollection(rows, [], references);
  const byId = new Map(collection.teams.map((team) => [team.teamId, team]));

  assert.equal(byId.get(1).titleStem, 'Current Alpha');
  assert.equal(byId.get(2).titleStem, 'Dominion (2023)');
  assert.equal(byId.get(3).titleStem, 'Dominion (3)');
  assert.equal(byId.get(4).titleStem, 'Dominion (4)');
  assert.equal(collection.pages.find((page) => page.teamId === 2).title, 'Dominion (2023) — DotaInfo');
  assert.equal(new Set(collection.pages.map((page) => page.title)).size, collection.pages.length);
  assert.ok(collection.pages.every((page) => page.title !== TEAM_INDEX_TITLE));
});

test('current and fallback names, era opponents, logos, and top heroes remain explicit', () => {
  const rows = [
    match({ match_id: 1, radiant_team_id: 5, radiant_team_name: 'Older Five', start_time: 100 }),
    match({ match_id: 2, radiant_team_id: 5, radiant_team_name: 'Latest Five', start_time: 200 }),
    match({ match_id: 3, radiant_team_id: 6, radiant_team_name: null, dire_team_name: 'Era Dominion' }),
  ];
  const heroAppearances = [
    { team_id: 5, hero_id: 1, appearances: 7 },
    { team_id: 5, hero_id: 2, appearances: 9 },
  ];
  const collection = createTeamCollection(rows, heroAppearances, references);
  const five = collection.teams.find((team) => team.teamId === 5);
  const six = collection.teams.find((team) => team.teamId === 6);
  const alpha = collection.teams.find((team) => team.teamId === 2);

  assert.equal(five.name.display, 'Latest Five');
  assert.equal(five.name.source, 'most-recent-match');
  assert.equal(six.name.display, 'Team 6');
  assert.equal(six.name.source, 'team-id-fallback');
  assert.equal(five.logo.status, 'missing');
  assert.deepEqual(five.topHeroes.map((hero) => [hero.name, hero.appearances]), [['Axe', 9], ['Anti-Mage', 7]]);
  assert.equal(alpha.name.display, 'Dominion');
  assert.equal(five.matches[0].opponent.name.display, 'Era Dominion');
  assert.equal(five.matches[0].opponent.name.source, 'match-write-time');
  assert.equal(five.matches[0].tournament.name, 'Current League');
});
