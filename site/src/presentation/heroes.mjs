import { HERO_ICON_BASE_URL } from './reference-model.mjs';

export const HERO_INDEX_TITLE = 'Heroes — DotaInfo';

const ATTRIBUTE_GROUPS = Object.freeze([
  Object.freeze({ id: 'str', label: 'Strength' }),
  Object.freeze({ id: 'agi', label: 'Agility' }),
  Object.freeze({ id: 'int', label: 'Intelligence' }),
  Object.freeze({ id: 'all', label: 'Universal' }),
  Object.freeze({ id: 'other', label: 'Other' }),
]);

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function safeId(value) {
  if (value === null || value === undefined) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function count(value) {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`invalid aggregate count: ${value}`);
  return result;
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function heroIcon(machineName) {
  const slug = cleanText(machineName)?.replace(/^npc_dota_hero_/, '') ?? null;
  return slug && /^[a-z0-9_]+$/.test(slug)
    ? `${HERO_ICON_BASE_URL}${slug}.png`
    : null;
}

function attributeGroup(value) {
  return ATTRIBUTE_GROUPS.find((group) => group.id === value) ?? ATTRIBUTE_GROUPS.at(-1);
}

function lanePresentation(value) {
  if (value === null || value === undefined) {
    return Object.freeze({ key: 'unavailable', label: 'Lane role unavailable', order: 5 });
  }
  const numeric = Number(value);
  const known = Object.freeze({
    1: Object.freeze({ key: '1', label: 'Safe lane', order: 1 }),
    2: Object.freeze({ key: '2', label: 'Mid lane', order: 2 }),
    3: Object.freeze({ key: '3', label: 'Off lane', order: 3 }),
    4: Object.freeze({ key: '4', label: 'Jungle', order: 4 }),
  });
  return known[numeric] ?? Object.freeze({ key: String(numeric), label: `Other (${numeric})`, order: 6 });
}

function patchKey(value) {
  return value === null || value === undefined ? 'unavailable' : String(value);
}

export function createHeroCollection(referenceHeroes, aggregates) {
  if (!Array.isArray(referenceHeroes)) throw new TypeError('hero references must be an array');
  const global = aggregates?.global ?? {};
  const totalMatches = count(global.total_matches);
  const draftMatchCount = count(global.draft_match_count);
  const totalDraftRows = count(global.total_draft_rows);
  const totalPicks = count(global.total_picks);
  const totalBans = count(global.total_bans);

  // These are denominator choices, not row filters. Draft-less matches remain in totalMatches;
  // null-result picks remain in pickCount but not in winEligiblePicks.
  const draftByHero = new Map((aggregates.heroDraft ?? []).map((row) => [
    safeId(row.hero_id),
    Object.freeze({
      pickCount: count(row.pick_count),
      banCount: count(row.ban_count),
      winEligiblePicks: count(row.win_eligible_picks),
      wins: count(row.wins),
    }),
  ]));
  const playerHeroIds = new Set((aggregates.lanes ?? []).map((row) => safeId(row.hero_id)));
  const patchRows = new Map();
  for (const row of aggregates.heroPatches ?? []) {
    const heroId = safeId(row.hero_id);
    const byPatch = patchRows.get(heroId) ?? new Map();
    byPatch.set(patchKey(row.patch), row);
    patchRows.set(heroId, byPatch);
  }
  const laneRows = new Map();
  for (const row of aggregates.lanes ?? []) {
    const heroId = safeId(row.hero_id);
    const rows = laneRows.get(heroId) ?? [];
    rows.push(row);
    laneRows.set(heroId, rows);
  }

  const patches = Object.freeze((aggregates.patches ?? []).map((row) => Object.freeze({
    key: patchKey(row.patch),
    label: row.patch === null || row.patch === undefined ? 'Patch unavailable' : `Patch ${row.patch}`,
    draftMatchCount: count(row.draft_match_count),
  })));
  const referenceIds = new Set();
  const heroes = referenceHeroes.map((reference) => {
    const heroId = safeId(reference.id);
    if (heroId === null || referenceIds.has(heroId)) throw new Error(`invalid or duplicate hero reference id: ${reference.id}`);
    referenceIds.add(heroId);
    const draft = draftByHero.get(heroId) ?? {
      pickCount: 0,
      banCount: 0,
      winEligiblePicks: 0,
      wins: 0,
    };
    const playerRows = laneRows.get(heroId) ?? [];
    const playerCount = playerRows.reduce((sum, row) => sum + count(row.appearances), 0);
    const trends = patches.map((patch) => {
      const row = patchRows.get(heroId)?.get(patch.key) ?? {};
      const pickCount = count(row.pick_count);
      const banCount = count(row.ban_count);
      const winEligiblePicks = count(row.win_eligible_picks);
      const wins = count(row.wins);
      return Object.freeze({
        ...patch,
        pickCount,
        banCount,
        winEligiblePicks,
        wins,
        pickRate: rate(pickCount, patch.draftMatchCount),
        banRate: rate(banCount, patch.draftMatchCount),
        contestRate: rate(pickCount + banCount, patch.draftMatchCount),
        winRate: rate(wins, winEligiblePicks),
      });
    });
    const lanes = playerRows.map((row) => {
      const lane = lanePresentation(row.lane_role);
      const appearances = count(row.appearances);
      return Object.freeze({
        ...lane,
        appearances,
        rate: rate(appearances, playerCount),
      });
    }).sort((left, right) => right.appearances - left.appearances || left.order - right.order);
    const localizedName = cleanText(reference.localized_name)
      ?? cleanText(reference.name)?.replace(/^npc_dota_hero_/, '').replaceAll('_', ' ')
      ?? `Hero ${heroId}`;
    const group = attributeGroup(cleanText(reference.primary_attr)?.toLowerCase());
    const roles = Array.isArray(reference.roles)
      ? Object.freeze(reference.roles.map(cleanText).filter(Boolean))
      : Object.freeze([]);
    return Object.freeze({
      heroId,
      name: localizedName,
      title: `${localizedName} hero — DotaInfo`,
      machineName: cleanText(reference.name),
      iconUrl: heroIcon(reference.name),
      primaryAttribute: group,
      attackType: cleanText(reference.attack_type) ?? 'Attack type unavailable',
      roles,
      pickCount: draft.pickCount,
      banCount: draft.banCount,
      winEligiblePicks: draft.winEligiblePicks,
      wins: draft.wins,
      playerCount,
      pickRate: rate(draft.pickCount, draftMatchCount),
      banRate: rate(draft.banCount, draftMatchCount),
      contestRate: rate(draft.pickCount + draft.banCount, draftMatchCount),
      winRate: rate(draft.wins, draft.winEligiblePicks),
      trends: Object.freeze(trends),
      lanes: Object.freeze(lanes),
    });
  }).sort((left, right) => left.name.localeCompare(right.name) || left.heroId - right.heroId);

  for (const heroId of draftByHero.keys()) {
    if (!referenceIds.has(heroId)) throw new Error(`draft hero ${heroId ?? 'null'} has no reference`);
  }
  for (const heroId of playerHeroIds) {
    if (!referenceIds.has(heroId)) throw new Error(`player hero ${heroId ?? 'null'} has no reference`);
  }
  const titles = [HERO_INDEX_TITLE, ...heroes.map((hero) => hero.title)];
  if (new Set(titles).size !== titles.length) throw new Error('hero page title collision');

  const groups = ATTRIBUTE_GROUPS.map((group) => Object.freeze({
    ...group,
    heroes: Object.freeze(heroes.filter((hero) => hero.primaryAttribute.id === group.id)),
  })).filter((group) => group.heroes.length > 0);
  return Object.freeze({
    totalMatches,
    draftMatchCount,
    totalDraftRows,
    totalPicks,
    totalBans,
    patches,
    heroes: Object.freeze(heroes),
    groups: Object.freeze(groups),
  });
}
