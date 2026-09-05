import { createHomeSeriesEntry } from './home-series.mjs';

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

function groupEntries(entries) {
  const days = new Map();
  for (const entry of entries) {
    const day = dayIdentity(entry.latest);
    let dayGroup = days.get(day.key);
    if (!dayGroup) {
      dayGroup = { ...day, entries: [], leagues: new Map() };
      days.set(day.key, dayGroup);
    }
    dayGroup.entries.push(entry);

    const league = entry.latest.league;
    const leagueKey = league.leagueId === null
      ? `name:${league.name.display}|tier:${league.tier.value ?? ''}`
      : `id:${league.leagueId}`;
    let leagueGroup = dayGroup.leagues.get(leagueKey);
    if (!leagueGroup) {
      const category = homeTierCategory(entry.leagueTier);
      leagueGroup = {
        key: leagueKey,
        name: league.name.display,
        nameState: league.name.status,
        rawTier: entry.leagueTier,
        category,
        entries: [],
      };
      dayGroup.leagues.set(leagueKey, leagueGroup);
    }
    leagueGroup.entries.push(entry);
  }

  return Object.freeze([...days.values()].map((day) => Object.freeze({
    key: day.key,
    label: day.label,
    shortLabel: day.shortLabel,
    count: day.entries.length,
    leagues: Object.freeze([...day.leagues.values()].map((league) => Object.freeze({
      ...league,
      entries: Object.freeze(league.entries),
    }))),
  })));
}

function viewMatches(entry, category) {
  const id = homeTierCategory(entry.leagueTier).id;
  if (category.id === 'all') return true;
  if (category.id === 'default') return id === 'top' || id === 'pro';
  return id === category.id;
}

function homeView(category, entries, range) {
  const matching = entries.filter((entry) => viewMatches(entry, category));
  return Object.freeze({
    id: category.id,
    label: category.label,
    badge: category.badge,
    hint: category.hint,
    selectedTiers: category.id === 'all' ? null : category.tiers,
    resultCount: matching.length,
    hiddenCount: entries.length - matching.length,
    range,
  });
}

export async function createHomeFeedViews({ reader, references, clock, limit = 300 }) {
  if (!reader || typeof reader.homeSeries !== 'function') {
    throw new TypeError('home feed requires a data reader');
  }
  if (!references || typeof references.resolveTeam !== 'function') {
    throw new TypeError('home feed requires a reference resolver');
  }

  const query = await reader.homeSeries({ clock, limit });
  const entries = Object.freeze(query.groups.map(
    (group) => createHomeSeriesEntry(group, references),
  ));
  const otherTiers = query.availableTiers.filter(
    (tier) => homeTierCategory(tier).id === OTHER_CATEGORY.id,
  );
  const categories = [
    DEFAULT_CATEGORY,
    ALL_CATEGORY,
    ...TIER_CATEGORIES,
    Object.freeze({ ...OTHER_CATEGORY, tiers: Object.freeze(otherTiers) }),
  ];
  const views = categories.map((category) => homeView(category, entries, query.range));

  return Object.freeze({
    clock: new Date(query.range.endEpoch * 1000).toISOString(),
    limit,
    availableTiers: query.availableTiers,
    entries,
    days: groupEntries(entries),
    views: Object.freeze(views),
  });
}
