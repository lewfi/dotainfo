import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function filesBelow(directory, predicate) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(entryPath, predicate));
    else if (predicate(entry.name)) files.push(entryPath);
  }
  return files.sort();
}

function attributes(tag) {
  const parsed = new Map();
  const expression = /\s([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.matchAll(expression)) {
    parsed.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return parsed;
}

function routeForHtml(outputRoot, filename) {
  const relative = path.relative(outputRoot, filename).replaceAll('\\', '/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return `/${relative.slice(0, -'index.html'.length)}`;
  return `/${relative}`;
}

function outputPathForRoute(outputRoot, pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/'
    ? 'index.html'
    : decoded.endsWith('/')
      ? `${decoded.slice(1)}index.html`
      : decoded.slice(1);
  const target = path.resolve(outputRoot, relative);
  if (target !== outputRoot && !target.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error(`internal link escaped build output: ${pathname}`);
  }
  return target;
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function idExists(html, id) {
  const escaped = id.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bid=["']${escaped}["']`).test(html);
}

const distArgument = argument('--dist');
if (!distArgument) {
  console.error('usage: npm run audit:links -- --dist PATH');
  process.exit(2);
}

const outputRoot = path.resolve(distArgument);
const htmlFiles = await filesBelow(outputRoot, (name) => name.endsWith('.html'));
const payloadFiles = await filesBelow(
  path.join(outputRoot, 'data', 'matches'),
  (name) => /^\d{4}-\d{2}\.json$/.test(name),
);
const payloadMatches = new Map();
for (const filename of payloadFiles) {
  const expectedMonth = path.basename(filename, '.json');
  const payload = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(payload.month, expectedMonth, `payload month does not match ${filename}`);
  assert.ok(Array.isArray(payload.matches), `payload matches missing from ${filename}`);
  for (const match of payload.matches) {
    const matchId = Number(match.match_id);
    const startTime = Number(match.start_time);
    assert.ok(Number.isSafeInteger(matchId), `invalid match ID in ${filename}`);
    assert.ok(Number.isFinite(startTime), `invalid start time for ${matchId} in ${filename}`);
    assert.equal(
      new Date(startTime * 1_000).toISOString().slice(0, 7),
      expectedMonth,
      `match ${matchId} is not in payload month ${expectedMonth}`,
    );
    assert.ok(!payloadMatches.has(matchId), `duplicate emitted payload match ID ${matchId}`);
    payloadMatches.set(matchId, Object.freeze({
      month: expectedMonth,
      startTime,
    }));
  }
}

const htmlByFile = new Map();
for (const filename of htmlFiles) htmlByFile.set(filename, await readFile(filename, 'utf8'));
const links = [];
for (const [filename, html] of htmlByFile) {
  const base = new URL(routeForHtml(outputRoot, filename), 'https://dotainfo.invalid');
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attributes(match[0]).get('href');
    if (!href) continue;
    const targetUrl = new URL(href, base);
    if (targetUrl.origin !== base.origin) continue;
    const targetFile = outputPathForRoute(outputRoot, targetUrl.pathname);
    let resolution = 'unresolved';
    if (await exists(targetFile)) {
      if (!targetUrl.hash) resolution = 'static';
      else {
        const targetHtml = htmlByFile.get(targetFile) ?? await readFile(targetFile, 'utf8');
        resolution = idExists(targetHtml, decodeURIComponent(targetUrl.hash.slice(1)))
          ? 'static-fragment'
          : 'unresolved';
      }
    } else {
      const matchRoute = /^\/matches\/(\d+)\/$/.exec(targetUrl.pathname);
      if (matchRoute && payloadMatches.has(Number(matchRoute[1]))) resolution = 'payload';
    }
    links.push(Object.freeze({
      source: routeForHtml(outputRoot, filename),
      href,
      resolution,
    }));
  }
}

const homeHtml = htmlByFile.get(path.join(outputRoot, 'index.html'));
assert.ok(homeHtml, 'emitted home page is missing');
const homeViews = [];
const distinctHomeMatchIds = new Set();
const distinctPayloadFallbackIds = new Set();
for (const section of homeHtml.matchAll(
  /<section\b[^>]*data-home-view="([^"]+)"[^>]*>([\s\S]*?)<\/section>/gi,
)) {
  const matchIds = [...section[2].matchAll(/href="\/matches\/(\d+)\/"/g)]
    .map((match) => Number(match[1]));
  let preRendered = 0;
  let viaPayload = 0;
  let unresolved = 0;
  for (const matchId of matchIds) {
    distinctHomeMatchIds.add(matchId);
    if (await exists(path.join(outputRoot, 'matches', String(matchId), 'index.html'))) {
      preRendered += 1;
    } else if (payloadMatches.has(matchId)) {
      viaPayload += 1;
      distinctPayloadFallbackIds.add(matchId);
    } else unresolved += 1;
  }
  homeViews.push(Object.freeze({
    view: section[1],
    links: matchIds.length,
    preRendered,
    viaPayload,
    unresolved,
  }));
}

const fallbackTimes = [...distinctPayloadFallbackIds]
  .map((matchId) => payloadMatches.get(matchId).startTime)
  .filter(Number.isFinite);
const resolutionCounts = Object.fromEntries(
  ['static', 'static-fragment', 'payload', 'unresolved'].map((resolution) => [
    resolution,
    links.filter((link) => link.resolution === resolution).length,
  ]),
);
const assertions = Object.freeze({
  everyInternalHrefResolves: resolutionCounts.unresolved === 0,
  homeViewsWereFound: homeViews.length > 0,
  everyHomeViewLinkResolves: homeViews.every((view) => view.unresolved === 0),
});

console.log(`STEP17_HOME_LINKS=${JSON.stringify({
  views: homeViews,
  totalLinks: homeViews.reduce((sum, view) => sum + view.links, 0),
  distinctMatchIds: distinctHomeMatchIds.size,
  distinctPayloadFallbackIds: distinctPayloadFallbackIds.size,
  payloadFallbackStartUtc: fallbackTimes.length > 0
    ? new Date(Math.min(...fallbackTimes) * 1_000).toISOString()
    : null,
  payloadFallbackEndUtc: fallbackTimes.length > 0
    ? new Date(Math.max(...fallbackTimes) * 1_000).toISOString()
    : null,
})}`);
console.log(`STEP17_INTERNAL_HREFS=${JSON.stringify({
  htmlFiles: htmlFiles.length,
  payloadFiles: payloadFiles.length,
  payloadMatchIds: payloadMatches.size,
  internalHrefs: links.length,
  resolutionCounts,
})}`);
console.log(`STEP17_LINK_ASSERTIONS=${JSON.stringify(assertions)}`);
assert.ok(Object.values(assertions).every(Boolean), 'Step 17 link-integrity assertions failed');
console.log('STEP17_LINK_STATUS=PASS');
