import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { directRecentComposition } from '../src/data/direct-recent-audit.mjs';
import { directWindowAudit } from '../src/data/direct-window-audit.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function emittedMatchPages(outputRoot) {
  const matchesRoot = path.join(outputRoot, 'matches');
  let entries;
  try {
    entries = await readdir(matchesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const pages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const filePath = path.join(matchesRoot, entry.name, 'index.html');
    try {
      await readFile(filePath, 'utf8');
      pages.push(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return pages.sort();
}

const clock = argument('--clock');
if (!clock) {
  console.error('usage: npm run audit:recent -- --clock YYYY-MM-DDTHH:mm:ssZ [--dist PATH]');
  process.exit(2);
}

const composition = await directRecentComposition({ clock });
console.log(`STEP14_COMPOSITION_CLOCK=${clock}`);
console.log(`STEP14_COMPOSITION=${JSON.stringify(composition)}`);

const dist = argument('--dist');
if (dist) {
  const outputRoot = path.resolve(dist);
  const [directWindow] = await directWindowAudit({ clock, days: [90] });
  const pages = await emittedMatchPages(outputRoot);
  let invalidTeamDisplays = 0;
  let advantageGraphPages = 0;
  let unavailableDraftPages = 0;
  for (const page of pages) {
    const html = await readFile(page, 'utf8');
    if (html.includes('data-advantage-graph')) advantageGraphPages += 1;
    if (html.includes('data-draft-state="unavailable"')) unavailableDraftPages += 1;
    const displays = [...html.matchAll(/data-team-display="([^"]*)"/g)];
    if (
      displays.length !== 2
      || displays.some((match) => {
        const display = match[1].trim();
        return display === '' || display === 'undefined';
      })
    ) {
      invalidTeamDisplays += 1;
    }
  }
  const assertions = Object.freeze({
    emittedRoutesMatchIndependentDirectScan: pages.length === directWindow.count,
    everyPageHasDefinedNonEmptyTeamDisplays: invalidTeamDisplays === 0,
    graphPagesMatchDirectComposition: advantageGraphPages === composition.gold_present,
    unavailableDraftPagesMatchDirectComposition:
      unavailableDraftPages === composition.zero_draft_matches,
  });
  console.log(`STEP14_EXPECTED_ROUTES_DIRECT=${directWindow.count}`);
  console.log(`STEP14_EMITTED_MATCH_ROUTES=${pages.length}`);
  console.log(`STEP14_ADVANTAGE_GRAPH_PAGES=${advantageGraphPages}`);
  console.log(`STEP14_UNAVAILABLE_DRAFT_PAGES=${unavailableDraftPages}`);
  console.log(`STEP14_INVALID_TEAM_DISPLAY_PAGES=${invalidTeamDisplays}`);
  console.log(`STEP14_ASSERTIONS=${JSON.stringify(assertions)}`);
  assert.ok(Object.values(assertions).every(Boolean), 'Step 14 route assertions failed');
  console.log('STEP14_STATUS=PASS');
}
