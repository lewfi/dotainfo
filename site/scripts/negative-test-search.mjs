import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SITE_ROOT = path.resolve(import.meta.dirname, '..');
const DIST_ROOT = path.join(SITE_ROOT, 'dist');
const SEARCH_AUDIT = path.join(SITE_ROOT, 'scripts', 'audit-search.mjs');
const LINK_AUDIT = path.join(SITE_ROOT, 'scripts', 'audit-links.mjs');

async function command(script, args) {
  try {
    const result = await run(process.execPath, [script, ...args], {
      cwd: SITE_ROOT,
      maxBuffer: 32 * 1024 * 1024,
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
    failed = await command(SEARCH_AUDIT, ['--dist', DIST_ROOT, '--only', name]);
  } finally {
    await mutation.restore();
  }
  assert.notEqual(failed.code, 0, `${name} mutation unexpectedly passed`);
  assert.equal(selectedValue(failed.output, name), 'false', `${name} did not report false\n${failed.output}`);
  console.log(`STEP28_NEGATIVE_FAIL=${name}`);
  console.log(failed.output.trim());
  const restored = await command(SEARCH_AUDIT, ['--dist', DIST_ROOT, '--only', name]);
  assert.equal(restored.code, 0, `${name} did not pass after restoration\n${restored.output}`);
  assert.equal(selectedValue(restored.output, name), 'true');
  console.log(`STEP28_NEGATIVE_RESTORED=${name}`);
  console.log(restored.output.trim());
}

const indexFile = path.join(DIST_ROOT, 'data', 'search-index.json');
const searchPage = path.join(DIST_ROOT, 'search', 'index.html');
const homePage = path.join(DIST_ROOT, 'index.html');
const index = JSON.parse(await readFile(indexFile, 'utf8'));
const counts = new Map();
for (const name of index.t.n) counts.set(name, (counts.get(name) ?? 0) + 1);
const uniqueIndex = index.t.n.findIndex((name) => counts.get(name) === 1);
assert.ok(uniqueIndex >= 0);
const uniqueTeam = index.t.i[uniqueIndex];
const teamPage = path.join(DIST_ROOT, 'teams', String(uniqueTeam), 'index.html');
const hiddenTeamPage = `${teamPage}.negative-test`;

await runAssertion('indexAndPagesCoverEachOther', {
  async apply() { await rename(teamPage, hiddenTeamPage); },
  async restore() { await rename(hiddenTeamPage, teamPage); },
});

await runAssertion('entryCountsMatchIndependentUnprunedScan', fileMutation(indexFile, (text) => {
  const value = JSON.parse(text);
  for (const key of ['i', 'n']) value.h[key].pop();
  return JSON.stringify(value);
}));

await runAssertion('namesTagsAndWeightsMatchIndependentSource', fileMutation(indexFile, (text) => {
  const value = JSON.parse(text);
  value.t.n[uniqueIndex] = 'Broken search name';
  return JSON.stringify(value);
}));

await runAssertion('compactColumnsHaveValidIntegerIdsAndValues', fileMutation(indexFile, (text) => {
  const value = JSON.parse(text);
  value.t.i[0] = String(value.t.i[0]);
  return JSON.stringify(value);
}));

await runAssertion('indexIsExternalAndHomeStaysBounded', fileMutation(homePage, (html) => (
  html.replace('</body>', `<script type="application/json">${JSON.stringify(index)}</script></body>`)
)));

await runAssertion('searchIsLazyAndSessionCached', fileMutation(searchPage, (html) => (
  html.replace('</body>', '<script>fetch("/data/search-index.json")</script></body>')
)));

await runAssertion('noJavaScriptFallbackResolvesBrowseLinks', fileMutation(searchPage, (html) => {
  const match = /<noscript>([\s\S]*?)<\/noscript>/.exec(html);
  assert.ok(match);
  return html.replace(match[0], match[0].replace('href="/teams/"', 'href="/teams-missing/"'));
}));

await runAssertion('sharedNameDiscriminatorsMatchDestinationTitles', fileMutation(indexFile, (text) => {
  const value = JSON.parse(text);
  assert.ok(value.t.c.y.length > 0);
  value.t.c.y[0] = 9999;
  return JSON.stringify(value);
}));

await runAssertion('keyboardResultsAreLabeledAnnouncedAndResponsive', fileMutation(
  searchPage,
  (html) => html.replace('for="page-search"', 'for="broken-page-search"'),
));

const linkMutation = fileMutation(homePage, (html) => html.replace('href="/search/"', 'href="/search-missing/"'));
await linkMutation.apply();
let failedLink;
try {
  failedLink = await command(LINK_AUDIT, ['--dist', DIST_ROOT]);
} finally {
  await linkMutation.restore();
}
assert.notEqual(failedLink.code, 0, 'search href mutation unexpectedly passed');
assert.equal(selectedValue(failedLink.output, 'everySearchHrefResolves'), 'false');
console.log('STEP28_NEGATIVE_FAIL=everySearchHrefResolves');
console.log(failedLink.output.trim());
const restoredLink = await command(LINK_AUDIT, ['--dist', DIST_ROOT]);
assert.equal(restoredLink.code, 0, `search href did not pass after restoration\n${restoredLink.output}`);
assert.equal(selectedValue(restoredLink.output, 'everySearchHrefResolves'), 'true');
console.log('STEP28_NEGATIVE_RESTORED=everySearchHrefResolves');
console.log(restoredLink.output.trim());
console.log('STEP28_NEGATIVE_STATUS=PASS');
