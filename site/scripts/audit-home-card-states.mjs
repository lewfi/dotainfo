import { createCatalog } from '../src/data/catalog.mjs';
import { DataReader } from '../src/data/queries.mjs';
import { loadReferences } from '../src/data/references.mjs';
import { createHomeFeedViews } from '../src/presentation/home-feed.mjs';

const clock = process.env.DOTAINFO_BUILD_CLOCK ?? new Date().toISOString();
const catalog = await createCatalog();
const references = await loadReferences();
const reader = await DataReader.create(catalog);

function blank(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

function sideState(row, summary, side) {
  const teamId = row[`${side}_team_id`];
  const writeTimeName = row[`${side}_team_name`];
  const team = summary.teams[side];
  return Object.freeze({
    side,
    teamId,
    nullTeamId: teamId === null,
    blankWriteTimeName: teamId !== null && blank(writeTimeName),
    tagFallback: team.name.source === 'reference-tag',
    missingLogo: team.logo.status === 'missing',
  });
}

function freshCase() {
  return {
    placementKeys: new Set(),
    matchIds: new Set(),
    sideAppearances: 0,
    teamIds: new Set(),
    examples: [],
    exampleWithNonNullTeamId: null,
  };
}

function record(target, placementKey, matchId, side = null) {
  target.placementKeys.add(placementKey);
  target.matchIds.add(matchId);
  if (side) {
    target.sideAppearances += 1;
    if (side.teamId !== null) target.teamIds.add(side.teamId);
    if (side.teamId !== null && target.exampleWithNonNullTeamId === null) {
      target.exampleWithNonNullTeamId = { matchId, side: side.side, teamId: side.teamId };
    }
  }
  if (target.examples.length < 5) {
    target.examples.push({ matchId, ...(side ? { side: side.side, teamId: side.teamId } : {}) });
  }
}

function output(target) {
  return Object.freeze({
    cardPlacements: target.placementKeys.size,
    uniqueMatches: target.matchIds.size,
    sideAppearances: target.sideAppearances,
    distinctNonNullTeamIds: target.teamIds.size,
    examples: Object.freeze(target.examples),
    exampleWithNonNullTeamId: target.exampleWithNonNullTeamId,
  });
}

let home;
try {
  home = await createHomeFeedViews({ reader, references, clock, limit: 300 });
} finally {
  reader.close();
}

const aggregate = {
  nullTeamId: freshCase(),
  blankWriteTimeName: freshCase(),
  tagFallback: freshCase(),
  nullResultAndScore: freshCase(),
  missingLogo: freshCase(),
};
const viewCounts = [];
const allMatchIds = new Set();

for (const view of home.views) {
  const entries = home.entries.filter((entry) => {
    if (view.id === 'all') return true;
    const tier = entry.leagueTier;
    const category = tier === 'premium' ? 'top'
      : tier === 'professional' ? 'pro'
        : tier === 'amateur' ? 'amateur' : 'other';
    return view.id === 'default' ? category === 'top' || category === 'pro' : view.id === category;
  });
  const counts = {
    id: view.id,
    label: view.label,
    cards: entries.length,
    nullTeamId: 0,
    blankWriteTimeName: 0,
    tagFallback: 0,
    nullResultAndScore: 0,
    missingLogo: 0,
  };
  for (const [index, entry] of entries.entries()) {
    const placementKey = `${view.id}:${index}`;
    for (const map of entry.maps) {
      const { row, summary } = map;
      allMatchIds.add(summary.matchId);
      const sides = [sideState(row, summary, 'radiant'), sideState(row, summary, 'dire')];
      for (const side of sides) {
        for (const key of ['nullTeamId', 'blankWriteTimeName', 'tagFallback', 'missingLogo']) {
          if (!side[key]) continue;
          counts[key] += 1;
          record(aggregate[key], placementKey, summary.matchId, side);
        }
      }
      if (row.radiant_win === null && row.radiant_score === null && row.dire_score === null) {
        counts.nullResultAndScore += 1;
        record(aggregate.nullResultAndScore, placementKey, summary.matchId);
      }
    }
  }
  viewCounts.push(Object.freeze(counts));
}

console.log(`STEP19_HOME_CLOCK=${home.clock}`);
console.log(`STEP19_HOME_VIEWS=${JSON.stringify(viewCounts)}`);
console.log(`STEP19_HOME_CARDS=${home.entries.length}`);
console.log(`STEP19_HOME_UNIQUE_MATCHES=${allMatchIds.size}`);
for (const [key, value] of Object.entries(aggregate)) {
  console.log(`STEP19_${key.replaceAll(/([A-Z])/g, '_$1').toUpperCase()}=${JSON.stringify(output(value))}`);
}
