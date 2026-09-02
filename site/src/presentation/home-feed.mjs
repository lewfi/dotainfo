import { createMatchSummary } from './match-summary.mjs';

export const DEFAULT_HOME_TIERS = Object.freeze(['premium', 'professional']);

export function homeTierLabel(tier) {
  if (tier === null) {
    return 'Tier unavailable';
  }
  const label = tier.trim();
  return label || 'Tier unavailable';
}

function homeView(id, label, query, references) {
  return Object.freeze({
    id,
    label,
    selectedTiers: query.selectedTiers,
    matches: Object.freeze(query.rows.map((row) => createMatchSummary(row, references))),
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
  const defaultQuery = await reader.home({ clock, limit, tiers: DEFAULT_HOME_TIERS });
  const views = [
    homeView('default', 'Premium + professional', defaultQuery, references),
    homeView('all', 'All tiers', allQuery, references),
  ];

  for (const [index, tier] of allQuery.availableTiers.entries()) {
    const query = await reader.home({ clock, limit, tiers: [tier] });
    views.push(homeView(`tier-${index}`, homeTierLabel(tier), query, references));
  }

  return Object.freeze({
    clock: new Date(allQuery.range.endEpoch * 1000).toISOString(),
    limit,
    availableTiers: allQuery.availableTiers,
    views: Object.freeze(views),
  });
}
