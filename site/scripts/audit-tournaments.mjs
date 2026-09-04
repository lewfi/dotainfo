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

import { DuckDBInstance } from '@duckdb/node-api';

const DATA_ROOT = fileURLToPath(new URL('../../data/matches/', import.meta.url));
const VIEWPORT_WIDTHS = Object.freeze([
  320, 360, 380, 414, 480, 600, 672, 700, 760, 900, 1200, 1280, 1440,
]);
const PAGE_SIZE = 200;
const CHROME_PATHS = Object.freeze([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]);
const ASSERTION_NAMES = Object.freeze([
  'everyLeagueHasPage',
  'perLeagueCountsMatchIndependentScan',
  'paginationIsCompleteExactAndUnique',
  'emittedTitlesAreUnique',
  'tierGroupingDropsNoMatches',
  'exactWidthSweepHasNoHorizontalOverflow',
  'emittedTournamentColorsPassContrastAndControlSurfaces',
  'lineBordersAttachToStrongTournamentBoundaries',
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

function sqlString(value) {
  return `'${String(value).replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

async function independentMatchRows(matchRoot) {
  const entries = (await readdir(matchRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && (/^\d{4}-\d{2}\.(?:parquet|ndjson)$/.test(entry.name)
      || entry.name === 'late.ndjson'));
  const parquet = entries.filter((entry) => entry.name.endsWith('.parquet'))
    .map((entry) => path.join(matchRoot, entry.name));
  const ndjson = entries.filter((entry) => entry.name.endsWith('.ndjson'))
    .map((entry) => path.join(matchRoot, entry.name));
  const branches = [];
  if (parquet.length > 0) {
    branches.push(`SELECT match_id, start_time, leagueid FROM read_parquet([${parquet.map(sqlString).join(', ')}], union_by_name = true)`);
  }
  if (ndjson.length > 0) {
    branches.push(`SELECT match_id, start_time, leagueid FROM read_json([${ndjson.map(sqlString).join(', ')}], format = 'newline_delimited', columns = {match_id: 'UBIGINT', start_time: 'BIGINT', leagueid: 'INTEGER'}, union_by_name = true)`);
  }
  assert.ok(branches.length > 0, 'independent tournament scan found no match shards');
  const database = await DuckDBInstance.create(':memory:');
  const connection = await database.connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT match_id, start_time, leagueid FROM (${branches.join('\nUNION ALL\n')}) AS committed_matches ORDER BY leagueid, start_time DESC, match_id DESC`,
    );
    return reader.getRowObjects().map((row) => ({
      matchId: Number(row.match_id),
      startTime: Number(row.start_time),
      leagueId: Number(row.leagueid),
    }));
  } finally {
    connection.closeSync();
  }
}

function attributes(tag) {
  const parsed = new Map();
  const expression = /\s([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.matchAll(expression)) {
    parsed.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return parsed;
}

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

async function tournamentPages(outputRoot) {
  const root = path.join(outputRoot, 'tournaments');
  const pages = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.name === 'index.html' && entryPath !== path.join(root, 'index.html')) {
        const html = await readFile(entryPath, 'utf8');
        const marker = /<article\b[^>]*\bdata-tournament-page\b[^>]*>/i.exec(html)?.[0] ?? '';
        const parsed = attributes(marker);
        const title = decodeHtml(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
        const matchIds = [...html.matchAll(/<a\b[^>]*\bclass="[^"]*\btournament-match-row\b[^"]*"[^>]*>/gi)]
          .map((match) => Number(attributes(match[0]).get('data-match-id')));
        pages.push(Object.freeze({
          filename: entryPath,
          html,
          leagueId: Number(parsed.get('data-league-id')),
          pageNumber: Number(parsed.get('data-page-number')),
          pageCount: Number(parsed.get('data-page-count')),
          totalMatches: Number(parsed.get('data-total-matches')),
          title,
          matchIds,
        }));
      }
    }
  }
  await visit(root);
  return pages;
}

function indexEntries(html) {
  return [...html.matchAll(/<li\b[^>]*\bdata-index-league-id="[^"]+"[^>]*>/gi)].map((match) => {
    const parsed = attributes(match[0]);
    return Object.freeze({
      leagueId: Number(parsed.get('data-index-league-id')),
      matchCount: Number(parsed.get('data-match-count')),
    });
  });
}

function hexRgb(hex) {
  const value = hex.slice(1);
  const parts = value.length === 3
    ? [...value].map((part) => Number.parseInt(`${part}${part}`, 16))
    : [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)]
      .map((part) => Number.parseInt(part, 16));
  return Object.freeze({ parts, css: `rgb(${parts.join(', ')})` });
}

function luminance(parts) {
  const linear = parts.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
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
  return 'application/octet-stream';
}

async function staticServer(root) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const relative = decodeURIComponent(url.pathname.slice(1));
      const target = path.resolve(root, relative.endsWith('/') ? `${relative}index.html` : relative);
      assert.ok(target.startsWith(`${root}${path.sep}`));
      const details = await stat(target);
      if (!details.isFile()) throw new Error('not a file');
      response.writeHead(200, { 'content-type': contentType(target) });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
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
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  close() {
    this.socket.close();
  }
}

async function waitForChrome(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function browserSweep(chrome, outputRoot, pathnames) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'dotainfo-step25-'));
  const port = await freePort();
  const server = await staticServer(outputRoot);
  const browser = spawn(chrome, [
    '--headless=new', '--disable-background-networking', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-allow-origins=*', `--remote-debugging-port=${port}`,
    `--user-data-dir=${scratch}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let client;
  try {
    await waitForChrome(port);
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    client = new CdpClient((await target.json()).webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');
    await client.send('Network.setBlockedURLs', { urls: ['https://*'] });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const results = [];
    for (const pathname of pathnames) {
      for (const width of VIEWPORT_WIDTHS) {
        await client.send('Emulation.setDeviceMetricsOverride', {
          width, height: 1_000, deviceScaleFactor: 1, mobile: true,
        });
        await client.send('Page.navigate', { url: `${origin}${pathname}` });
        let ready = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            const state = await client.send('Runtime.evaluate', {
              expression: 'document.readyState', returnByValue: true,
            });
            ready = ['interactive', 'complete'].includes(state.result.value);
          } catch {
            // Navigation replaced the execution context.
          }
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(ready, `${pathname} was not ready at ${width}px`);
        const evaluated = await client.send('Runtime.evaluate', {
          expression: `(() => {
            const root = document.documentElement;
            const surface = document.querySelector('.tournament-panel, .tournament-index-group');
            const style = surface ? getComputedStyle(surface) : null;
            return {
              clientWidth: root.clientWidth,
              scrollWidth: root.scrollWidth,
              background: style?.backgroundColor ?? null,
              border: style?.borderTopColor ?? null,
              color: style?.color ?? null,
            };
          })()`,
          returnByValue: true,
        });
        results.push(Object.freeze({ pathname, width, ...evaluated.result.value }));
      }
    }
    return results;
  } finally {
    if (client) client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const outputRoot = path.resolve(argument('--dist') ?? 'dist');
const only = argument('--only');
if (only && !ASSERTION_NAMES.includes(only)) {
  console.error(`unknown --only assertion: ${only}`);
  process.exit(2);
}
const needs = (name) => !only || only === name;
const [sourceRows, pages, indexHtml] = await Promise.all([
  independentMatchRows(DATA_ROOT),
  tournamentPages(outputRoot),
  readFile(path.join(outputRoot, 'tournaments', 'index.html'), 'utf8'),
]);
const sourceByLeague = new Map();
for (const row of sourceRows) {
  const group = sourceByLeague.get(row.leagueId) ?? [];
  group.push(row);
  sourceByLeague.set(row.leagueId, group);
}
const pagesByLeague = new Map();
for (const page of pages) {
  const group = pagesByLeague.get(page.leagueId) ?? [];
  group.push(page);
  pagesByLeague.set(page.leagueId, group);
}
for (const group of pagesByLeague.values()) group.sort((left, right) => left.pageNumber - right.pageNumber);
const index = indexEntries(indexHtml);
const indexTitle = decodeHtml(/<title>([\s\S]*?)<\/title>/i.exec(indexHtml)?.[1] ?? '');

const stylesheetHref = /<link rel="stylesheet" href="([^"]+\.css)"/i.exec(indexHtml)?.[1] ?? '';
const css = await readFile(path.join(outputRoot, ...stylesheetHref.split('/').filter(Boolean)), 'utf8');
const rootTokens = /^:root\{([^}]*)\}/.exec(css)?.[1] ?? '';
const token = (name) => new RegExp(`${name}:(#[0-9a-f]{3,8})`, 'i').exec(rootTokens)?.[1] ?? null;
const colors = Object.freeze({
  surface: hexRgb(token('--surface')),
  foreground: hexRgb(token('--fg')),
  lineStrong: hexRgb(token('--line-strong')),
});
const colorContrast = contrast(colors.surface.parts, colors.foreground.parts);

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
const strongSelectors = rules
  .filter((rule) => rule.selector.includes('tournament') && /border[^:]*:[^;]*var\(--line-strong\)/.test(rule.body))
  .map((rule) => rule.selector);
const lineRules = rules.filter((rule) => rule.selector.includes('tournament')
  && /border[^:]*:[^;]*var\(--line\)(?:;|$)/.test(rule.body));

let measurements = [];
if (needs('exactWidthSweepHasNoHorizontalOverflow')
  || needs('emittedTournamentColorsPassContrastAndControlSurfaces')) {
  const chrome = CHROME_PATHS.find((candidate) => requireExists(candidate));
  assert.ok(chrome, 'Chrome or Edge is required for the Step 25 tournament gate');
  const largest = [...pages].sort((left, right) => right.totalMatches - left.totalMatches)[0];
  measurements = await browserSweep(chrome, outputRoot, ['/tournaments/', `/tournaments/${largest.leagueId}/`]);
}

function requireExists(filename) {
  try {
    return process.getBuiltinModule('fs').statSync(filename).isFile();
  } catch {
    return false;
  }
}

const exactPagination = [...sourceByLeague].every(([leagueId, expected]) => {
  const emitted = pagesByLeague.get(leagueId) ?? [];
  const expectedIds = expected.map((row) => row.matchId);
  const emittedIds = emitted.flatMap((page) => page.matchIds);
  return emitted.length === Math.ceil(expectedIds.length / PAGE_SIZE)
    && emitted.every((page, index) => page.pageNumber === index + 1
      && page.pageCount === emitted.length
      && page.matchIds.length === Math.min(PAGE_SIZE, expectedIds.length - index * PAGE_SIZE))
    && emittedIds.join('|') === expectedIds.join('|')
    && new Set(emittedIds).size === emittedIds.length;
});
const paginationFailures = [...sourceByLeague].flatMap(([leagueId, expected]) => {
  const emitted = pagesByLeague.get(leagueId) ?? [];
  const expectedIds = expected.map((row) => row.matchId);
  const emittedIds = emitted.flatMap((page) => page.matchIds);
  const mismatch = Math.max(expectedIds.length, emittedIds.length) === 0
    ? -1
    : Array.from({ length: Math.max(expectedIds.length, emittedIds.length) })
      .findIndex((_, index) => expectedIds[index] !== emittedIds[index]);
  const structural = emitted.length !== Math.ceil(expectedIds.length / PAGE_SIZE)
    || emitted.some((page, index) => page.pageNumber !== index + 1
      || page.pageCount !== emitted.length
      || page.matchIds.length !== Math.min(PAGE_SIZE, expectedIds.length - index * PAGE_SIZE));
  return mismatch === -1 && !structural ? [] : [{
    leagueId,
    mismatch,
    expected: expectedIds[mismatch] ?? null,
    emitted: emittedIds[mismatch] ?? null,
    expectedPages: Math.ceil(expectedIds.length / PAGE_SIZE),
    emittedPages: emitted.length,
    expectedSlice: expectedIds.slice(Math.max(0, mismatch - 2), mismatch + 3),
    emittedSlice: emittedIds.slice(Math.max(0, mismatch - 2), mismatch + 3),
  }];
}).slice(0, 3);
const indexLeagueIds = index.map((entry) => entry.leagueId);
const assertions = Object.freeze({
  everyLeagueHasPage: [...sourceByLeague.keys()].every((leagueId) => pagesByLeague.has(leagueId))
    && pagesByLeague.size === sourceByLeague.size,
  perLeagueCountsMatchIndependentScan: [...sourceByLeague].every(([leagueId, rows]) => {
    const emitted = pagesByLeague.get(leagueId) ?? [];
    return emitted.length > 0
      && emitted.every((page) => page.totalMatches === rows.length)
      && emitted.reduce((sum, page) => sum + page.matchIds.length, 0) === rows.length;
  }),
  paginationIsCompleteExactAndUnique: exactPagination,
  emittedTitlesAreUnique: pages.every((page) => page.title.endsWith(' — DotaInfo'))
    && indexTitle.endsWith(' — DotaInfo')
    && new Set([indexTitle, ...pages.map((page) => page.title)]).size === pages.length + 1,
  tierGroupingDropsNoMatches: index.length === sourceByLeague.size
    && new Set(indexLeagueIds).size === indexLeagueIds.length
    && indexLeagueIds.every((leagueId) => sourceByLeague.has(leagueId))
    && index.reduce((sum, entry) => sum + entry.matchCount, 0) === sourceRows.length,
  exactWidthSweepHasNoHorizontalOverflow: measurements.length === VIEWPORT_WIDTHS.length * 2
    && measurements.every((sample) => sample.clientWidth === sample.width
      && sample.scrollWidth === sample.clientWidth),
  emittedTournamentColorsPassContrastAndControlSurfaces: colorContrast >= 4.5
    && measurements.length === VIEWPORT_WIDTHS.length * 2
    && measurements.every((sample) => sample.background === colors.surface.css
      && sample.border === colors.lineStrong.css
      && sample.color === colors.foreground.css),
  lineBordersAttachToStrongTournamentBoundaries: lineRules.length > 0
    && strongSelectors.length > 0
    && lineRules.every((rule) => strongSelectors.some((strong) => rule.selector.startsWith(`${strong} `))),
});
const selected = Object.freeze(Object.fromEntries(Object.entries(assertions)
  .filter(([name]) => !only || name === only)));
console.log(`STEP25_TOURNAMENT_AUDIT=${JSON.stringify({
  sourceMatches: sourceRows.length,
  leagues: sourceByLeague.size,
  emittedPages: pages.length,
  indexEntries: index.length,
  pageSize: PAGE_SIZE,
  widths: VIEWPORT_WIDTHS,
  colorContrast: Number(colorContrast.toFixed(3)),
  lineRules: lineRules.map((rule) => rule.selector),
  overflowSamples: measurements
    .filter((sample) => sample.clientWidth !== sample.width || sample.scrollWidth !== sample.clientWidth)
    .map(({ pathname, width, clientWidth, scrollWidth }) => ({ pathname, width, clientWidth, scrollWidth })),
  paginationFailures,
})}`);
console.log(`STEP25_TOURNAMENT_ASSERTIONS=${JSON.stringify(selected)}`);
const failures = Object.entries(selected).filter(([, passed]) => !passed).map(([name]) => name);
assert.deepEqual(failures, [], `Step 25 tournament audit failed: ${failures.join(', ')}`);
console.log('STEP25_TOURNAMENT_STATUS=PASS');
