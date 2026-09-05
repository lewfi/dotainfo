import assert from 'node:assert/strict';
import test from 'node:test';

import { groupHomeSeriesRows, SERIES_SPLIT_SECONDS } from '../src/data/home-series.mjs';
import { ReferenceResolver } from '../src/data/references.mjs';
import { createHomeSeriesEntry } from '../src/presentation/home-series.mjs';

function row(overrides) {
  return {
    match_id: 1,
    start_time: 1_000,
    duration: 2_000,
    leagueid: 10,
    league_name: 'League',
    league_tier: 'professional',
    series_id: 50,
    series_type: 1,
    radiant_team_id: 100,
    dire_team_id: 200,
    radiant_team_name: 'Alpha',
    dire_team_name: 'Beta',
    radiant_win: true,
    radiant_score: 20,
    dire_score: 10,
    patch: '7.41',
    ...overrides,
  };
}

test('series grouping keys by series, league, unordered team pair and six-hour segment', () => {
  const rows = [
    row({ match_id: 1 }),
    row({ match_id: 2, start_time: 2_000, radiant_team_id: 200, dire_team_id: 100 }),
    row({ match_id: 3, start_time: 3_000, leagueid: 11 }),
    row({ match_id: 4, start_time: 4_000, radiant_team_id: 300, dire_team_id: 400 }),
    row({ match_id: 5, start_time: 2_000 + SERIES_SPLIT_SECONDS + 1 }),
  ];
  const groups = groupHomeSeriesRows(rows);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map((group) => group.rows.map((candidate) => candidate.match_id)), [
    [5], [4], [3], [1, 2],
  ]);
});

test('series id zero remains a standalone row', () => {
  const [group] = groupHomeSeriesRows([row({ series_id: 0 })]);
  assert.equal(group.kind, 'standalone');
  assert.equal(group.rows.length, 1);
});

test('null series id remains a standalone row', () => {
  const [group] = groupHomeSeriesRows([row({ series_id: null })]);
  assert.equal(group.kind, 'standalone');
  assert.equal(group.rows.length, 1);
});

test('either one null team id makes a match standalone', () => {
  const groups = groupHomeSeriesRows([
    row({ match_id: 1, radiant_team_id: null }),
    row({ match_id: 2, start_time: 2_000, dire_team_id: null }),
  ]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.kind === 'standalone' && group.rows.length === 1));
});

test('two null team ids make a match standalone', () => {
  const [group] = groupHomeSeriesRows([row({ radiant_team_id: null, dire_team_id: null })]);
  assert.equal(group.kind, 'standalone');
  assert.equal(group.rows.length, 1);
});

test('nearby series id zero matches remain two standalone rows', () => {
  const groups = groupHomeSeriesRows([
    row({ match_id: 1, series_id: 0 }),
    row({ match_id: 2, series_id: 0, start_time: 4_600 }),
  ]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.kind === 'standalone' && group.rows.length === 1));
  assert.deepEqual(groups.map((group) => group.rows[0].match_id), [2, 1]);
});

test('positive series ids still group genuine multi-map series', () => {
  const [group] = groupHomeSeriesRows([
    row({ match_id: 1 }),
    row({ match_id: 2, start_time: 2_000 }),
  ]);
  assert.equal(group.kind, 'series');
  assert.deepEqual(group.rows.map((candidate) => candidate.match_id), [1, 2]);
});

test('series grouping preserves every map without imposing a best-of-five maximum', () => {
  const rows = Array.from({ length: 6 }, (_, index) => row({
    match_id: index + 1,
    start_time: 1_000 + index * 1_000,
  }));
  const groups = groupHomeSeriesRows(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].rows.map((candidate) => candidate.match_id), [1, 2, 3, 4, 5, 6]);
});

test('series score follows team ids when sides swap and preserves unknown maps', () => {
  const group = groupHomeSeriesRows([
    row({ match_id: 1, radiant_win: true }),
    row({ match_id: 2, start_time: 2_000, radiant_team_id: 200, dire_team_id: 100, radiant_win: false }),
    row({ match_id: 3, start_time: 3_000, radiant_win: null }),
  ])[0];
  const entry = createHomeSeriesEntry(group, new ReferenceResolver());
  assert.equal(entry.sidesSwapped, true);
  assert.deepEqual(entry.seriesScore, { teamOneWins: 2, teamTwoWins: 0, unknownMaps: 1 });
  assert.equal(entry.maps.length, 3);
});

test('standalone rows do not expose a fabricated series score', () => {
  const group = groupHomeSeriesRows([row({ series_id: null })])[0];
  const entry = createHomeSeriesEntry(group, new ReferenceResolver());
  assert.equal(entry.kind, 'standalone');
  assert.equal(entry.seriesScore, null);
});
