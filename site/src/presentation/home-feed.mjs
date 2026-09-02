import { createMatchSummary } from './match-summary.mjs';

export const DEFAULT_HOME_TIERS = Object.freeze(['premium', 'professional']);

const TIER_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'top',
    label: 'Top tier',
    badge: 'TOP TIER',
    hint: 'Flagship events (source value: premium)',
    tiers: Object.freeze(['premium']),
  }),
  Object.freeze({
    id: 'pro',
    label: 'Pro',
    badge: 'PRO',
    hint: 'Regular professional circuit (source value: professional)',
    tiers: Object.freeze(['professional']),
  }),
  Object.freeze({
    id: 'amateur',
    label: 'Amateur',
    badge: 'AMATEUR',
    hint: 'Qualifiers and lower divisions (source value: amateur)',
    tiers: Object.freeze(['amateur']),
  }),
]);

const OTHER_CATEGORY = Object.freeze({
  id: 'other',
  label: 'Other',
  badge: 'OTHER',
  hint: 'Unclassified, excluded, or a tier we do not recognise yet',
});

const DEFAULT_CATEGORY = Object.freeze({
  id: 'default',
  label: 'Top tier + Pro',
  badge: 'TOP + PRO',
  hint: 'Flagship events and the regular professional circuit (source values: premium, professional)',
  tiers: DEFAULT_HOME_TIERS,
});

const ALL_CATEGORY = Object.freeze({
  id: 'all',
  label: 'All results',
  badge: 'ALL',
  hint: 'Every tier we cover',
});

const DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  weekday: 'long',
  year: 'numeric',
});

const SHORT_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  weekday: 'short',
});

export function homeTierCategory(tier) {
  const normalized = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  return TIER_CATEGORIES.find((category) => category.tiers.includes(normalized))
    ?? OTHER_CATEGORY;
}

export function homeTierLabel(tier) {
  return homeTierCategory(tier).label;
}

function dayIdentity(summary) {
  if (summary.date.status !== 'available') {
    return Object.freeze({ key: 'unavailable', label: 'Date unavailable', shortLabel: 'Date unavailable' });
  }
  const date = new Date(summary.date.isoUtc);
  return Object.freeze({
    key: summary.date.isoUtc.slice(0, 10),
    label: DAY_FORMATTER.format(date),
    shortLabel: SHORT_DAY_FORMATTER.format(date),
  });
}

function groupMatches(matches) {
  const days = new Map();
  for (const match of matches) {
    const day = dayIdentity(match);
    let dayGroup = days.get(day.key);
    if (!dayGroup) {
      dayGroup = { ...day, matches: [], leagues: new Map() };
      days.set(day.key, dayGroup);
    }
    dayGroup.matches.push(match);

    const leagueKey = match.league.leagueId === null
      ? `name:${match.league.name.display}|tier:${match.league.tier.value ?? ''}`
      : `id:${match.league.leagueId}`;
    let league = dayGroup.leagues.get(leagueKey);
    if (!league) {
      const category = homeTierCategory(match.league.tier.value);
      league = {
        key: leagueKey,
        name: match.league.name.display,
        nameState: match.league.name.status,
        rawTier: match.league.tier.value,
        category,
        matches: [],
      };
      dayGroup.leagues.set(leagueKey, league);
    }
    league.matches.push(match);
  }

  return Object.freeze([...days.values()].map((day) => Object.freeze({
    key: day.key,
    label: day.label,
    shortLabel: day.shortLabel,
    count: day.matches.length,
    leagues: Object.freeze([...day.leagues.values()].map((league) => Object.freeze({
      ...league,
      matches: Object.freeze(league.matches),
    }))),
  })));
}

function homeView(category, query, references) {
  const matches = Object.freeze(query.rows.map((row) => createMatchSummary(row, references)));
  return Object.freeze({
    id: category.id,
    label: category.label,
    badge: category.badge,
    hint: category.hint,
    selectedTiers: query.selectedTiers,
    matches,
    days: groupMatches(matches),
    tierCounts: query.tierCounts,
    hiddenCount: query.hiddenCount,
    range: query.range,
  });
}

export async function createHomeFeedViews({ reader, references, clock, limit = 100 }) {
  if (!reader || typeof reader.home !== 'function') {
    throw new TypeError('home feed requires a data reader');
  }
  if (!references || typeof references.resolveTeam !== 'function') {
    throw new TypeError('home feed requires a reference resolver');
  }

  const allQuery = await reader.home({ clock, limit, tiers: null });
  const otherTiers = allQuery.availableTiers.filter(
    (tier) => homeTierCategory(tier).id === OTHER_CATEGORY.id,
  );
  const categoryQueries = await Promise.all([
    reader.home({ clock, limit, tiers: DEFAULT_HOME_TIERS }),
    ...TIER_CATEGORIES.map((category) => reader.home({ clock, limit, tiers: category.tiers })),
    reader.home({ clock, limit, tiers: otherTiers }),
  ]);
  const categories = [...TIER_CATEGORIES, OTHER_CATEGORY];
  const views = [
    homeView(DEFAULT_CATEGORY, categoryQueries[0], references),
    homeView(ALL_CATEGORY, allQuery, references),
    ...categories.map((category, index) => homeView(
      category,
      categoryQueries[index + 1],
      references,
    )),
  ];

  return Object.freeze({
    clock: new Date(allQuery.range.endEpoch * 1000).toISOString(),
    limit,
    availableTiers: allQuery.availableTiers,
    views: Object.freeze(views),
  });
}
