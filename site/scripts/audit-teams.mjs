import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

const DATA_ROOT = fileURLToPath(new URL('../../data/', import.meta.url));
const TEAM_REFERENCE = path.join(DATA_ROOT, 'reference', 'teams.parquet');
const VIEWPORT_WIDTHS = Object.freeze([
  320, 360, 380, 414, 480, 600, 672, 700, 760, 900, 1200, 1280, 1440,
]);
const PAGE_SIZE = 200;
const TOP_HERO_LIMIT = 5;
const CHROME_PATHS = Object.freeze([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]);
const ASSERTION_NAMES = Object.freeze([
  'everyTeamIdHasPage',
  'indexIsGroupedAndComplete',
  'perTeamMatchCountsMatchIndependentUnprunedScan',
  'paginationIsCompleteExactAndDuplicateFree',
  'winLossCountsUseOnlyRecordedResults',
  'everyMatchAppearsOnItsNonNullTeamPages',
  'currentEraNamesAndLogoStatesFollowContract',
  'mostPlayedHeroesMatchIndependentScan',
  'emittedTeamTitlesAreUnique',
  'exactWidthSweepHasNoHorizontalOverflow',
  'emittedTeamColorsPassContrastAndControlSurfaces',
  'lineBordersAttachToStrongTeamBoundaries',
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function sqlString(value) {
  return `'${String(value).replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

async function factFiles(table) {
  const root = path.join(DATA_ROOT, table);
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !(/^\d{4}-\d{2}\.(?:parquet|ndjson)$/.test(entry.name) || entry.name === 'late.ndjson')) continue;
    const filename = path.join(root, entry.name);
    if ((await stat(filename)).size > 0) files.push(filename);
  }
  return files.sort();
}

function directSource(files, table) {
  const parquet = files.filter((filename) => filename.endsWith('.parquet'));
  const ndjson = files.filter((filename) => filename.endsWith('.ndjson'));
  const projections = Object.freeze({
    matches: 'match_id, start_time, leagueid, league_name, radiant_team_id, dire_team_id, radiant_team_name, dire_team_name, radiant_win, radiant_score, dire_score',
    players: 'match_id, is_radiant, hero_id',
  });
  const definitions = Object.freeze({
    matches: "{match_id: 'UBIGINT', start_time: 'BIGINT', leagueid: 'INTEGER', league_name: 'VARCHAR', radiant_team_id: 'INTEGER', dire_team_id: 'INTEGER', radiant_team_name: 'VARCHAR', dire_team_name: 'VARCHAR', radiant_win: 'BOOLEAN', radiant_score: 'INTEGER', dire_score: 'INTEGER'}",
    players: "{match_id: 'UBIGINT', is_radiant: 'BOOLEAN', hero_id: 'INTEGER'}",
  });
  const branches = [];
  if (parquet.length > 0) {
    branches.push(`SELECT ${projections[table]} FROM read_parquet([${parquet.map(sqlString).join(', ')}], union_by_name = true)`);
  }
  if (ndjson.length > 0) {
    branches.push(`SELECT ${projections[table]} FROM read_json([${ndjson.map(sqlString).join(', ')}], format = 'newline_delimited', columns = ${definitions[table]}, union_by_name = true)`);
  }
  assert.ok(branches.length > 0, `independent team scan found no ${table} shards`);
  return branches.join('\nUNION ALL\n');
}

function plain(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'bigint' ? Number(value) : value,
  ]));
}

async function rows(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjects().map(plain);
}

async function independentSource() {
  const [matchFiles, playerFiles] = await Promise.all([factFiles('matches'), factFiles('players')]);
  const matches = directSource(matchFiles, 'matches');
  const players = directSource(playerFiles, 'players');
  const database = await DuckDBInstance.create(':memory:');
  const connection = await database.connect();
  try {
    const matchRows = await rows(connection, `
      SELECT * FROM (${matches}) AS committed_matches
      ORDER BY start_time DESC, match_id DESC
    `);
    const references = await rows(connection, `
      SELECT team_id, name, tag, logo_url FROM read_parquet(${sqlString(TEAM_REFERENCE)})
    `);
    const heroAppearances = await rows(connection, `
      WITH committed_matches AS (${matches}), committed_players AS (${players})
      SELECT
        CASE
          WHEN p.is_radiant = true THEN m.radiant_team_id
          WHEN p.is_radiant = false THEN m.dire_team_id
          ELSE NULL
        END AS team_id,
        p.hero_id,
        count(*) AS appearances
      FROM committed_players AS p
      INNER JOIN committed_matches AS m USING (match_id)
      WHERE CASE
        WHEN p.is_radiant = true THEN m.radiant_team_id
        WHEN p.is_radiant = false THEN m.dire_team_id
        ELSE NULL
      END IS NOT NULL
      GROUP BY team_id, p.hero_id
    `);
    return Object.freeze({ matchRows, references, heroAppearances });
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

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi'))]
    .map((match) => match[0]);
}

function decodeHtml(value) {
  return (value ?? '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
}

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function id(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

async function emittedTeamPages(outputRoot) {
  const root = path.join(outputRoot, 'teams');
  const pages = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.name === 'index.html' && filename !== path.join(root, 'index.html')) {
        const html = await readFile(filename, 'utf8');
        const marker = attributes(tags(html, 'article').find((tag) => attributes(tag).has('data-team-page')) ?? '');
        const matches = tags(html, 'a').filter((tag) => (
          attributes(tag).get('class')?.split(/\s+/).includes('team-match-row')
        )).map((tag) => {
          const parsed = attributes(tag);
          return Object.freeze({
            matchId: Number(parsed.get('data-match-id')),
            opponentTeamId: parsed.get('data-opponent-team-id') === 'unavailable'
              ? null : Number(parsed.get('data-opponent-team-id')),
            opponentName: decodeHtml(parsed.get('data-opponent-name')),
            scoreState: parsed.get('data-score-state'),
            resultState: parsed.get('data-result-state'),
          });
        });
        const heroes = tags(html, 'li').filter((tag) => (
          attributes(tag).get('class')?.split(/\s+/).includes('team-hero-row')
        )).map((tag) => {
          const parsed = attributes(tag);
          return Object.freeze({
            heroId: parsed.get('data-hero-id') === 'unavailable' ? null : Number(parsed.get('data-hero-id')),
            appearances: Number(parsed.get('data-appearances')),
          });
        });
        pages.push(Object.freeze({
          filename,
          html,
          teamId: Number(marker.get('data-team-id')),
          pageNumber: Number(marker.get('data-page-number')),
          pageCount: Number(marker.get('data-page-count')),
          totalMatches: Number(marker.get('data-total-matches')),
          wins: Number(marker.get('data-wins')),
          losses: Number(marker.get('data-losses')),
          decidedMatches: Number(marker.get('data-decided-matches')),
          nullResultMatches: Number(marker.get('data-null-result-matches')),
          teamName: decodeHtml(marker.get('data-team-name')),
          teamNameSource: marker.get('data-team-name-source'),
          logoState: marker.get('data-logo-state'),
          title: decodeHtml(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''),
          heading: decodeHtml((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, '')),
          matches,
          heroes,
        }));
      }
    }
  }
  await visit(root);
  return pages.sort((left, right) => left.teamId - right.teamId || left.pageNumber - right.pageNumber);
}

function emittedIndex(html) {
  const entries = tags(html, 'a').filter((tag) => attributes(tag).has('data-index-team-id')).map((tag) => {
    const parsed = attributes(tag);
    return Object.freeze({
      teamId: Number(parsed.get('data-index-team-id')),
      teamName: decodeHtml(parsed.get('data-team-name')),
      teamNameSource: parsed.get('data-team-name-source'),
      logoState: parsed.get('data-logo-state'),
      matchCount: Number(parsed.get('data-match-count')),
      firstStart: Number(parsed.get('data-first-start')),
      lastStart: Number(parsed.get('data-last-start')),
    });
  });
  const groups = tags(html, 'section').filter((tag) => attributes(tag).has('data-team-index-group'));
  return Object.freeze({ entries, groups: groups.length });
}

function groupSource(matchRows) {
  const byTeam = new Map();
  const appearancesByMatch = new Map();
  for (const row of matchRows) {
    const teamIds = new Set([id(row.radiant_team_id), id(row.dire_team_id)].filter((teamId) => teamId !== null));
    appearancesByMatch.set(Number(row.match_id), teamIds.size);
    for (const teamId of teamIds) {
      const side = id(row.radiant_team_id) === teamId ? 'radiant' : 'dire';
      const group = byTeam.get(teamId) ?? [];
      group.push(Object.freeze({ row, side, matchId: Number(row.match_id), startTime: Number(row.start_time) }));
      byTeam.set(teamId, group);
    }
  }
  for (const group of byTeam.values()) {
    group.sort((left, right) => right.startTime - left.startTime || right.matchId - left.matchId);
  }
  return Object.freeze({ byTeam, appearancesByMatch });
}

function expectedTeamName(teamId, matches, reference) {
  const current = cleanText(reference?.name);
  if (current) return Object.freeze({ display: current, source: 'reference-current' });
  for (const match of matches) {
    const value = cleanText(match.row[`${match.side}_team_name`]);
    if (value) return Object.freeze({ display: value, source: 'most-recent-match' });
  }
  return Object.freeze({ display: `Team ${teamId}`, source: 'team-id-fallback' });
}

function expectedOpponent(match, references) {
  const side = match.side === 'radiant' ? 'dire' : 'radiant';
  const teamId = id(match.row[`${side}_team_id`]);
  const reference = teamId === null ? null : references.get(teamId);
  return Object.freeze({
    teamId,
    name: cleanText(match.row[`${side}_team_name`])
      ?? cleanText(reference?.name)
      ?? cleanText(reference?.tag)
      ?? 'Team name unavailable',
  });
}

function heroKey(value) {
  return value === null ? 'unavailable' : String(value);
}

function hexRgb(hex) {
  assert.match(hex ?? '', /^#[0-9a-f]{3,8}$/i, 'missing emitted color token');
  const value = hex.slice(1);
  const parts = value.length === 3
    ? [...value].map((part) => Number.parseInt(`${part}${part}`, 16))
    : [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)].map((part) => Number.parseInt(part, 16));
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
        ? event.data : event.data instanceof Blob ? await event.data.text() : new TextDecoder().decode(event.data);
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
    const idValue = this.nextId;
    this.nextId += 1;
    const response = new Promise((resolve, reject) => this.pending.set(idValue, { resolve, reject }));
    this.socket.send(JSON.stringify({ id: idValue, method, params }));
    return response;
  }

  close() { this.socket.close(); }
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
  const scratch = await mkdtemp(path.join(tmpdir(), 'dotainfo-step27-team-browser-'));
  const port = await freePort();
  const server = await staticServer(outputRoot);
  const browser = spawn(chrome, [
    '--headless=new', '--disable-background-networking', '--disable-breakpad',
    '--disable-crash-reporter', '--disable-gpu', '--disable-extensions', '--no-proxy-server',
    '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`, `--user-data-dir=${scratch}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let client;
  try {
    await waitForChrome(port);
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT', signal: AbortSignal.timeout(5_000),
    });
    client = new CdpClient((await target.json()).webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');
    await client.send('Network.setBlockedURLs', { urls: ['https://*'] });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const measurements = [];
    for (const pathname of pathnames) {
      for (const width of VIEWPORT_WIDTHS) {
        await client.send('Emulation.setDeviceMetricsOverride', { width, height: 1_000, deviceScaleFactor: 1, mobile: true });
        await client.send('Page.navigate', { url: `${origin}${pathname}` });
        let ready = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            const state = await client.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
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
            const surface = document.querySelector('.team-index-group, .team-page-panel');
            const style = surface ? getComputedStyle(surface) : null;
            return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
              background: style?.backgroundColor ?? null, border: style?.borderTopColor ?? null,
              color: style?.color ?? null };
          })()`,
          returnByValue: true,
        });
        measurements.push(Object.freeze({ pathname, width, ...evaluated.result.value }));
      }
    }
    return measurements;
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
const [source, pages, indexHtml] = await Promise.all([
  independentSource(), emittedTeamPages(outputRoot), readFile(path.join(outputRoot, 'teams', 'index.html'), 'utf8'),
]);
const grouped = groupSource(source.matchRows);
const sourceByTeam = grouped.byTeam;
const pagesByTeam = new Map();
for (const page of pages) {
  const group = pagesByTeam.get(page.teamId) ?? [];
  group.push(page);
  pagesByTeam.set(page.teamId, group);
}
for (const group of pagesByTeam.values()) group.sort((left, right) => left.pageNumber - right.pageNumber);
const references = new Map(source.references.map((row) => [Number(row.team_id), row]));
const index = emittedIndex(indexHtml);
const indexByTeam = new Map(index.entries.map((entry) => [entry.teamId, entry]));
const indexTitle = decodeHtml(/<title>([\s\S]*?)<\/title>/i.exec(indexHtml)?.[1] ?? '');

const heroesByTeam = new Map();
for (const row of source.heroAppearances) {
  const teamId = Number(row.team_id);
  const group = heroesByTeam.get(teamId) ?? [];
  group.push(Object.freeze({ heroId: id(row.hero_id), appearances: Number(row.appearances) }));
  heroesByTeam.set(teamId, group);
}

const stylesheetHref = /<link rel="stylesheet" href="([^"]+\.css)"/i.exec(indexHtml)?.[1] ?? '';
const stylesheet = path.join(outputRoot, ...stylesheetHref.split('/').filter(Boolean));
const css = await readFile(stylesheet, 'utf8');
const rootTokens = /^:root\{([^}]*)\}/.exec(css)?.[1] ?? '';
const token = (name) => new RegExp(`${name}:(#[0-9a-f]{3,8})`, 'i').exec(rootTokens)?.[1] ?? null;
const colors = Object.freeze({
  surface: hexRgb(token('--surface')),
  foreground: hexRgb(token('--fg')),
  lineStrong: hexRgb(token('--line-strong')),
});
const colorContrast = contrast(colors.surface.parts, colors.foreground.parts);
const cssRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1].split(',').map((selector) => selector.trim()), body: match[2],
}));
const strongSelectors = cssRules.flatMap((rule) => /border[^:]*:[^;]*var\(--line-strong\)/.test(rule.body)
  ? rule.selectors.filter((selector) => selector.includes('team-index') || selector.includes('team-page')) : []);
const lineRules = cssRules.flatMap((rule) => /border[^:]*:[^;]*var\(--line\)(?:;|$)/.test(rule.body)
  ? rule.selectors.filter((selector) => selector.includes('team-index') || selector.includes('team-page')) : []);

let measurements = [];
if (needs('exactWidthSweepHasNoHorizontalOverflow') || needs('emittedTeamColorsPassContrastAndControlSurfaces')) {
  const chrome = CHROME_PATHS.find((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
  assert.ok(chrome, 'Chrome or Edge is required for the Step 27 team gate');
  const largest = [...sourceByTeam].sort((left, right) => right[1].length - left[1].length)[0][0];
  measurements = await browserSweep(chrome, outputRoot, ['/teams/', `/teams/${largest}/`]);
}

const exactPagination = [...sourceByTeam].every(([teamId, expected]) => {
  const emitted = pagesByTeam.get(teamId) ?? [];
  const expectedIds = expected.map((entry) => entry.matchId);
  const emittedIds = emitted.flatMap((page) => page.matches.map((entry) => entry.matchId));
  return emitted.length === Math.ceil(expectedIds.length / PAGE_SIZE)
    && emitted.every((page, pageIndex) => page.pageNumber === pageIndex + 1
      && page.pageCount === emitted.length
      && page.matches.length === Math.min(PAGE_SIZE, expectedIds.length - pageIndex * PAGE_SIZE))
    && emittedIds.join('|') === expectedIds.join('|')
    && new Set(emittedIds).size === emittedIds.length;
});

const recordsMatch = [...sourceByTeam].every(([teamId, expected]) => {
  const emitted = pagesByTeam.get(teamId) ?? [];
  const decided = expected.filter((entry) => typeof entry.row.radiant_win === 'boolean');
  const wins = decided.filter((entry) => entry.row.radiant_win === (entry.side === 'radiant')).length;
  const losses = decided.length - wins;
  return emitted.length > 0 && emitted.every((page) => page.wins === wins
    && page.losses === losses
    && page.decidedMatches === decided.length
    && page.nullResultMatches === expected.length - decided.length)
    && decided.length + (expected.length - decided.length) === expected.length
    && emitted.every((page) => /without a result remain in/i.test(page.html));
});

const emittedAppearances = new Map();
for (const page of pages) {
  for (const match of page.matches) {
    emittedAppearances.set(match.matchId, (emittedAppearances.get(match.matchId) ?? 0) + 1);
  }
}
const expectedRoutableAppearances = [...grouped.appearancesByMatch]
  .filter(([, appearances]) => appearances > 0);

const namesAndLogosMatch = [...sourceByTeam].every(([teamId, expected]) => {
  const reference = references.get(teamId);
  const name = expectedTeamName(teamId, expected, reference);
  const logoState = cleanText(reference?.logo_url) ? 'available' : 'missing';
  const emittedPages = pagesByTeam.get(teamId) ?? [];
  const indexed = indexByTeam.get(teamId);
  if (!indexed || emittedPages.length === 0) return false;
  if (indexed.teamName !== name.display || indexed.teamNameSource !== name.source || indexed.logoState !== logoState) return false;
  return emittedPages.every((page) => page.teamName === name.display
    && page.heading === name.display && page.teamNameSource === name.source && page.logoState === logoState)
    && emittedPages.flatMap((page) => page.matches).every((actual) => {
      const sourceMatch = expected.find((entry) => entry.matchId === actual.matchId);
      if (!sourceMatch) return false;
      const opponent = expectedOpponent(sourceMatch, references);
      return actual.opponentTeamId === opponent.teamId && actual.opponentName === opponent.name
        && actual.resultState === (typeof sourceMatch.row.radiant_win === 'boolean' ? 'available' : 'missing')
        && actual.scoreState === (Number.isInteger(sourceMatch.row.radiant_score)
          && Number.isInteger(sourceMatch.row.dire_score) ? 'available' : 'missing');
    });
});

const heroesMatch = [...sourceByTeam].every(([teamId]) => {
  const actual = pagesByTeam.get(teamId)?.[0]?.heroes ?? [];
  const expected = heroesByTeam.get(teamId) ?? [];
  const expectedMap = new Map(expected.map((row) => [heroKey(row.heroId), row.appearances]));
  if (actual.length !== Math.min(TOP_HERO_LIMIT, expected.length)) return false;
  if (new Set(actual.map((row) => heroKey(row.heroId))).size !== actual.length) return false;
  if (!actual.every((row) => expectedMap.get(heroKey(row.heroId)) === row.appearances)) return false;
  if (!actual.every((row, index) => index === 0 || actual[index - 1].appearances >= row.appearances)) return false;
  const threshold = actual.at(-1)?.appearances ?? Infinity;
  return expected.every((row) => actual.some((candidate) => heroKey(candidate.heroId) === heroKey(row.heroId))
    || row.appearances <= threshold);
});

const indexCountMismatches = [...sourceByTeam]
  .filter(([teamId, matches]) => indexByTeam.get(teamId)?.matchCount !== matches.length)
  .slice(0, 10)
  .map(([teamId, matches]) => Object.freeze({
    teamId, expected: matches.length, actual: indexByTeam.get(teamId)?.matchCount ?? null,
  }));
const nameStateMismatches = [...sourceByTeam]
  .filter(([teamId, expected]) => {
    const reference = references.get(teamId);
    const name = expectedTeamName(teamId, expected, reference);
    const logoState = cleanText(reference?.logo_url) ? 'available' : 'missing';
    const emitted = pagesByTeam.get(teamId) ?? [];
    const indexed = indexByTeam.get(teamId);
    return !indexed || indexed.teamName !== name.display || indexed.teamNameSource !== name.source
      || indexed.logoState !== logoState || emitted.some((page) => page.teamName !== name.display
        || page.heading !== name.display || page.teamNameSource !== name.source || page.logoState !== logoState)
      || emitted.flatMap((page) => page.matches).some((actual) => {
        const sourceMatch = expected.find((entry) => entry.matchId === actual.matchId);
        if (!sourceMatch) return true;
        const opponent = expectedOpponent(sourceMatch, references);
        return actual.opponentTeamId !== opponent.teamId || actual.opponentName !== opponent.name
          || actual.resultState !== (typeof sourceMatch.row.radiant_win === 'boolean' ? 'available' : 'missing')
          || actual.scoreState !== (Number.isInteger(sourceMatch.row.radiant_score)
            && Number.isInteger(sourceMatch.row.dire_score) ? 'available' : 'missing');
      });
  })
  .slice(0, 10)
  .map(([teamId]) => teamId);

const assertions = Object.freeze({
  everyTeamIdHasPage: pagesByTeam.size === sourceByTeam.size
    && [...sourceByTeam.keys()].every((teamId) => pagesByTeam.has(teamId)),
  indexIsGroupedAndComplete: index.groups > 1 && index.entries.length === sourceByTeam.size
    && indexByTeam.size === sourceByTeam.size
    && [...sourceByTeam].every(([teamId, matches]) => indexByTeam.get(teamId)?.matchCount === matches.length),
  perTeamMatchCountsMatchIndependentUnprunedScan: [...sourceByTeam].every(([teamId, matches]) => {
    const emitted = pagesByTeam.get(teamId) ?? [];
    return emitted.length > 0 && emitted.every((page) => page.totalMatches === matches.length)
      && emitted.reduce((sum, page) => sum + page.matches.length, 0) === matches.length;
  }),
  paginationIsCompleteExactAndDuplicateFree: exactPagination,
  winLossCountsUseOnlyRecordedResults: recordsMatch,
  everyMatchAppearsOnItsNonNullTeamPages: emittedAppearances.size === expectedRoutableAppearances.length
    && expectedRoutableAppearances.every(([matchId, expected]) => emittedAppearances.get(matchId) === expected),
  currentEraNamesAndLogoStatesFollowContract: namesAndLogosMatch,
  mostPlayedHeroesMatchIndependentScan: heroesMatch,
  emittedTeamTitlesAreUnique: pages.every((page) => page.title.endsWith(' — DotaInfo'))
    && indexTitle.endsWith(' — DotaInfo')
    && new Set([indexTitle, ...pages.map((page) => page.title)]).size === pages.length + 1,
  exactWidthSweepHasNoHorizontalOverflow: measurements.length === VIEWPORT_WIDTHS.length * 2
    && measurements.every((sample) => sample.clientWidth === sample.width && sample.scrollWidth === sample.clientWidth),
  emittedTeamColorsPassContrastAndControlSurfaces: colorContrast >= 4.5
    && measurements.length === VIEWPORT_WIDTHS.length * 2
    && measurements.every((sample) => sample.background === colors.surface.css
      && sample.border === colors.lineStrong.css && sample.color === colors.foreground.css),
  lineBordersAttachToStrongTeamBoundaries: lineRules.length > 0 && strongSelectors.length > 0
    && lineRules.every((selector) => strongSelectors.some((strong) => selector.startsWith(`${strong} `))),
});
const selected = Object.freeze(Object.fromEntries(Object.entries(assertions)
  .filter(([name]) => !only || name === only)));
const nullResultMatches = source.matchRows.filter((row) => row.radiant_win === null).length;
const nullOrEmptyNameTeams = [...sourceByTeam]
  .filter(([teamId]) => references.get(teamId)?.name == null || references.get(teamId).name === '').length;
const unusableNameTeams = [...sourceByTeam].filter(([teamId]) => !cleanText(references.get(teamId)?.name)).length;
const missingLogoTeams = [...sourceByTeam].filter(([teamId]) => !cleanText(references.get(teamId)?.logo_url)).length;
console.log(`STEP27_TEAM_AUDIT=${JSON.stringify({
  sourceMatches: source.matchRows.length,
  teams: sourceByTeam.size,
  emittedPages: pages.length,
  indexEntries: index.entries.length,
  pageSize: PAGE_SIZE,
  largestTeamMatches: Math.max(...[...sourceByTeam.values()].map((matches) => matches.length)),
  multiPageTeams: [...sourceByTeam.values()].filter((matches) => matches.length > PAGE_SIZE).length,
  nullResultMatches,
  nullOrEmptyNameTeams,
  unusableNameTeams,
  missingLogoTeams,
  emittedMatchPlacements: [...emittedAppearances.values()].reduce((sum, value) => sum + value, 0),
  widths: VIEWPORT_WIDTHS,
  colorContrast: Number(colorContrast.toFixed(3)),
  lineRules,
  overflowSamples: measurements.filter((sample) => sample.scrollWidth !== sample.clientWidth),
  indexCountMismatches,
  nameStateMismatches,
})}`);
console.log(`STEP27_TEAM_ASSERTIONS=${JSON.stringify(selected)}`);
const failures = Object.entries(selected).filter(([, passed]) => !passed).map(([name]) => name);
assert.deepEqual(failures, [], `Step 27 team audit failed: ${failures.join(', ')}`);
console.log('STEP27_TEAM_STATUS=PASS');
