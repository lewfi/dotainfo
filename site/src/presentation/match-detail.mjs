import { createMatchSummary } from './match-summary.mjs';

const ITEM_COLUMNS = Object.freeze([
  'item_0',
  'item_1',
  'item_2',
  'item_3',
  'item_4',
  'item_5',
  'item_neutral',
]);

export const SCOREBOARD_COLUMNS = Object.freeze([
  Object.freeze({ key: 'player', short: 'Player / hero', long: 'Player / hero' }),
  Object.freeze({ key: 'level', short: 'Lvl', long: 'Level' }),
  Object.freeze({ key: 'combat', short: 'K / D / A', long: 'Kills / Deaths / Assists' }),
  Object.freeze({ key: 'farm', short: 'LH / DN', long: 'Last hits / Denies' }),
  Object.freeze({
    key: 'economy',
    short: 'GPM / XPM',
    long: 'Gold per minute / Experience per minute',
  }),
  Object.freeze({ key: 'net-worth', short: 'Net worth', long: 'Net worth' }),
  Object.freeze({ key: 'items', short: 'Items', long: 'Items' }),
]);

function playerModel(row, references) {
  return Object.freeze({
    accountId: row.account_id,
    slot: row.player_slot,
    player: references.resolvePlayer(row.account_id),
    hero: references.resolveHero(row.hero_id),
    kills: row.kills,
    deaths: row.deaths,
    assists: row.assists,
    lastHits: row.last_hits,
    denies: row.denies,
    goldPerMinute: row.gold_per_min,
    xpPerMinute: row.xp_per_min,
    netWorth: row.net_worth,
    level: row.level,
    items: Object.freeze(
      ITEM_COLUMNS.map((column) => row[column]).filter(
        (itemId) => Number.isSafeInteger(itemId) && itemId > 0,
      ).map((itemId) => references.resolveItem(itemId)),
    ),
  });
}

function draftModel(row, references) {
  return Object.freeze({
    order: row.ord,
    action: row.is_pick === true ? 'pick' : row.is_pick === false ? 'ban' : 'unknown',
    side: row.team === 0 ? 'radiant' : row.team === 1 ? 'dire' : 'unknown',
    hero: references.resolveHero(row.hero_id),
  });
}

function advantageModel(match) {
  if (match.radiant_gold_adv === null || match.radiant_gold_adv === undefined) {
    return null;
  }
  return Object.freeze({
    gold: Object.freeze([...match.radiant_gold_adv]),
    xp: Array.isArray(match.radiant_xp_adv)
      ? Object.freeze([...match.radiant_xp_adv])
      : null,
  });
}

export function createMatchDetailModel(detail, references) {
  if (!detail?.match || !Array.isArray(detail.players) || !Array.isArray(detail.draft)) {
    throw new TypeError('match detail model requires match, players, and draft rows');
  }
  if (
    !references
    || typeof references.resolveHero !== 'function'
    || typeof references.resolveItem !== 'function'
  ) {
    throw new TypeError('match detail model requires a reference resolver');
  }

  const players = detail.players.map((row) => playerModel(row, references));
  return Object.freeze({
    summary: createMatchSummary(detail.match, references),
    boxscores: Object.freeze({
      radiant: Object.freeze(
        players.filter((player, index) => detail.players[index].is_radiant === true),
      ),
      dire: Object.freeze(
        players.filter((player, index) => detail.players[index].is_radiant === false),
      ),
    }),
    draft: Object.freeze(detail.draft.map((row) => draftModel(row, references))),
    advantage: advantageModel(detail.match),
  });
}
