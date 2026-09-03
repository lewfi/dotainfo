import assert from 'node:assert/strict';
import test from 'node:test';

import { HISTORICAL_MATCH_COLUMNS } from '../src/data/historical-artifacts.mjs';
import {
  historicalRouteView,
  matchIdFromPathname,
  resolveHistoricalMatch,
} from '../src/presentation/historical-route.mjs';
import { ReferenceResolver } from '../src/presentation/reference-model.mjs';

test('historical payload projection excludes both advantage arrays entirely', () => {
  assert.ok(!HISTORICAL_MATCH_COLUMNS.includes('radiant_gold_adv'));
  assert.ok(!HISTORICAL_MATCH_COLUMNS.includes('radiant_xp_adv'));
});

test('historical pathname parsing accepts only positive numeric match routes', () => {
  assert.equal(matchIdFromPathname('/matches/7485890286'), 7485890286);
  assert.equal(matchIdFromPathname('/matches/7485890286/'), 7485890286);
  assert.equal(matchIdFromPathname('/matches/not-a-number'), null);
  assert.equal(matchIdFromPathname('/teams/7485890286'), null);
});

test('historical routing checks every overlapping candidate range', async () => {
  const loaded = [];
  const matchId = 150;
  const result = await resolveHistoricalMatch(matchId, {
    manifest: {
      ranges: [
        { month: '2025-01', min_match_id: 100, max_match_id: 200 },
        { month: '2025-02', min_match_id: 140, max_match_id: 240 },
      ],
    },
    async loadMonth(month) {
      loaded.push(month);
      return {
        month,
        matches: month === '2025-02' ? [{ match_id: matchId }] : [],
      };
    },
  });

  assert.equal(result.status, 'found');
  assert.equal(result.match.match_id, matchId);
  assert.deepEqual(loaded.sort(), ['2025-01', '2025-02']);
  assert.deepEqual([...result.checkedMonths].sort(), ['2025-01', '2025-02']);
});

test('inside-range gaps and outside-range IDs produce explicit not-found views', async () => {
  const references = new ReferenceResolver();
  const manifest = { ranges: [{ month: '2025-01', min_match_id: 100, max_match_id: 200 }] };
  const loadMonth = async () => ({ month: '2025-01', matches: [{ match_id: 100 }] });

  for (const matchId of [150, 1]) {
    const result = await resolveHistoricalMatch(matchId, { manifest, loadMonth });
    const view = historicalRouteView(matchId, result, references);
    assert.equal(result.status, 'not-found');
    assert.equal(view.status, 'not-found');
    assert.equal(view.title, 'Match not found');
    assert.match(view.markup, /not present in the committed archive/);
    assert.ok(view.markup.trim().length > 0);
  }
});

test('historical summary renders explicit unknown teams, result, and score', () => {
  const match = {
    match_id: 7485890286,
    start_time: 1702459862,
    duration: 675,
    leagueid: 15910,
    league_name: 'Example league',
    league_tier: 'professional',
    radiant_team_id: null,
    dire_team_id: null,
    radiant_team_name: null,
    dire_team_name: null,
    radiant_win: null,
    radiant_score: null,
    dire_score: null,
    patch: '7.34',
  };
  const view = historicalRouteView(
    match.match_id,
    { status: 'found', match },
    new ReferenceResolver(),
  );

  assert.equal(view.summary.teams.radiant.name.status, 'missing');
  assert.equal(view.summary.teams.dire.name.status, 'missing');
  assert.equal(view.summary.result.status, 'missing');
  assert.equal(view.summary.score.status, 'missing');
  assert.match(view.markup, /Team name unavailable/);
  assert.match(view.markup, /Result unavailable/);
  assert.match(view.markup, /Score unavailable/);
  assert.match(view.markup, /data-team-id-state="missing"/);
  assert.match(view.markup, /Team ID unavailable/);
  assert.doesNotMatch(view.markup, /data-logo-state=/);
  assert.doesNotMatch(view.markup, /Logo unavailable/);
  assert.match(view.markup, /<section class="archive-summary"/);
  assert.doesNotMatch(view.markup, /\bmatch-card\b/);
  assert.match(
    view.markup,
    /<time datetime="2023-12-13T09:31:02\.000Z" data-date-display="absolute">December 13, 2023<\/time>/,
  );
  assert.doesNotMatch(view.markup, /data-relative-time/);
  assert.doesNotMatch(view.markup, />2023-12-13T09:31:02\.000Z<\/time>/);
  assert.doesNotMatch(view.markup, />undefined</);
});
