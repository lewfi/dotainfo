import assert from 'node:assert/strict';

import { createCatalog } from '../src/data/catalog.mjs';
import { DataReader } from '../src/data/queries.mjs';
import { loadReferences } from '../src/data/references.mjs';
import { createHomeFeedViews, DEFAULT_HOME_TIERS } from '../src/presentation/home-feed.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function category(tier) {
  if (tier === 'premium') return 'top';
  if (tier === 'professional') return 'pro';
  if (tier === 'amateur') return 'amateur';
  return 'other';
}

function included(entry, view) {
  const id = category(entry.leagueTier);
  if (view.id === 'all') return true;
  if (view.id === 'default') return id === 'top' || id === 'pro';
  return view.id === id;
}

const clock = argument('--clock');
const limit = Number(argument('--limit') ?? 300);
if (!clock || !Number.isInteger(limit) || limit <= 0) {
  console.error('usage: npm run audit:home -- --clock YYYY-MM-DDTHH:mm:ssZ [--limit N]');
  process.exit(2);
}

const catalog = await createCatalog();
const references = await loadReferences();
const reader = await DataReader.create(catalog);
let home;
try {
  home = await createHomeFeedViews({ reader, references, clock, limit });
} finally {
  reader.close();
}

const viewResults = home.views.map((view) => {
  const directCount = home.entries.filter((entry) => included(entry, view)).length;
  const result = Object.freeze({
    id: view.id,
    selectedTiers: view.selectedTiers,
    renderedCount: view.resultCount,
    directCount,
    hiddenCount: view.hiddenCount,
  });
  console.log(`STEP13_${view.id.toUpperCase()}=${JSON.stringify(result)}`);
  return result;
});

const assertions = Object.freeze({
  oneBoundedPopulationFeedsEveryView: home.entries.length === limit,
  newestFirstBySeriesEnd: home.entries.every((entry, index) => (
    index === 0 || home.entries[index - 1].maps.at(-1).row.start_time >= entry.maps.at(-1).row.start_time
  )),
  allSixApprovedViewsRemain: home.views.map((view) => view.id).join('|')
    === 'default|all|top|pro|amateur|other',
  defaultRemainsPremiumAndProfessional:
    home.views[0].label === 'Top tier + Pro'
    && JSON.stringify(home.views[0].selectedTiers) === JSON.stringify(DEFAULT_HOME_TIERS),
  everyViewCountMatchesItsRows: viewResults.every((view) => (
    view.renderedCount === view.directCount
    && view.hiddenCount === home.entries.length - view.directCount
  )),
});

console.log(`STEP13_CLOCK=${clock}`);
console.log(`STEP13_LIMIT=${limit}`);
console.log(`STEP13_AVAILABLE_TIERS=${JSON.stringify(home.availableTiers)}`);
console.log(`STEP13_ASSERTIONS=${JSON.stringify(assertions)}`);
assert.ok(Object.values(assertions).every(Boolean), 'Step 13 home assertions failed');
console.log('STEP13_STATUS=PASS');
