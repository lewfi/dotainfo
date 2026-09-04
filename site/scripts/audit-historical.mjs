import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  HISTORICAL_MATCH_COLUMNS,
  historicalMatchShards,
} from '../src/data/historical-artifacts.mjs';
import { openDuckDB, queryRows, sourceUnionSql } from '../src/data/duckdb.mjs';
import { loadReferences } from '../src/data/references.mjs';
import {
  historicalRouteView,
  resolveHistoricalMatch,
} from '../src/presentation/historical-route.mjs';

const ASSET_LIMIT_BYTES = 25 * 1024 * 1024;
const FILE_LIMIT = 20_000;
const INCOMPLETE_IDS = Object.freeze([
  7445599470,
  7468132951,
  7477639498,
  7480980391,
  7484575133,
  7485890286,
  7488997459,
]);
const ORDINARY_OLD_ID = 7485948611;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function readNdjsonIfPresent(filePath) {
  try {
    return (await readFile(filePath, 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function startTimeMonth(startTime) {
  if (!Number.isSafeInteger(startTime)) {
    throw new TypeError(`late match has invalid start_time: ${startTime}`);
  }
  const date = new Date(startTime * 1_000);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`late match has invalid start_time: ${startTime}`);
  }
  return date.toISOString().slice(0, 7);
}

async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    count += entry.isDirectory() ? await countFiles(entryPath) : 1;
  }
  return count;
}

function rangeOverlapCount(ranges) {
  let overlaps = 0;
  for (let left = 0; left < ranges.length; left += 1) {
    for (let right = left + 1; right < ranges.length; right += 1) {
      if (
        ranges[left].min_match_id <= ranges[right].max_match_id
        && ranges[right].min_match_id <= ranges[left].max_match_id
      ) overlaps += 1;
    }
  }
  return overlaps;
}

function rangeGap(manifest, payloads) {
  for (const range of manifest.ranges) {
    const ids = payloads.get(range.month).matches.map((match) => match.match_id);
    for (let index = 1; index < ids.length; index += 1) {
      if (ids[index] > ids[index - 1] + 1) return ids[index - 1] + 1;
    }
  }
  throw new Error('no in-range match ID gap was found');
}

function incompleteAssertion(row, view) {
  const { summary, markup } = view;
  return summary.matchId === row.match_id
    && summary.teams.radiant.name.status === 'missing'
    && summary.teams.dire.name.status === 'missing'
    && summary.result.status === 'missing'
    && summary.score.status === 'missing'
    && summary.league.leagueId === row.leagueid
    && summary.league.name.display.trim().length > 0
    && summary.duration.status === 'available'
    && summary.duration.value === row.duration
    && summary.patch.status === 'available'
    && summary.patch.value === row.patch
    && summary.date.status === 'available'
    && summary.date.epochSeconds === row.start_time
    && (markup.match(/Team name unavailable/g) ?? []).length >= 2
    && markup.includes('Result unavailable')
    && markup.includes('Score unavailable')
    && !markup.includes('undefined');
}

function ordinaryAssertion(row, view) {
  const { summary, markup } = view;
  const expectedWinner = row.radiant_win ? 'radiant' : 'dire';
  return summary.teams.radiant.name.status === 'available'
    && summary.teams.dire.name.status === 'available'
    && summary.teams.radiant.teamId === row.radiant_team_id
    && summary.teams.dire.teamId === row.dire_team_id
    && summary.result.status === 'available'
    && summary.result.winner === expectedWinner
    && summary.score.status === 'available'
    && summary.score.radiant === row.radiant_score
    && summary.score.dire === row.dire_score
    && summary.league.leagueId === row.leagueid
    && summary.duration.value === row.duration
    && summary.patch.value === row.patch
    && summary.date.epochSeconds === row.start_time
    && markup.includes(summary.teams.radiant.name.display)
    && markup.includes(summary.teams.dire.name.display)
    && markup.includes(`${row.radiant_score}–${row.dire_score}`)
    && !markup.includes('undefined');
}

const distArgument = argument('--dist');
if (!distArgument) {
  console.error('usage: npm run audit:historical -- --dist PATH');
  process.exit(2);
}

const outputRoot = path.resolve(distArgument);
const artifactRoot = path.join(outputRoot, 'data', 'matches');
const archiveHtml = await readFile(path.join(outputRoot, '404.html'), 'utf8');
const archiveModuleHref = /<script type="module" src="([^"]+)"><\/script>/.exec(archiveHtml)?.[1]
  ?? null;
const archiveClientBundle = archiveModuleHref
  ? await readFile(path.join(outputRoot, ...archiveModuleHref.split('/').filter(Boolean)), 'utf8')
  : '';
const expectedShards = await historicalMatchShards();
const entries = await readdir(artifactRoot, { withFileTypes: true });
const payloadEntries = entries
  .filter((entry) => entry.isFile() && /^\d{4}-\d{2}\.json$/.test(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name));

let rawBytes = 0;
let gzipBytes = 0;
let rows = 0;
let excludedAdvantageFields = true;
let exactColumns = true;
let payloadMatchIdsAreUnique = true;
let largest = { month: null, bytes: 0 };
const payloads = new Map();
for (const entry of payloadEntries) {
  const month = entry.name.slice(0, 7);
  const buffer = await readFile(path.join(artifactRoot, entry.name));
  const payload = JSON.parse(buffer.toString('utf8'));
  payloads.set(month, payload);
  rawBytes += buffer.byteLength;
  gzipBytes += gzipSync(buffer, { level: 9 }).byteLength;
  rows += payload.matches.length;
  payloadMatchIdsAreUnique &&= new Set(
    payload.matches.map((match) => match.match_id),
  ).size === payload.matches.length;
  if (buffer.byteLength > largest.bytes) largest = { month, bytes: buffer.byteLength };
  for (const match of payload.matches) {
    excludedAdvantageFields &&= !Object.hasOwn(match, 'radiant_gold_adv')
      && !Object.hasOwn(match, 'radiant_xp_adv');
    exactColumns &&= Object.keys(match).sort().join(',')
      === [...HISTORICAL_MATCH_COLUMNS].sort().join(',');
  }
}

const matchRoot = expectedShards.length > 0
  ? path.dirname(expectedShards[0].path)
  : path.resolve(process.cwd(), '../data/matches');
const lateRows = await readNdjsonIfPresent(path.join(matchRoot, 'late.ndjson'));
const lateRowsByMonth = new Map();
for (const row of lateRows) {
  const month = startTimeMonth(row.start_time);
  if (!lateRowsByMonth.has(month)) lateRowsByMonth.set(month, []);
  lateRowsByMonth.get(month).push(row);
}
const regularMonths = new Set(expectedShards.map((shard) => shard.month));
const orphanLateMonths = [...lateRowsByMonth.keys()]
  .filter((month) => !regularMonths.has(month))
  .sort();
const lateRowsAppearInStartTimeMonth = [...lateRowsByMonth].every(([month, monthRows]) => {
  const payloadIds = new Set(
    (payloads.get(month)?.matches ?? []).map((match) => match.match_id),
  );
  return monthRows.every((row) => payloadIds.has(row.match_id));
});
const lateRowsStayInStartTimeMonth = lateRows.every((row) => {
  const expectedMonth = startTimeMonth(row.start_time);
  return [...payloads].every(([month, payload]) => month === expectedMonth
    || payload.matches.every((match) => match.match_id !== row.match_id));
});

let everyRegularMatchRemainsInItsShardPayload = true;
let regularRows = 0;
const database = await openDuckDB();
try {
  for (const shard of expectedShards) {
    const directRows = await queryRows(
      database.connection,
      sourceUnionSql([shard], 'matches', ['match_id']),
    );
    regularRows += directRows.length;
    const payloadIds = new Set(
      (payloads.get(shard.month)?.matches ?? []).map((match) => match.match_id),
    );
    everyRegularMatchRemainsInItsShardPayload &&= directRows.every(
      (row) => payloadIds.has(row.match_id),
    );
  }
} finally {
  database.close();
}

const manifestBuffer = await readFile(path.join(artifactRoot, 'manifest.json'));
const manifest = JSON.parse(manifestBuffer.toString('utf8'));
const manifestGzipBytes = gzipSync(manifestBuffer, { level: 9 }).byteLength;
let manifestMatchesPayloads = manifest.ranges.length === payloadEntries.length;
for (const range of manifest.ranges) {
  const payload = payloads.get(range.month);
  const ids = payload?.matches.map((match) => match.match_id) ?? [];
  manifestMatchesPayloads &&= ids.length > 0
    && Math.min(...ids) === range.min_match_id
    && Math.max(...ids) === range.max_match_id;
}
const overlaps = rangeOverlapCount(manifest.ranges);
const references = await loadReferences();
const loadMonth = async (month) => payloads.get(month);

const incompleteResults = [];
let renderedHistoricalDate = null;
for (const matchId of INCOMPLETE_IDS) {
  const resolved = await resolveHistoricalMatch(matchId, { manifest, loadMonth });
  const view = historicalRouteView(matchId, resolved, references);
  if (matchId === 7485890286 && resolved.status === 'found') {
    const renderedTime = /<time datetime="([^"]+)" data-date-display="absolute">([^<]+)<\/time>/
      .exec(view.markup);
    renderedHistoricalDate = Object.freeze({
      datetime: renderedTime?.[1] ?? null,
      expectedDatetime: new Date(resolved.match.start_time * 1_000).toISOString(),
      text: renderedTime?.[2] ?? null,
      relativeMarker: view.markup.includes('data-relative-time'),
      rawIsoVisible: view.markup.includes(`>${view.summary.date.isoUtc}</time>`),
    });
  }
  incompleteResults.push({
    matchId,
    status: resolved.status,
    assertion: resolved.status === 'found' && incompleteAssertion(resolved.match, view),
  });
}

const ordinaryResolved = await resolveHistoricalMatch(ORDINARY_OLD_ID, { manifest, loadMonth });
const ordinaryView = historicalRouteView(ORDINARY_OLD_ID, ordinaryResolved, references);
const ordinaryPassed = ordinaryResolved.status === 'found'
  && ordinaryAssertion(ordinaryResolved.match, ordinaryView);

const gapId = rangeGap(manifest, payloads);
const gapResolved = await resolveHistoricalMatch(gapId, { manifest, loadMonth });
const gapView = historicalRouteView(gapId, gapResolved, references);
const outsideId = 1;
const outsideResolved = await resolveHistoricalMatch(outsideId, { manifest, loadMonth });
const outsideView = historicalRouteView(outsideId, outsideResolved, references);
const notFoundPassed = [gapView, outsideView].every(
  (view) => view.status === 'not-found'
    && view.title === 'Match not found'
    && view.markup.trim().length > 0,
);

const syntheticChecked = [];
const syntheticResolved = await resolveHistoricalMatch(150, {
  manifest: {
    ranges: [
      { month: 'a', min_match_id: 100, max_match_id: 200 },
      { month: 'b', min_match_id: 125, max_match_id: 225 },
    ],
  },
  async loadMonth(month) {
    syntheticChecked.push(month);
    return { matches: month === 'b' ? [{ match_id: 150 }] : [] };
  },
});
const overlappingCandidatesChecked = syntheticResolved.status === 'found'
  && syntheticChecked.length === 2
  && syntheticChecked.includes('a')
  && syntheticChecked.includes('b');

const totalFiles = await countFiles(outputRoot);
const assertions = Object.freeze({
  payloadCountMatchesCommittedShards: payloadEntries.length === expectedShards.length,
  everyPayloadHasExactMatchOnlyColumns: exactColumns,
  advantageArraysExcludedEntirely: excludedAdvantageFields,
  lateRowsAppearInStartTimeMonth,
  lateRowsStayInStartTimeMonth,
  payloadMatchIdsAreUnique,
  everyRegularMatchRemainsInItsShardPayload,
  everyLateMonthHasRegularShard: orphanLateMonths.length === 0,
  manifestMatchesEveryPayloadRange: manifestMatchesPayloads,
  observedMonthRangesHaveZeroOverlaps: overlaps === 0,
  allSevenIncompleteMatchesRenderExplicitUnknowns:
    incompleteResults.every((result) => result.assertion),
  ordinaryOldMatchRendersCorrectSummary: ordinaryPassed,
  rangeGapAndOutsideIdsRenderCleanNotFound: notFoundPassed,
  overlappingFutureRangesCheckEveryCandidate: overlappingCandidatesChecked,
  emittedArchiveLoadsAbsoluteDateRenderer:
    archiveModuleHref !== null && archiveClientBundle.includes('data-date-display="absolute"'),
  historicalClientOutputUsesReadableAbsoluteDate:
    renderedHistoricalDate?.datetime === renderedHistoricalDate?.expectedDatetime
      && renderedHistoricalDate?.text === 'December 13, 2023'
      && renderedHistoricalDate?.relativeMarker === false
      && renderedHistoricalDate?.rawIsoVisible === false,
  largestPayloadFitsAssetLimit: largest.bytes < ASSET_LIMIT_BYTES,
  totalFilesFitFreePlanLimit: totalFiles < FILE_LIMIT,
});

console.log(`STEP15_PAYLOADS=${JSON.stringify({
  count: payloadEntries.length,
  committedShards: expectedShards.length,
  matches: rows,
  rawBytes,
  gzipBytes,
})}`);
console.log(`STEP24_LATE_ROWS=${JSON.stringify({
  filePresent: lateRows.length > 0,
  rows: lateRows.length,
  rowsByMonth: Object.fromEntries(
    [...lateRowsByMonth].map(([month, monthRows]) => [month, monthRows.length]),
  ),
  regularRows,
  orphanMonths: orphanLateMonths,
})}`);
console.log(`STEP15_MANIFEST=${JSON.stringify({
  ranges: manifest.ranges.length,
  rawBytes: manifestBuffer.byteLength,
  gzipBytes: manifestGzipBytes,
  overlapPairs: overlaps,
})}`);
console.log(`STEP15_LARGEST_PAYLOAD=${JSON.stringify({
  ...largest,
  limitBytes: ASSET_LIMIT_BYTES,
  headroomBytes: ASSET_LIMIT_BYTES - largest.bytes,
  headroomPercent: Number((((ASSET_LIMIT_BYTES - largest.bytes) / ASSET_LIMIT_BYTES) * 100).toFixed(3)),
})}`);
console.log(`STEP15_EMITTED_FILES=${JSON.stringify({
  count: totalFiles,
  limit: FILE_LIMIT,
  headroom: FILE_LIMIT - totalFiles,
})}`);
console.log(`STEP15_INCOMPLETE_ROUTES=${JSON.stringify(incompleteResults)}`);
console.log(`STEP15_ORDINARY_ROUTE=${JSON.stringify({ matchId: ORDINARY_OLD_ID, assertion: ordinaryPassed })}`);
console.log(`STEP15_NOT_FOUND=${JSON.stringify({
  rangeGapId: gapId,
  rangeGapState: gapView.status,
  outsideId,
  outsideState: outsideView.status,
})}`);
console.log(`STEP15_HISTORICAL_DATE=${JSON.stringify({
  emittedArchiveModule: archiveModuleHref,
  ...renderedHistoricalDate,
})}`);
console.log(`STEP15_ASSERTIONS=${JSON.stringify(assertions)}`);
assert.ok(Object.values(assertions).every(Boolean), 'Step 15 assertions failed');
console.log('STEP15_STATUS=PASS');
