import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME_PATHS = Object.freeze([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]);
const SPEC_PATH = fileURLToPath(new URL('../../HANDOFF.md', import.meta.url));
const ASSERTION_NAMES = Object.freeze([
  'archiveRuntimeUsesDistinctSummaryClass',
  'scoreboardsHaveSevenColumnsAndAccessibleExpansions',
  'emittedThemeTokensControlDetailAndArchive',
  'containerQuerySwitchesAtItsEmittedThreshold',
  'exactWidthSweepHasNoHorizontalOverflow',
  'homeHintsAvoidRedundantTitleAndPreserveNoJsViews',
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function contentType(filename) {
  if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filename.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filename.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filename.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

async function staticServer(root) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const candidate = path.resolve(root, relative.endsWith('/') ? `${relative}index.html` : relative);
      assert.ok(candidate === root || candidate.startsWith(`${root}${path.sep}`));
      const details = await stat(candidate);
      if (!details.isFile()) throw new Error('not a file');
      response.writeHead(200, { 'content-type': contentType(candidate) });
      createReadStream(candidate).pipe(response);
    } catch {
      if (/^\/matches\/\d+\/?$/.test(url.pathname)) {
        const fallback = path.join(root, '404.html');
        response.writeHead(200, { 'content-type': contentType(fallback) });
        createReadStream(fallback).pipe(response);
      } else {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', async (event) => {
      const payload = typeof event.data === 'string'
        ? event.data
        : event.data instanceof Blob
          ? await event.data.text()
          : new TextDecoder().decode(event.data);
      const message = JSON.parse(payload);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      const listeners = this.events.get(message.method) ?? [];
      this.events.delete(message.method);
      for (const resolve of listeners) resolve(message.params);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  event(method) {
    return new Promise((resolve) => {
      const listeners = this.events.get(method) ?? [];
      listeners.push(resolve);
      this.events.set(method, listeners);
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitForChrome(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function newTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
    signal: AbortSignal.timeout(2_000),
  });
  assert.ok(response.ok, `could not create Chrome target: ${response.status}`);
  return new CdpClient((await response.json()).webSocketDebuggerUrl);
}

async function browserMeasurements(chrome, scratch, origin, requests, selectors) {
  const profile = await mkdtemp(path.join(scratch, 'step23-cdp-'));
  const port = await freePort();
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-gpu',
    '--disable-extensions',
    '--no-default-browser-check',
    '--no-first-run',
    '--no-proxy-server',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let client = null;
  try {
    await waitForChrome(port);
    const results = [];
    client = await newTarget(port);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');
    await client.send('Network.setBlockedURLs', { urls: ['https://*'] });
    for (const request of requests) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: request.width,
        height: 1_000,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await client.send('Page.navigate', { url: `${origin}${request.pathname}` });
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          const state = await client.send('Runtime.evaluate', {
            expression: 'document.readyState',
            returnByValue: true,
          });
          ready = state.result.value === 'interactive' || state.result.value === 'complete';
        } catch {
          // Navigation can replace the execution context between the command and evaluation.
        }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(ready, `${request.route} did not reach DOM ready state at ${request.width}px`);
      if (request.route === 'archive') {
        await client.send('Runtime.evaluate', {
            expression: `new Promise((resolve) => {
              const deadline = Date.now() + 5000;
              const check = () => {
                const state = document.querySelector('[data-historical-route]')?.dataset.routeState;
                if (state === 'found' || state === 'not-found' || state === 'error' || Date.now() >= deadline) {
                  resolve(state ?? null);
                } else setTimeout(check, 25);
              };
              check();
            })`,
            awaitPromise: true,
            returnByValue: true,
        });
      }
      const evaluated = await client.send('Runtime.evaluate', {
          expression: `(() => {
            const clean = (value) => value?.replace(/^['\"]|['\"]$/g, '') ?? null;
            const root = document.documentElement;
            const tables = [...document.querySelectorAll('[data-scoreboard-table]')];
            const firstBoxscore = document.querySelector('.boxscore');
            const firstRow = document.querySelector('.boxscore tbody tr');
            const surface = document.querySelector(
              '.match-detail-summary, ' + ${JSON.stringify(selectors.archive)} + ', .home-view',
            );
            const surfaceStyle = surface ? getComputedStyle(surface) : null;
            return {
              routeState: document.querySelector('[data-historical-route]')?.dataset.routeState ?? null,
              archiveSummaryCount: document.querySelectorAll(${JSON.stringify(selectors.archive)}).length,
              archiveMatchCardCount: document.querySelectorAll(
                '[data-historical-content] ' + ${JSON.stringify(selectors.homeCard)},
              ).length,
              clientWidth: root.clientWidth,
              scrollWidth: root.scrollWidth,
              horizontalOverflow: root.scrollWidth > root.clientWidth,
              surfaceBackground: surfaceStyle?.backgroundColor ?? null,
              surfaceBorder: surfaceStyle?.borderTopColor ?? null,
              rootFontPixels: Number.parseFloat(getComputedStyle(root).fontSize),
              boxscoreWidth: firstBoxscore?.getBoundingClientRect().width ?? null,
              rowDisplay: firstRow ? getComputedStyle(firstRow).display : null,
              hintDisplay: firstBoxscore
                ? getComputedStyle(firstBoxscore.querySelector('.boxscore-scroll-hint')).display
                : null,
              tableCount: tables.length,
              headers: tables[0]
                ? [...tables[0].querySelectorAll('thead th')].map((node) =>
                  node.querySelector('.column-abbreviation')?.textContent.trim()
                    ?? node.textContent.trim().replace(/\\s+/g, ' '))
                : [],
              headerCounts: tables.map((table) => table.querySelectorAll('thead th').length),
              rowCellCounts: tables.flatMap((table) =>
                [...table.querySelectorAll('tbody tr')].map((row) => row.children.length)),
              expansions: tables[0]
                ? [...tables[0].querySelectorAll('.column-expansion')].map((node) => ({
                  text: node.textContent.trim(),
                  display: getComputedStyle(node).display,
                  width: node.getBoundingClientRect().width,
                  height: node.getBoundingClientRect().height,
                }))
                : [],
              tableTitleCount: tables.reduce((count, table) => count + table.querySelectorAll('[title]').length, 0),
              mobileLabels: firstRow
                ? [...firstRow.querySelectorAll('td')].map((cell) => clean(getComputedStyle(cell, '::before').content))
                : [],
            };
          })()`,
          returnByValue: true,
      });
      results.push(Object.freeze({ ...request, ...evaluated.result.value }));
    }
    return results;
  } finally {
    if (client) {
      try {
        await client.send('Browser.close');
      } catch {
        // The browser may already have exited.
      }
      client.close();
    }
    if (browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function hexToRgb(hex) {
  const value = hex.slice(1);
  const parts = value.length === 3
    ? [...value].map((part) => Number.parseInt(`${part}${part}`, 16))
    : [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)]
      .map((part) => Number.parseInt(part, 16));
  return `rgb(${parts.join(', ')})`;
}

function outputPathFromHref(root, href) {
  return path.join(root, ...href.split('/').filter(Boolean));
}

async function findRecentDetail(root) {
  const matchesRoot = path.join(root, 'matches');
  const entries = (await readdir(matchesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const entry of entries) {
    const filename = path.join(matchesRoot, entry.name, 'index.html');
    const html = await readFile(filename, 'utf8');
    if (html.includes('data-scoreboard-table')) {
      return Object.freeze({ matchId: entry.name, filename, html });
    }
  }
  throw new Error('no emitted recent match detail with a scoreboard was found');
}

const distArgument = argument('--dist');
const only = argument('--only');
if (!distArgument || (only && !ASSERTION_NAMES.includes(only))) {
  console.error(`usage: npm run audit:detail -- --dist PATH [--only ${ASSERTION_NAMES.join('|')}]`);
  process.exit(2);
}

const outputRoot = path.resolve(distArgument);
const handoff = (await readFile(SPEC_PATH, 'utf8')).replace(/\s+/g, ' ');
const columnContract = /exactly seven columns, in this order: ([^.]+)\. `Lvl`/.exec(handoff)?.[1] ?? '';
const expectedHeaders = Object.freeze(columnContract
  .split(/,\s*(?:and\s+)?/)
  .map((label) => label.trim())
  .filter(Boolean));
const expansionContract = /have visible expansions[^—]*—([^,]+), ([^,]+), and ([^—]+)—in/.exec(handoff);
const expectedExpansions = Object.freeze(expansionContract?.slice(1).map((label) => label.trim()) ?? []);
const widthContract = /every required viewport: ([\d,\sand]+)px/.exec(handoff)?.[1] ?? '';
const widths = Object.freeze([...widthContract.matchAll(/\d+/g)].map((match) => Number(match[0])));
const archiveClass = /archive client instead emits `<section class="([^"]+)">`/.exec(handoff)?.[1] ?? '';
const homeCardClass = /Home `<li class="([^"]+)">`/.exec(handoff)?.[1] ?? '';
const defaultLabel = /default remains ([^(]+) \(`premium`/.exec(handoff)?.[1]?.trim() ?? '';
const viewCountWord = /all (six) pre-rendered(?: tier)? views/.exec(handoff)?.[1] ?? '';
const expectedViewCount = Object.freeze({ six: 6 })[viewCountWord] ?? Number.NaN;
const remainingLabelsText = /remaining fixed views are ([^.]+)\./.exec(handoff)?.[1] ?? '';
const remainingLabels = remainingLabelsText
  .split(/,?\s+and\s+|,\s*/)
  .map((label) => label.trim())
  .filter(Boolean);
const expectedHintLabels = Object.freeze([defaultLabel, ...remainingLabels.slice(1)]);
assert.equal(expectedHeaders.length, 7, 'HANDOFF seven-column contract could not be parsed');
assert.equal(expectedExpansions.length, 3, 'HANDOFF expansion contract could not be parsed');
assert.equal(widths.length, 11, 'HANDOFF viewport contract could not be parsed');
assert.match(archiveClass, /^[a-z][a-z0-9-]*$/, 'HANDOFF archive class contract is invalid');
assert.match(homeCardClass, /^[a-z][a-z0-9-]*$/, 'HANDOFF home card class contract is invalid');
assert.ok(defaultLabel, 'HANDOFF approved default label could not be parsed');
assert.ok(Number.isFinite(expectedViewCount), 'HANDOFF no-JavaScript view count could not be parsed');
assert.equal(expectedHintLabels.length, expectedViewCount - 1, 'HANDOFF visible hint labels could not be parsed');
const homeHtml = await readFile(path.join(outputRoot, 'index.html'), 'utf8');
const recent = await findRecentDetail(outputRoot);
const manifest = JSON.parse(await readFile(path.join(outputRoot, 'data', 'matches', 'manifest.json'), 'utf8'));
const archiveMonth = manifest.ranges[0]?.month ?? null;
assert.match(archiveMonth ?? '', /^\d{4}-\d{2}$/, 'historical manifest contains no month');
const archivePayload = JSON.parse(await readFile(
  path.join(outputRoot, 'data', 'matches', `${archiveMonth}.json`),
  'utf8',
));
const archiveMatchId = archivePayload.matches[0]?.match_id ?? null;
assert.ok(Number.isSafeInteger(archiveMatchId), 'historical payload contains no match ID');
const stylesheetHref = /<link rel="stylesheet" href="([^"]+\.css)"/.exec(recent.html)?.[1] ?? null;
assert.ok(stylesheetHref, 'recent detail does not link emitted CSS');
const css = await readFile(outputPathFromHref(outputRoot, stylesheetHref), 'utf8');
const rootTokens = /^:root\{([^}]*)\}/.exec(css)?.[1] ?? '';
const token = (name) => new RegExp(`${name}:(#[0-9a-f]{3,8})`, 'i').exec(rootTokens)?.[1] ?? null;
assert.ok(token('--surface'), 'emitted light --surface token is missing');
assert.ok(token('--line-strong'), 'emitted light --line-strong token is missing');
const surfaceRgb = hexToRgb(token('--surface'));
const lineStrongRgb = hexToRgb(token('--line-strong'));
const containerRem = Number.parseFloat(
  /@container scoreboard\s*\(width<=([\d.]+)rem\)/.exec(css)?.[1] ?? 'NaN',
);
assert.ok(Number.isFinite(containerRem), 'emitted scoreboard container threshold is missing');

const buttons = [...homeHtml.matchAll(/<button\b[^>]*\bdata-home-view-option="([^"]+)"[^>]*>/g)];
const views = [...homeHtml.matchAll(/<section\b[^>]*class="home-view"[^>]*\bdata-home-view="([^"]+)"[^>]*>/g)];
const noScriptTierLinks = [...homeHtml.matchAll(/<a\b[^>]*href="#home-filter-([^"]+)"[^>]*>/g)];
const defaultButton = buttons.find((match) => match[1] === 'default')?.[0] ?? '';
const hints = /<p id="tier-hints" class="tier-hints">([\s\S]*?)<\/p>/.exec(homeHtml)?.[1] ?? '';

const needs = (name) => !only || only === name;
const requests = [];
const addRequests = (route, pathname, widths) => {
  for (const width of widths) requests.push(Object.freeze({ route, pathname, width }));
};
if (needs('exactWidthSweepHasNoHorizontalOverflow')) {
  addRequests('home', '/', widths);
  addRequests('detail', `/matches/${recent.matchId}/`, widths);
  addRequests('archive', `/matches/${archiveMatchId}/`, widths);
} else {
  if (needs('emittedThemeTokensControlDetailAndArchive')) {
    addRequests('home', '/', [900]);
    addRequests('detail', `/matches/${recent.matchId}/`, [900]);
  }
  if (needs('containerQuerySwitchesAtItsEmittedThreshold')) {
    addRequests('detail', `/matches/${recent.matchId}/`, widths);
  }
  if (needs('scoreboardsHaveSevenColumnsAndAccessibleExpansions')) {
    addRequests('detail', `/matches/${recent.matchId}/`, [320, 900]);
  }
  if (
    needs('archiveRuntimeUsesDistinctSummaryClass')
    || needs('emittedThemeTokensControlDetailAndArchive')
  ) addRequests('archive', `/matches/${archiveMatchId}/`, [900]);
}

const uniqueRequests = [...new Map(requests.map((request) => [
  `${request.route}:${request.width}`,
  request,
])).values()];
let measurements = [];
let chrome = null;
let server = null;
let scratch = null;
if (uniqueRequests.length > 0) {
  for (const candidate of CHROME_PATHS) {
    if (await exists(candidate)) {
      chrome = candidate;
      break;
    }
  }
  assert.equal(typeof chrome, 'string', 'Chrome or Edge is required for the Step 23 gate');
  scratch = await mkdtemp(path.join(tmpdir(), 'dotainfo-step23-'));
  server = await staticServer(outputRoot);
  try {
    const { port } = server.address();
    measurements = await browserMeasurements(
      chrome,
      scratch,
      `http://127.0.0.1:${port}`,
      uniqueRequests,
      { archive: `.${archiveClass}`, homeCard: `.${homeCardClass}` },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const measurement = (route, width) => measurements.find(
  (entry) => entry.route === route && entry.width === width,
);
const archiveWide = measurement('archive', 900);
const detailWide = measurement('detail', 900);
const detailNarrow = measurement('detail', 320);
const themeSamples = ['home', 'detail', 'archive']
  .map((route) => measurement(route, 900))
  .filter(Boolean);
const overflowSamples = measurements.filter((entry) => widths.includes(entry.width));
const containerSamples = measurements.filter((entry) => entry.route === 'detail');

const computedAssertions = {
  archiveRuntimeUsesDistinctSummaryClass:
    archiveWide?.routeState === 'found'
    && archiveWide.archiveSummaryCount === 1
    && archiveWide.archiveMatchCardCount === 0,
  scoreboardsHaveSevenColumnsAndAccessibleExpansions:
    detailWide?.tableCount === 2
    && detailWide.headers.join('|') === expectedHeaders.join('|')
    && detailWide.headerCounts.every((count) => count === 7)
    && detailWide.rowCellCounts.length > 0
    && detailWide.rowCellCounts.every((count) => count === 7)
    && detailWide.expansions.map(({ text }) => text).join('|') === expectedExpansions.join('|')
    && detailWide.expansions.every(({ display, width, height }) =>
      display !== 'none' && width > 0 && height > 0)
    && detailWide.tableTitleCount === 0
    && expectedExpansions.every((label) => detailNarrow?.mobileLabels.includes(label)),
  emittedThemeTokensControlDetailAndArchive:
    themeSamples.length === 3
    && themeSamples.every((sample) =>
      sample.surfaceBackground === surfaceRgb && sample.surfaceBorder === lineStrongRgb),
  containerQuerySwitchesAtItsEmittedThreshold:
    containerSamples.length === widths.length
    && containerSamples.every((sample) => {
      const narrow = sample.boxscoreWidth <= containerRem * sample.rootFontPixels;
      return sample.rowDisplay === (narrow ? 'grid' : 'table-row')
        && sample.hintDisplay === (narrow ? 'block' : 'none');
    })
    && containerSamples.some((sample) => sample.rowDisplay === 'grid')
    && containerSamples.some((sample) => sample.rowDisplay === 'table-row'),
  exactWidthSweepHasNoHorizontalOverflow:
    overflowSamples.length === widths.length * 3
    && overflowSamples.every((sample) =>
      sample.clientWidth === sample.width
      && sample.scrollWidth === sample.clientWidth
      && sample.horizontalOverflow === false),
  homeHintsAvoidRedundantTitleAndPreserveNoJsViews:
    buttons.length === expectedViewCount
    && buttons.every((match) => !/\btitle=/.test(match[0]))
    && /aria-pressed="true"/.test(defaultButton)
    && defaultButton.includes(`data-view-label="${defaultLabel}"`)
    && views.length === 1
    && views[0][1] === 'default'
    && !/\shidden(?:\s|>)/.test(views[0][0])
    && noScriptTierLinks.length === expectedViewCount
    && new Set(noScriptTierLinks.map((match) => match[1])).size === expectedViewCount
    && expectedHintLabels
      .every((label) => hints.includes(`<strong>${label}</strong>`)),
};

const assertions = Object.freeze(Object.fromEntries(
  ASSERTION_NAMES
    .filter((name) => !only || name === only)
    .map((name) => [name, computedAssertions[name]]),
));
console.log(`STEP23_VISUAL=${JSON.stringify({
  recentMatchId: Number(recent.matchId),
  archiveMatchId,
  widths,
  emittedContainerRem: containerRem,
  emittedColors: { surface: surfaceRgb, lineStrong: lineStrongRgb },
  measurements: measurements.map((entry) => ({
    route: entry.route,
    width: entry.width,
    clientWidth: entry.clientWidth,
    scrollWidth: entry.scrollWidth,
    boxscoreWidth: entry.boxscoreWidth,
    rowDisplay: entry.rowDisplay,
  })),
})}`);
console.log(`STEP23_ASSERTIONS=${JSON.stringify(assertions)}`);
const failures = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
assert.deepEqual(failures, [], `Step 23 visual audit failed: ${failures.join(', ')}`);
console.log('STEP23_STATUS=PASS');
