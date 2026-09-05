import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SITE_ROOT = path.resolve(import.meta.dirname, '..');
const DIST_ROOT = path.join(SITE_ROOT, 'dist');
const HOME_PAGE = path.join(DIST_ROOT, 'index.html');
const AUDIT = path.join(SITE_ROOT, 'scripts', 'audit-home-series.mjs');
const home = await readFile(HOME_PAGE, 'utf8');
const clock = /data-range-end="([^"]+)"/.exec(home)?.[1];
assert.ok(clock, 'could not read the build clock from the home artifact');

async function command(args) {
  try {
    const result = await run(process.execPath, [AUDIT, '--dist', DIST_ROOT, '--clock', clock, ...args], {
      cwd: SITE_ROOT,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    return { code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function selectedValue(output, name) {
  return new RegExp(`"${name}":(true|false)`).exec(output)?.[1] ?? null;
}

function fileMutation(filename, transform) {
  let original;
  return {
    async apply() {
      original = await readFile(filename, 'utf8');
      const changed = transform(original);
      assert.notEqual(changed, original, `mutation did not change ${filename}`);
      await writeFile(filename, changed, 'utf8');
    },
    async restore() {
      if (original !== undefined) await writeFile(filename, original, 'utf8');
    },
  };
}

async function runAssertion(name, mutation) {
  await mutation.apply();
  let failed;
  try {
    failed = await command(['--only', name]);
  } finally {
    await mutation.restore();
  }
  assert.notEqual(failed.code, 0, `${name} mutation unexpectedly passed`);
  assert.equal(selectedValue(failed.output, name), 'false', `${name} did not report false\n${failed.output}`);
  console.log(`STEP29_NEGATIVE_FAIL=${name}`);
  console.log(failed.output.trim());
  const restored = await command(['--only', name]);
  assert.equal(restored.code, 0, `${name} did not pass after restoration\n${restored.output}`);
  assert.equal(selectedValue(restored.output, name), 'true');
  console.log(`STEP29_NEGATIVE_RESTORED=${name}`);
  console.log(restored.output.trim());
}

function replaceRowResultForMaps(html, mapIds, result) {
  const marker = `data-map-rows="${mapIds.join(',')}"`;
  const markerIndex = html.indexOf(marker);
  assert.ok(markerIndex >= 0, `could not find emitted maps ${mapIds.join(',')}`);
  const rowStart = html.lastIndexOf('<li ', markerIndex);
  const rowOpenEnd = html.indexOf('>', rowStart);
  const opening = html.slice(rowStart, rowOpenEnd + 1);
  const changed = opening.replace(/data-series-result="[^"]+"/, `data-series-result="${result.join(',')}"`);
  assert.notEqual(changed, opening, 'series result mutation did not find its target');
  return `${html.slice(0, rowStart)}${changed}${html.slice(rowOpenEnd + 1)}`;
}

const mapPayloads = [...home.matchAll(/data-map-rows="([\d,]+)"/g)].map((match) => match[1].split(',').map(Number));
const multiMap = mapPayloads.find((maps) => maps.length > 1);
const otherMap = mapPayloads.find((maps) => !multiMap.includes(maps[0]))[0];
assert.ok(multiMap && otherMap);

await runAssertion('emittedRowsMatchIndependentGrouping', fileMutation(HOME_PAGE, (html) => (
  html.replace(`data-map-rows="${mapPayloads[0].join(',')}"`, `data-map-rows="999999999999"`)
)));

await runAssertion('groupingKeyKeepsLeaguePairAndSpanValid', fileMutation(HOME_PAGE, (html) => (
  html.replace(`data-map-rows="${multiMap.join(',')}"`, `data-map-rows="${multiMap.join(',')},${otherMap}"`)
)));

await runAssertion('seriesScoresCountWinsPerTeamId', fileMutation(HOME_PAGE, (html) => (
  html.replace(/data-series-result="(\d+),(\d+),(\d+)"/, (_, one, two, unknown) => (
    `data-series-result="${Number(one) + 1},${two},${unknown}"`
  ))
)));

const baseline = await command(['--only', 'sideSwappedSeriesScoresCorrectly']);
assert.equal(baseline.code, 0, baseline.output);
const auditResult = JSON.parse(/STEP29_HOME_SERIES_AUDIT=(\{.*\})/.exec(baseline.output)?.[1]);
assert.ok(auditResult.swappedMutationExample, 'no side-swapped series with a distinct side score found');
await runAssertion('sideSwappedSeriesScoresCorrectly', fileMutation(HOME_PAGE, (html) => (
  replaceRowResultForMaps(
    html,
    auditResult.swappedMutationExample.maps,
    auditResult.swappedMutationExample.sideScore,
  )
)));

await runAssertion('feedHasExactlyThreeHundredTypedRows', fileMutation(HOME_PAGE, (html) => (
  html.replace('data-series-kind="series"', 'data-series-kind="broken"')
)));

await runAssertion('standaloneRowsAreLabelledAndUnscored', fileMutation(HOME_PAGE, (html) => (
  html.replace('data-row-label="Single game"', 'data-row-label="Series"')
)));

const dayFiles = (await readdir(path.join(DIST_ROOT, 'data', 'home-players'))).filter((name) => name.endsWith('.json')).sort();
const dayFile = path.join(DIST_ROOT, 'data', 'home-players', dayFiles[0]);
await runAssertion('dayShardsContainEveryExpectedPlayerRow', fileMutation(dayFile, (text) => {
  const payload = JSON.parse(text);
  payload.rows[0].account_id = 'not-an-integer';
  return JSON.stringify(payload);
}));

await runAssertion('sixViewsAndApprovedDefaultWorkWithoutJavaScript', fileMutation(HOME_PAGE, (html) => (
  html.replace('data-home-view-option="default"', 'data-home-view-option="broken"')
)));

await runAssertion('activeTournamentsMatchIndependentFourteenDayScan', fileMutation(HOME_PAGE, (html) => (
  html.replace(/data-active-league-id="\d+"/, 'data-active-league-id="999999999"')
)));

const firstDay = /data-player-day="([^"]+)"/.exec(home)?.[1];
assert.ok(firstDay);
await runAssertion('expansionIsLazyAndDayCached', fileMutation(HOME_PAGE, (html) => (
  html.replace('</body>', `<script>fetch('/data/home-players/${firstDay}.json')</script></body>`)
)));

await runAssertion('expandersAndMapTabsAreAccessible', fileMutation(HOME_PAGE, (html) => (
  html.replace(/<button\b[^>]*data-series-expand[^>]*>/, (tag) => tag.replace('aria-expanded="false"', ''))
)));

await runAssertion('expandedScoreboardFitsEveryWidth', fileMutation(HOME_PAGE, (html) => (
  html.replace('</head>', '<style>.series-expansion{min-width:2000px!important}</style></head>')
)));

let seed = 0x29;
const noise = Array.from({ length: 120_000 }, () => {
  seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
  return String.fromCharCode(33 + (seed % 90));
}).join('');
await runAssertion('homeGzipRemainsBounded', fileMutation(HOME_PAGE, (html) => (
  html.replace('</body>', `<!--${noise}--></body>`)
)));

console.log('STEP29_NEGATIVE_STATUS=PASS');
