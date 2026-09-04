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
const HERO_REFERENCE = path.join(DATA_ROOT, 'reference', 'heroes.parquet');
const VIEWPORT_WIDTHS = Object.freeze([
  320, 360, 380, 414, 480, 600, 672, 700, 760, 900, 1200, 1280, 1440,
]);
const CHROME_PATHS = Object.freeze([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]);
const ASSERTION_NAMES = Object.freeze([
  'allHeroesHavePagesAndFactIdsResolve',
  'indexContainsAllHeroReferenceFields',
  'heroCountsMatchIndependentUnprunedScan',
  'draftTeamZeroIsRadiant',
  'rateDenominatorsAreDocumentedPopulations',
  'emittedHeroTitlesAreUnique',
  'summedHeroPicksEqualAllPickRows',
  'patchTrendMatchesIndependentUnprunedScan',
  'laneDistributionMatchesIndependentUnprunedScan',
  'exactWidthSweepHasNoHorizontalOverflow',
  'emittedHeroColorsPassContrastAndControlSurfaces',
  'lineBordersAttachToStrongHeroBoundaries',
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function hasArgument(name) {
  return process.argv.includes(name);
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
  const definitions = Object.freeze({
    matches: "{match_id: 'UBIGINT', start_time: 'BIGINT', radiant_win: 'BOOLEAN', patch: 'VARCHAR'}",
    draft: "{match_id: 'UBIGINT', is_pick: 'BOOLEAN', hero_id: 'INTEGER', team: 'SMALLINT'}",
    players: "{match_id: 'UBIGINT', hero_id: 'INTEGER', is_radiant: 'BOOLEAN', lane_role: 'INTEGER'}",
  });
  const projections = Object.freeze({
    matches: 'match_id, start_time, radiant_win, patch',
    draft: 'match_id, is_pick, hero_id, team',
    players: 'match_id, hero_id, is_radiant, lane_role',
  });
  const branches = [];
  if (parquet.length > 0) {
    branches.push(`SELECT ${projections[table]} FROM read_parquet([${parquet.map(sqlString).join(', ')}], union_by_name = true)`);
  }
  if (ndjson.length > 0) {
    branches.push(`SELECT ${projections[table]} FROM read_json([${ndjson.map(sqlString).join(', ')}], format = 'newline_delimited', columns = ${definitions[table]}, union_by_name = true)`);
  }
  assert.ok(branches.length > 0, `independent hero scan found no ${table} shards`);
  return branches.join('\nUNION ALL\n');
}

function plain(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]));
}

async function rows(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjects().map(plain);
}

function patchKey(value) {
  return value === null || value === undefined ? 'unavailable' : String(value);
}

async function independentSource() {
  const [matchFiles, draftFiles, playerFiles] = await Promise.all([
    factFiles('matches'), factFiles('draft'), factFiles('players'),
  ]);
  const matches = directSource(matchFiles, 'matches');
  const draft = directSource(draftFiles, 'draft');
  const players = directSource(playerFiles, 'players');
  const database = await DuckDBInstance.create(':memory:');
  const connection = await database.connect();
  try {
    const references = await rows(connection, `
      SELECT id, name, localized_name, primary_attr, attack_type, roles
      FROM read_parquet(${sqlString(HERO_REFERENCE)}) ORDER BY id
    `);
    const [global] = await rows(connection, `
      WITH committed_matches AS (${matches}), committed_draft AS (${draft})
      SELECT
        (SELECT count(*) FROM committed_matches) AS total_matches,
        (SELECT count(*) FROM committed_matches WHERE radiant_win IS NULL) AS null_result_matches,
        (SELECT count(DISTINCT patch) FROM committed_matches) AS distinct_patches,
        (SELECT count(*) FROM committed_matches WHERE patch IS NULL) AS null_patch_matches,
        count(*) AS draft_rows,
        count(DISTINCT match_id) AS draft_matches,
        count(*) FILTER (WHERE is_pick) AS picks,
        count(*) FILTER (WHERE NOT is_pick) AS bans
      FROM committed_draft
    `);
    const heroDraft = await rows(connection, `
      WITH committed_matches AS (${matches}), committed_draft AS (${draft})
      SELECT
        d.hero_id,
        count(*) FILTER (WHERE d.is_pick) AS pick_count,
        count(*) FILTER (WHERE NOT d.is_pick) AS ban_count,
        count(*) FILTER (WHERE d.is_pick AND m.radiant_win IS NOT NULL) AS win_eligible_picks,
        count(*) FILTER (
          WHERE d.is_pick AND m.radiant_win IS NOT NULL
            AND ((d.team = 0 AND m.radiant_win) OR (d.team = 1 AND NOT m.radiant_win))
        ) AS wins
      FROM committed_draft AS d
      LEFT JOIN committed_matches AS m USING (match_id)
      GROUP BY d.hero_id ORDER BY d.hero_id
    `);
    const patches = await rows(connection, `
      WITH committed_matches AS (${matches}), committed_draft AS (${draft})
      SELECT m.patch, count(DISTINCT d.match_id) AS draft_match_count, min(m.start_time) AS first_start
      FROM committed_draft AS d LEFT JOIN committed_matches AS m USING (match_id)
      GROUP BY m.patch ORDER BY first_start, m.patch
    `);
    const heroPatches = await rows(connection, `
      WITH committed_matches AS (${matches}), committed_draft AS (${draft})
      SELECT
        d.hero_id, m.patch,
        count(*) FILTER (WHERE d.is_pick) AS pick_count,
        count(*) FILTER (WHERE NOT d.is_pick) AS ban_count,
        count(*) FILTER (WHERE d.is_pick AND m.radiant_win IS NOT NULL) AS win_eligible_picks,
        count(*) FILTER (
          WHERE d.is_pick AND m.radiant_win IS NOT NULL
            AND ((d.team = 0 AND m.radiant_win) OR (d.team = 1 AND NOT m.radiant_win))
        ) AS wins
      FROM committed_draft AS d LEFT JOIN committed_matches AS m USING (match_id)
      GROUP BY d.hero_id, m.patch ORDER BY d.hero_id, m.patch
    `);
    const lanes = await rows(connection, `
      WITH committed_players AS (${players})
      SELECT hero_id, lane_role, count(*) AS appearances
      FROM committed_players GROUP BY hero_id, lane_role ORDER BY hero_id, lane_role
    `);
    const [teamEncoding] = await rows(connection, `
      WITH committed_draft AS (${draft}), committed_players AS (${players}), joined AS (
        SELECT d.team, p.is_radiant
        FROM committed_draft AS d
        INNER JOIN committed_players AS p USING (match_id, hero_id)
        WHERE d.is_pick
      )
      SELECT
        count(*) AS joined_picks,
        count(DISTINCT team) AS team_values,
        count(*) FILTER (WHERE (team = 0 AND is_radiant) OR (team = 1 AND NOT is_radiant)) AS normal_agreements,
        count(*) FILTER (WHERE (team = 1 AND is_radiant) OR (team = 0 AND NOT is_radiant)) AS inverted_agreements
      FROM joined
    `);
    return Object.freeze({ references, global, heroDraft, patches, heroPatches, lanes, teamEncoding });
  } finally {
    connection.closeSync();
  }
}

function attributes(tag) {
  const parsed = new Map();
  const expression = /\s([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.matchAll(expression)) parsed.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  return parsed;
}

function decodeHtml(value) {
  return (value ?? '')
    .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

function numericAttributes(parsed, names) {
  return Object.fromEntries(names.map((name) => [name, Number(parsed.get(name))]));
}

async function emittedHeroPages(outputRoot) {
  const root = path.join(outputRoot, 'heroes');
  const pages = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const filename = path.join(root, entry.name, 'index.html');
    const html = await readFile(filename, 'utf8');
    const marker = /<article\b[^>]*\bdata-hero-page\b[^>]*>/i.exec(html)?.[0] ?? '';
    const parsed = attributes(marker);
    const trends = [...html.matchAll(/<div\b[^>]*\bdata-patch="[^"]+"[^>]*>/gi)].map((match) => {
      const row = attributes(match[0]);
      return Object.freeze({
        patch: decodeHtml(row.get('data-patch')),
        ...numericAttributes(row, [
          'data-draft-match-denominator', 'data-pick-count', 'data-ban-count',
          'data-wins', 'data-win-eligible-picks',
        ]),
      });
    });
    const lanes = [...html.matchAll(/<li\b[^>]*\bdata-lane-role="[^"]+"[^>]*>/gi)].map((match) => {
      const row = attributes(match[0]);
      return Object.freeze({
        laneRole: decodeHtml(row.get('data-lane-role')),
        appearances: Number(row.get('data-appearances')),
      });
    });
    pages.push(Object.freeze({
      filename,
      html,
      heroId: Number(parsed.get('data-hero-id')),
      title: decodeHtml(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''),
      ...numericAttributes(parsed, [
        'data-total-matches', 'data-draft-match-denominator', 'data-pick-count',
        'data-ban-count', 'data-wins', 'data-win-eligible-picks', 'data-player-count',
      ]),
      trends,
      lanes,
    }));
  }
  return pages.sort((left, right) => left.heroId - right.heroId);
}

function emittedIndexRows(html) {
  return [...html.matchAll(/<a\b[^>]*\bdata-index-hero-id="[^"]+"[^>]*>/gi)].map((match) => {
    const parsed = attributes(match[0]);
    return Object.freeze({
      heroId: Number(parsed.get('data-index-hero-id')),
      name: decodeHtml(parsed.get('data-hero-name')),
      primaryAttribute: decodeHtml(parsed.get('data-primary-attribute')),
      attackType: decodeHtml(parsed.get('data-attack-type')),
      roles: decodeHtml(parsed.get('data-roles')).split('|').filter(Boolean),
      ...numericAttributes(parsed, [
        'data-pick-count', 'data-ban-count', 'data-wins', 'data-win-eligible-picks',
      ]),
    });
  });
}

function referenceName(reference) {
  const localized = typeof reference.localized_name === 'string' ? reference.localized_name.trim() : '';
  if (localized) return localized;
  const machine = typeof reference.name === 'string' ? reference.name.trim() : '';
  return machine.replace(/^npc_dota_hero_/, '').replaceAll('_', ' ') || `Hero ${reference.id}`;
}

function referenceRoles(reference) {
  const roles = Array.isArray(reference.roles) ? reference.roles : reference.roles?.items ?? [];
  return roles.map((role) => String(role).trim()).filter(Boolean);
}

function attributeId(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['str', 'agi', 'int', 'all'].includes(normalized) ? normalized : 'other';
}

function groupByHero(rowsToGroup) {
  const grouped = new Map();
  for (const row of rowsToGroup) {
    const heroId = Number(row.hero_id);
    const group = grouped.get(heroId) ?? [];
    group.push(row);
    grouped.set(heroId, group);
  }
  return grouped;
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
  const scratch = await mkdtemp(path.join(tmpdir(), 'dotainfo-step26-hero-browser-'));
  const port = await freePort();
  const server = await staticServer(outputRoot);
  const browser = spawn(chrome, [
    '--headless=new', '--disable-background-networking', '--disable-breakpad',
    '--disable-crash-reporter', '--disable-gpu', '--disable-extensions', '--no-proxy-server',
    '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*', `--remote-debugging-port=${port}`,
    `--user-data-dir=${scratch}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let client;
  try {
    await waitForChrome(port);
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT', signal: AbortSignal.timeout(5_000),
    });
    const webSocketUrl = (await target.json()).webSocketDebuggerUrl;
    client = new CdpClient(webSocketUrl);
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
            const surface = document.querySelector('.hero-index-group, .hero-page-panel');
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
  independentSource(), emittedHeroPages(outputRoot), readFile(path.join(outputRoot, 'heroes', 'index.html'), 'utf8'),
]);
const indexMarker = attributes(/<article\b[^>]*\bdata-hero-index\b[^>]*>/i.exec(indexHtml)?.[0] ?? '');
const indexRows = emittedIndexRows(indexHtml);
const indexTitle = decodeHtml(/<title>([\s\S]*?)<\/title>/i.exec(indexHtml)?.[1] ?? '');
const pageByHero = new Map(pages.map((page) => [page.heroId, page]));
const indexByHero = new Map(indexRows.map((row) => [row.heroId, row]));
const referenceByHero = new Map(source.references.map((reference) => [Number(reference.id), reference]));
const sourceDraftByHero = new Map(source.heroDraft.map((row) => [Number(row.hero_id), row]));
const sourceLanesByHero = groupByHero(source.lanes);
const sourcePatchesByHero = groupByHero(source.heroPatches);
const draftIds = new Set(source.heroDraft.map((row) => Number(row.hero_id)));
const playerIds = new Set(source.lanes.map((row) => Number(row.hero_id)));
const patchDenominators = new Map(source.patches.map((row) => [patchKey(row.patch), Number(row.draft_match_count)]));

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
const isHeroSelector = (selector) => selector.includes('.hero-index') || selector.includes('.hero-page');
const strongSelectors = cssRules.flatMap((rule) => /border[^:]*:[^;]*var\(--line-strong\)/.test(rule.body)
  ? rule.selectors.filter(isHeroSelector) : []);
const lineRules = cssRules.flatMap((rule) => /border[^:]*:[^;]*var\(--line\)(?:;|$)/.test(rule.body)
  ? rule.selectors.filter(isHeroSelector).map((selector) => ({ selector, body: rule.body })) : []);

let measurements = [];
if (needs('exactWidthSweepHasNoHorizontalOverflow') || needs('emittedHeroColorsPassContrastAndControlSurfaces')) {
  const chrome = CHROME_PATHS.find((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
  assert.ok(chrome, 'Chrome or Edge is required for the Step 26 hero gate');
  const sampleHero = [...pages].sort((left, right) => right['data-player-count'] - left['data-player-count'])[0];
  measurements = await browserSweep(chrome, outputRoot, ['/heroes/', `/heroes/${sampleHero.heroId}/`]);
}

const coverage = source.references.length === 127
  && pages.length === source.references.length
  && indexRows.length === source.references.length
  && pageByHero.size === source.references.length
  && indexByHero.size === source.references.length
  && [...referenceByHero.keys()].every((heroId) => pageByHero.has(heroId) && indexByHero.has(heroId))
  && [...draftIds].every((heroId) => referenceByHero.has(heroId))
  && [...playerIds].every((heroId) => referenceByHero.has(heroId))
  && [...referenceByHero.keys()].every((heroId) => draftIds.has(heroId) && playerIds.has(heroId));

const referenceFields = [...referenceByHero].every(([heroId, reference]) => {
  const emitted = indexByHero.get(heroId);
  return emitted
    && emitted.name === referenceName(reference)
    && emitted.primaryAttribute === attributeId(reference.primary_attr)
    && emitted.attackType === String(reference.attack_type).trim()
    && emitted.roles.join('|') === referenceRoles(reference).join('|');
});

const countsMatch = [...sourceDraftByHero].every(([heroId, expected]) => {
  const emitted = pageByHero.get(heroId);
  return emitted
    && emitted['data-pick-count'] === Number(expected.pick_count)
    && emitted['data-ban-count'] === Number(expected.ban_count)
    && emitted['data-wins'] === Number(expected.wins)
    && emitted['data-win-eligible-picks'] === Number(expected.win_eligible_picks);
});

const inverted = hasArgument('--invert-team-encoding');
const teamAgreements = Number(inverted
  ? source.teamEncoding.inverted_agreements
  : source.teamEncoding.normal_agreements);
const joinedPicks = Number(source.teamEncoding.joined_picks);

const denominatorsMatch = Number(indexMarker.get('data-total-matches')) === Number(source.global.total_matches)
  && Number(indexMarker.get('data-draft-match-denominator')) === Number(source.global.draft_matches)
  && Number(source.global.draft_matches) !== Number(source.global.total_matches)
  && pages.every((page) => page['data-total-matches'] === Number(source.global.total_matches)
    && page['data-draft-match-denominator'] === Number(source.global.draft_matches)
    && page['data-win-eligible-picks'] === Number(sourceDraftByHero.get(page.heroId)?.win_eligible_picks))
  && /matches with\s+draft (?:data|rows), not all/i.test(indexHtml)
  && /recorded result/i.test(indexHtml)
  && pages.every((page) => /matches\s+with draft rows(?:—|&mdash;|&#8212;)not all/i.test(page.html)
    && /null-result matches stay in/i.test(page.html));

const patchTrendMatches = pages.every((page) => {
  if (page.trends.length !== source.patches.length) return false;
  const emitted = new Map(page.trends.map((trend) => [trend.patch, trend]));
  const sourceHero = new Map((sourcePatchesByHero.get(page.heroId) ?? []).map((row) => [patchKey(row.patch), row]));
  return source.patches.every((patch) => {
    const key = patchKey(patch.patch);
    const actual = emitted.get(key);
    const expected = sourceHero.get(key) ?? {};
    return actual
      && actual['data-draft-match-denominator'] === patchDenominators.get(key)
      && actual['data-pick-count'] === Number(expected.pick_count ?? 0)
      && actual['data-ban-count'] === Number(expected.ban_count ?? 0)
      && actual['data-wins'] === Number(expected.wins ?? 0)
      && actual['data-win-eligible-picks'] === Number(expected.win_eligible_picks ?? 0);
  });
});

const lanesMatch = pages.every((page) => {
  const expected = sourceLanesByHero.get(page.heroId) ?? [];
  const expectedMap = new Map(expected.map((row) => [
    row.lane_role === null ? 'unavailable' : String(row.lane_role), Number(row.appearances),
  ]));
  const actualMap = new Map(page.lanes.map((row) => [row.laneRole, row.appearances]));
  return actualMap.size === expectedMap.size
    && [...expectedMap].every(([key, appearances]) => actualMap.get(key) === appearances)
    && page['data-player-count'] === expected.reduce((sum, row) => sum + Number(row.appearances), 0);
});

const assertions = Object.freeze({
  allHeroesHavePagesAndFactIdsResolve: coverage,
  indexContainsAllHeroReferenceFields: referenceFields,
  heroCountsMatchIndependentUnprunedScan: countsMatch,
  draftTeamZeroIsRadiant: joinedPicks > 0
    && Number(source.teamEncoding.team_values) === 2
    && teamAgreements === joinedPicks,
  rateDenominatorsAreDocumentedPopulations: denominatorsMatch,
  emittedHeroTitlesAreUnique: pages.every((page) => page.title.endsWith(' — DotaInfo'))
    && indexTitle.endsWith(' — DotaInfo')
    && new Set([indexTitle, ...pages.map((page) => page.title)]).size === pages.length + 1,
  summedHeroPicksEqualAllPickRows: pages.reduce((sum, page) => sum + page['data-pick-count'], 0) === Number(source.global.picks)
    && Number(indexMarker.get('data-total-picks')) === Number(source.global.picks),
  patchTrendMatchesIndependentUnprunedScan: patchTrendMatches,
  laneDistributionMatchesIndependentUnprunedScan: lanesMatch,
  exactWidthSweepHasNoHorizontalOverflow: measurements.length === VIEWPORT_WIDTHS.length * 2
    && measurements.every((sample) => sample.clientWidth === sample.width && sample.scrollWidth === sample.clientWidth),
  emittedHeroColorsPassContrastAndControlSurfaces: colorContrast >= 4.5
    && measurements.length === VIEWPORT_WIDTHS.length * 2
    && measurements.every((sample) => sample.background === colors.surface.css
      && sample.border === colors.lineStrong.css && sample.color === colors.foreground.css),
  lineBordersAttachToStrongHeroBoundaries: lineRules.length > 0 && strongSelectors.length > 0
    && lineRules.every((rule) => strongSelectors.some((strong) => rule.selector.startsWith(`${strong} `))),
});
const selected = Object.freeze(Object.fromEntries(Object.entries(assertions).filter(([name]) => !only || name === only)));
console.log(`STEP26_HERO_AUDIT=${JSON.stringify({
  references: source.references.length,
  emittedHeroPages: pages.length,
  totalMatches: Number(source.global.total_matches),
  draftMatches: Number(source.global.draft_matches),
  draftRows: Number(source.global.draft_rows),
  picks: Number(source.global.picks),
  bans: Number(source.global.bans),
  distinctPatches: Number(source.global.distinct_patches),
  nullPatches: Number(source.global.null_patch_matches),
  nullResultMatches: Number(source.global.null_result_matches),
  joinedPicks,
  teamAgreements,
  teamEncodingTestMode: inverted ? 'inverted' : '0-radiant-1-dire',
  widths: VIEWPORT_WIDTHS,
  colorContrast: Number(colorContrast.toFixed(3)),
  lineRules: lineRules.map((rule) => rule.selector),
  overflowSamples: measurements.filter((sample) => sample.scrollWidth !== sample.clientWidth),
})}`);
console.log(`STEP26_HERO_ASSERTIONS=${JSON.stringify(selected)}`);
const failures = Object.entries(selected).filter(([, passed]) => !passed).map(([name]) => name);
assert.deepEqual(failures, [], `Step 26 hero audit failed: ${failures.join(', ')}`);
console.log('STEP26_HERO_STATUS=PASS');
