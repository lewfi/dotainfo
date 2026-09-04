import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOURNAMENT_PAGE_SIZE,
  TOURNAMENT_INDEX_TITLE,
  createTournamentCollection,
} from '../src/presentation/tournaments.mjs';

function match(overrides = {}) {
  return {
    match_id: 1,
    start_time: Date.UTC(2024, 0, 2) / 1_000,
    leagueid: 10,
    league_name: 'Snapshot League',
    league_tier: 'professional',
    series_id: 100,
    series_type: 1,
    radiant_team_id: 1,
    dire_team_id: 2,
    radiant_team_name: 'Era Radiant',
    dire_team_name: 'Era Dire',
    radiant_win: true,
    radiant_score: 20,
    dire_score: 10,
    ...overrides,
  };
}

const references = Object.freeze({
  leagues: [
    { leagueid: 10, name: 'Current League', tier: 'premium' },
    { leagueid: 20, name: 'Repeated League', tier: 'professional' },
    { leagueid: 21, name: 'Repeated League', tier: 'professional' },
    { leagueid: 22, name: 'Repeated League', tier: 'amateur' },
  ],
  teams: [
    { team_id: 1, name: 'Current Radiant', tag: 'CR' },
    { team_id: 2, name: 'Current Dire', tag: 'CD' },
  ],
});

test('tournament pages retain every match across fixed-size pagination', () => {
  const rows = Array.from({ length: TOURNAMENT_PAGE_SIZE + 3 }, (_, index) => match({
    match_id: index + 1,
    start_time: (Date.UTC(2024, 0, 2) / 1_000) + index,
  }));
  const collection = createTournamentCollection(rows, references);
  const tournament = collection.tournaments[0];
  const pages = collection.pages.filter((page) => page.leagueId === 10);

  assert.equal(tournament.matchCount, TOURNAMENT_PAGE_SIZE + 3);
  assert.deepEqual(pages.map((page) => page.matches.length), [TOURNAMENT_PAGE_SIZE, 3]);
  assert.deepEqual(
    pages.flatMap((page) => page.matches.map((entry) => entry.matchId)),
    rows.map((row) => row.match_id).reverse(),
  );
  assert.equal(new Set(pages.flatMap((page) => page.matches.map((entry) => entry.matchId))).size, rows.length);
  assert.equal(pages[0].nextHref, '/tournaments/10/2/');
  assert.equal(pages[1].previousHref, '/tournaments/10/');
});

test('title cascade uses year and then league id while page titles remain unique', () => {
  const rows = [
    match({ match_id: 10, leagueid: 10 }),
    match({ match_id: 20, leagueid: 20, start_time: Date.UTC(2023, 0, 1) / 1_000 }),
    match({ match_id: 21, leagueid: 21, start_time: Date.UTC(2024, 0, 1) / 1_000 }),
    match({ match_id: 22, leagueid: 22, start_time: Date.UTC(2024, 6, 1) / 1_000 }),
  ];
  const collection = createTournamentCollection(rows, references, { pageSize: 1 });
  const byId = new Map(collection.tournaments.map((tournament) => [tournament.leagueId, tournament]));

  assert.equal(byId.get(10).titleStem, 'Current League');
  assert.equal(byId.get(20).titleStem, 'Repeated League (2023)');
  assert.equal(byId.get(21).titleStem, 'Repeated League (21)');
  assert.equal(byId.get(22).titleStem, 'Repeated League (22)');
  assert.equal(collection.pages.find((page) => page.leagueId === 20).title, 'Repeated League (2023) — DotaInfo');
  assert.equal(new Set(collection.pages.map((page) => page.title)).size, collection.pages.length);
  assert.ok(collection.pages.every((page) => page.title !== TOURNAMENT_INDEX_TITLE));
});

test('headings use current names while match rows preserve era names', () => {
  const collection = createTournamentCollection([match()], references);
  const tournament = collection.tournaments[0];
  const renderedMatch = collection.pages[0].matches[0];

  assert.equal(tournament.name, 'Current League');
  assert.equal(tournament.teams.find((team) => team.teamId === 1).name.display, 'Current Radiant');
  assert.equal(renderedMatch.teams.radiant.name.display, 'Era Radiant');
  assert.equal(renderedMatch.teams.radiant.name.source, 'match-write-time');
  assert.equal(tournament.category.label, 'Top tier');
});

test('series and missing match fields stay explicit without filtering rows', () => {
  const rows = [
    match({ match_id: 1, series_id: 7, series_type: 3 }),
    match({ match_id: 2, series_id: 7, series_type: 3 }),
    match({
      match_id: 3,
      series_id: null,
      series_type: null,
      radiant_team_id: null,
      dire_team_id: null,
      radiant_team_name: null,
      dire_team_name: null,
      radiant_win: null,
      radiant_score: null,
      dire_score: null,
    }),
  ];
  const collection = createTournamentCollection(rows, references);
  const page = collection.pages[0];
  const series = page.days.flatMap((day) => day.series);
  const missing = page.matches.find((entry) => entry.matchId === 3);

  assert.equal(page.matches.length, rows.length);
  assert.equal(series.find((entry) => entry.seriesId === 7).label, 'Other');
  assert.equal(series.find((entry) => entry.seriesId === null).label, 'Series format unavailable');
  assert.equal(missing.teams.radiant.name.display, 'Team name unavailable');
  assert.equal(missing.score.status, 'missing');
  assert.equal(missing.result.status, 'missing');
});
