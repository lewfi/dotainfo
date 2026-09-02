import { ReferenceResolver } from '../../../src/data/references.mjs';

const baseMatch = Object.freeze({
  match_id: 4001,
  start_time: 1769900000,
  duration: 2400,
  leagueid: 10,
  league_name: 'Fixture League',
  league_tier: 'future-tier',
  radiant_team_id: 1,
  dire_team_id: 2,
  radiant_team_name: 'Radiant Snapshot',
  dire_team_name: 'Dire Snapshot',
  radiant_win: true,
  radiant_score: 30,
  dire_score: 20,
  patch: '7.41',
  radiant_gold_adv: [0, 100, -50, 250],
  radiant_xp_adv: [0, 80, -20, 200],
});

const players = Object.freeze([
  Object.freeze({
    match_id: 4001,
    account_id: 101,
    player_slot: 0,
    is_radiant: true,
    hero_id: 1,
    kills: 10,
    deaths: 2,
    assists: 12,
    last_hits: 250,
    denies: 12,
    gold_per_min: 650,
    xp_per_min: 700,
    net_worth: 22000,
    item_0: 1,
    item_1: 2,
    item_2: 3,
    item_3: null,
    item_4: null,
    item_5: null,
    item_neutral: 11,
  }),
  Object.freeze({
    match_id: 4001,
    account_id: 102,
    player_slot: 128,
    is_radiant: false,
    hero_id: 2,
    kills: 4,
    deaths: 8,
    assists: 9,
    last_hits: 180,
    denies: 6,
    gold_per_min: 500,
    xp_per_min: 540,
    net_worth: 16000,
    item_0: 4,
    item_1: 5,
    item_2: null,
    item_3: null,
    item_4: null,
    item_5: null,
    item_neutral: null,
  }),
]);

const draft = Object.freeze([
  Object.freeze({ match_id: 4001, is_pick: false, hero_id: 2, team: 1, ord: 0 }),
  Object.freeze({ match_id: 4001, is_pick: true, hero_id: 1, team: 0, ord: 1 }),
]);

function detail(match = baseMatch, draftRows = draft) {
  return Object.freeze({ match: Object.freeze(match), players, draft: draftRows });
}

export const DETAIL_FIXTURE_CASES = Object.freeze([
  Object.freeze({ id: 'normal', detail: detail() }),
  Object.freeze({ id: 'no-draft', detail: detail({ ...baseMatch, match_id: 4002 }, []) }),
  Object.freeze({
    id: 'null-team',
    detail: detail({
      ...baseMatch,
      match_id: 4003,
      radiant_team_id: null,
      radiant_team_name: null,
    }),
  }),
  Object.freeze({
    id: 'whitespace-name',
    detail: detail({
      ...baseMatch,
      match_id: 4004,
      radiant_team_id: 3,
      dire_team_id: 4,
      radiant_team_name: ' ',
      dire_team_name: '\t',
    }),
  }),
  Object.freeze({
    id: 'null-advantage',
    detail: detail({
      ...baseMatch,
      match_id: 4005,
      radiant_gold_adv: null,
      radiant_xp_adv: null,
    }),
  }),
]);

export function fixtureReferences() {
  return new ReferenceResolver({
    teams: [
      { team_id: 1, name: 'Radiant Current', tag: 'RAD', logo_url: null },
      { team_id: 2, name: 'Dire Current', tag: 'DIRE', logo_url: null },
      { team_id: 3, name: ' ', tag: null, logo_url: null },
    ],
    leagues: [
      { leagueid: 10, name: 'Fixture League', tier: 'future-tier', banner: null },
    ],
    players: [
      { account_id: 101, name: 'Radiant Player', fantasy_role: 1, is_pro: true },
      { account_id: 102, name: 'Dire Player', fantasy_role: 2, is_pro: null },
    ],
    heroes: [
      { id: 1, name: 'npc_dota_hero_antimage', localized_name: 'Anti-Mage', roles: ['Carry'] },
      { id: 2, name: 'npc_dota_hero_axe', localized_name: 'Axe', roles: ['Initiator'] },
    ],
  });
}
