import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, statSync } from 'node:fs';
import { readFile, readdir, rm, stat, mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { DuckDBInstance } from '@duckdb/node-api';

const DATA_ROOT = fileURLToPath(new URL('../../data/', import.meta.url));
const VIEWPORT_WIDTHS = Object.freeze([320, 360, 380, 414, 480, 600, 672, 700, 760, 900, 1200, 1280, 1440]);
const HOME_GZIP_REFERENCE = 56_512;
const HOME_GZIP_TOLERANCE = 4_096;
const CHROME_PATHS = Object.freeze([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]);
const ASSERTION_NAMES = Object.freeze([
  'indexAndPagesCoverEachOther',
  'entryCountsMatchIndependentUnprunedScan',
  'namesTagsAndWeightsMatchIndependentSource',
  'compactColumnsHaveValidIntegerIdsAndValues',
  'indexIsExternalAndHomeStaysBounded',
  'searchIsLazyAndSessionCached',
  'noJavaScriptFallbackResolvesBrowseLinks',
  'sharedNameDiscriminatorsMatchDestinationTitles',
  'keyboardResultsAreLabeledAnnouncedAndResponsive',
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function sqlString(value) {
  return `'${String(value).replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

async function factFiles(table) {
  const files = [];
  for (const entry of await readdir(path.join(DATA_ROOT, table), { withFileTypes: true })) {
    if (!entry.isFile() || !(/^\d{4}-\d{2}\.(?:parquet|ndjson)$/.test(entry.name) || entry.name === 'late.ndjson')) continue;
    const filename = path.join(DATA_ROOT, table, entry.name);
    if ((await stat(filename)).size > 0) files.push(filename);
  }
  return files.sort();
}

function directSource(files, table) {
  const parquet = files.filter((filename) => filename.endsWith('.parquet'));
  const ndjson = files.filter((filename) => filename.endsWith('.ndjson'));
  const projections = {
    matches: 'match_id, start_time, leagueid, league_name, radiant_team_id, dire_team_id, radiant_team_name, dire_team_name',
    draft: 'match_id, is_pick, hero_id',
  };
  const definitions = {
    matches: "{match_id:'UBIGINT',start_time:'BIGINT',leagueid:'INTEGER',league_name:'VARCHAR',radiant_team_id:'INTEGER',dire_team_id:'INTEGER',radiant_team_name:'VARCHAR',dire_team_name:'VARCHAR'}",
    draft: "{match_id:'UBIGINT',is_pick:'BOOLEAN',hero_id:'INTEGER'}",
  };
  const branches = [];
  if (parquet.length) branches.push(`SELECT ${projections[table]} FROM read_parquet([${parquet.map(sqlString).join(',')}], union_by_name=true)`);
  if (ndjson.length) branches.push(`SELECT ${projections[table]} FROM read_json([${ndjson.map(sqlString).join(',')}], format='newline_delimited', columns=${definitions[table]}, union_by_name=true)`);
  assert.ok(branches.length, `independent search scan found no ${table} shards`);
  return branches.join('\nUNION ALL\n');
}

function plain(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]));
}

async function rows(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjects().map(plain);
}

function titleStems(entries) {
  const byName = new Map();
  for (const entry of entries.values()) {
    const group = byName.get(entry.name) ?? [];
    group.push(entry);
    byName.set(entry.name, group);
  }
  for (const [name, sameName] of byName) {
    if (sameName.length === 1) {
      sameName[0].discriminator = '';
      continue;
    }
    const byYear = new Map();
    for (const entry of sameName) {
      const candidate = String(entry.firstYear);
      const group = byYear.get(candidate) ?? [];
      group.push(entry);
      byYear.set(candidate, group);
    }
    for (const [year, sameYear] of byYear) {
      for (const entry of sameYear) entry.discriminator = sameYear.length === 1 ? `(${year})` : `(${entry.id})`;
    }
  }
}

async function independentEntries() {
  const [matchFiles, draftFiles] = await Promise.all([factFiles('matches'), factFiles('draft')]);
  const database = await DuckDBInstance.create(':memory:');
  const connection = await database.connect();
  try {
    const matches = await rows(connection, `SELECT * FROM (${directSource(matchFiles, 'matches')}) m ORDER BY start_time DESC, match_id DESC`);
    const draft = await rows(connection, `SELECT * FROM (${directSource(draftFiles, 'draft')}) d`);
    const teamReferences = await rows(connection, `SELECT team_id,name,tag FROM read_parquet(${sqlString(path.join(DATA_ROOT, 'reference', 'teams.parquet'))})`);
    const leagueReferences = await rows(connection, `SELECT leagueid,name FROM read_parquet(${sqlString(path.join(DATA_ROOT, 'reference', 'leagues.parquet'))})`);
    const heroReferences = await rows(connection, `SELECT id,name,localized_name FROM read_parquet(${sqlString(path.join(DATA_ROOT, 'reference', 'heroes.parquet'))})`);
    const teamRefs = new Map();
    for (const row of teamReferences) if (!teamRefs.has(Number(row.team_id))) teamRefs.set(Number(row.team_id), row);
    const leagueRefs = new Map();
    for (const row of leagueReferences) if (!leagueRefs.has(Number(row.leagueid))) leagueRefs.set(Number(row.leagueid), row);
    const teams = new Map();
    const leagues = new Map();
    const seenMatches = new Set();
    for (const row of matches) {
      const matchId = Number(row.match_id);
      if (!Number.isSafeInteger(matchId) || seenMatches.has(matchId)) continue;
      seenMatches.add(matchId);
      const startTime = Number(row.start_time);
      const sides = [
        [row.radiant_team_id, row.radiant_team_name],
        [row.dire_team_id, row.dire_team_name],
      ];
      const seenTeams = new Set();
      for (const [rawId, eraName] of sides) {
        if (rawId === null || rawId === undefined) continue;
        const id = Number(rawId);
        if (!Number.isSafeInteger(id) || seenTeams.has(id)) continue;
        seenTeams.add(id);
        const entry = teams.get(id) ?? { id, matchCount: 0, firstStart: startTime, latestEraName: null };
        entry.matchCount += 1;
        entry.firstStart = Math.min(entry.firstStart, startTime);
        entry.latestEraName ??= cleanText(eraName);
        teams.set(id, entry);
      }
      const leagueId = Number(row.leagueid);
      if (Number.isSafeInteger(leagueId)) {
        const entry = leagues.get(leagueId) ?? { id: leagueId, matchCount: 0, firstStart: startTime, latestName: null };
        entry.matchCount += 1;
        entry.firstStart = Math.min(entry.firstStart, startTime);
        entry.latestName ??= cleanText(row.league_name);
        leagues.set(leagueId, entry);
      }
    }
    for (const entry of teams.values()) {
      const reference = teamRefs.get(entry.id);
      entry.name = cleanText(reference?.name) ?? entry.latestEraName ?? `Team ${entry.id}`;
      entry.tag = cleanText(reference?.tag) ?? '';
      entry.firstYear = new Date(entry.firstStart * 1_000).getUTCFullYear();
    }
    for (const entry of leagues.values()) {
      entry.name = cleanText(leagueRefs.get(entry.id)?.name) ?? entry.latestName ?? 'League name unavailable';
      entry.tag = '';
      entry.firstYear = new Date(entry.firstStart * 1_000).getUTCFullYear();
    }
    titleStems(teams);
    titleStems(leagues);
    const contestByHero = new Map();
    for (const row of draft) {
      const heroId = Number(row.hero_id);
      if (Number.isSafeInteger(heroId)) contestByHero.set(heroId, (contestByHero.get(heroId) ?? 0) + 1);
    }
    const heroes = new Map();
    for (const reference of heroReferences) {
      const id = Number(reference.id);
      const machineName = cleanText(reference.name)?.replace(/^npc_dota_hero_/, '').replaceAll('_', ' ');
      heroes.set(id, {
        id,
        name: cleanText(reference.localized_name) ?? machineName ?? `Hero ${id}`,
        tag: '',
        discriminator: 'hero',
        matchCount: contestByHero.get(id) ?? 0,
      });
    }
    return { team: teams, tournament: leagues, hero: heroes };
  } finally {
    connection.closeSync();
  }
}

function expand(type, columns) {
  const collision = new Map(columns.c?.i.map((rowIndex, index) => [
    rowIndex,
    `(${columns.c.y[index] || columns.i[rowIndex]})`,
  ]) ?? []);
  return columns.i.map((id, index) => ({
    type,
    id,
    name: columns.n[index],
    tag: columns.g?.[index] ?? '',
    discriminator: type === 'hero' ? 'hero' : (collision.get(index) ?? ''),
    weight: columns.w?.[index] ?? 0,
  }));
}

async function numericDirectories(root) {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name));
  const routes = await Promise.all(entries.map(async (entry) => {
    try {
      return (await stat(path.join(root, entry.name, 'index.html'))).isFile() ? Number(entry.name) : null;
    } catch {
      return null;
    }
  }));
  return new Set(routes.filter((id) => id !== null));
}

async function filesBelow(directory, name) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(filename, name));
    else if (entry.name === name) files.push(filename);
  }
  return files;
}

async function matchingFiles(files, predicate) {
  const matches = [];
  for (let offset = 0; offset < files.length; offset += 128) {
    const batch = files.slice(offset, offset + 128);
    const contents = await Promise.all(batch.map((filename) => readFile(filename, 'utf8')));
    contents.forEach((content, index) => {
      if (predicate(content)) matches.push(batch[index]);
    });
  }
  return matches;
}

function hrefFor(entry) {
  const segment = entry.type === 'team' ? 'teams' : entry.type === 'tournament' ? 'tournaments' : 'heroes';
  return `/${segment}/${entry.id}/`;
}

function decodeHtml(value) {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
}

function titleDiscriminator(title, name) {
  const stem = title.replace(/ — DotaInfo$/, '');
  return stem.startsWith(name) ? stem.slice(name.length).trim() : null;
}

function contentType(filename) {
  if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filename.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filename.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function staticServer(root) {
  const requests = { index: 0 };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/data/search-index.json') requests.index += 1;
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const candidate = path.resolve(root, relative.endsWith('/') ? `${relative}index.html` : relative);
      assert.ok(candidate === root || candidate.startsWith(`${root}${path.sep}`));
      if (!(await stat(candidate)).isFile()) throw new Error('not a file');
      response.writeHead(200, { 'content-type': contentType(candidate) });
      createReadStream(candidate).pipe(response);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, requests };
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

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Chrome DevTools WebSocket did not open: ${url}`)), 5_000);
      timeout.unref();
      this.socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener('error', (error) => { clearTimeout(timeout); reject(error); }, { once: true });
    });
    this.socket.addEventListener('message', async (event) => {
      const payload = typeof event.data === 'string' ? event.data : event.data instanceof Blob
        ? await event.data.text() : new TextDecoder().decode(event.data);
      const message = JSON.parse(payload);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        const listeners = this.events.get(message.method) ?? [];
        this.events.delete(message.method);
        for (const resolve of listeners) resolve(message.params);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, 5_000);
      timeout.unref();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
    });
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
  close() { this.socket.close(); }
}

async function waitForChrome(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function newTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  assert.ok(response.ok);
  return new CdpClient((await response.json()).webSocketDebuggerUrl);
}

async function browserCheck(chrome, outputRoot) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'dotainfo-step28-'));
  const profile = await mkdtemp(path.join(scratch, 'profile-'));
  const chromePort = await freePort();
  const { server, requests } = await staticServer(outputRoot);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(chrome, [
    '--headless=new', '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
    '--disable-gpu', '--disable-extensions', '--no-proxy-server', '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const viewports = [];
  let interaction;
  let client;
  try {
    await waitForChrome(chromePort);
    const target = await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, {
      method: 'PUT', signal: AbortSignal.timeout(5_000),
    });
    client = new CdpClient((await target.json()).webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');
    await client.send('Network.setBlockedURLs', { urls: ['https://*'] });
    for (const [index, width] of VIEWPORT_WIDTHS.entries()) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: true });
      await client.send('Page.navigate', { url: `${origin}/search/` });
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          const state = await client.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
          ready = ['interactive', 'complete'].includes(state.result.value);
        } catch {}
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(ready, `search page was not ready at ${width}px`);
        const metrics = await client.send('Runtime.evaluate', {
          expression: `({width:innerWidth,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,controls:document.querySelectorAll('[data-search-root]').length,labels:[...document.querySelectorAll('[data-search-root] input')].every(input=>document.querySelector('label[for="'+input.id+'"]'))})`,
          returnByValue: true,
        });
        viewports.push({ requested: width, ...metrics.result.value });
        if (index === 0) {
          const before = requests.index;
          const result = await client.send('Runtime.evaluate', {
            expression: `(async()=>{const roots=[...document.querySelectorAll('[data-search-root]')];const header=roots[0].querySelector('input');const page=roots[1].querySelector('input');header.focus();await new Promise(r=>setTimeout(r,100));page.focus();page.value='Dominion';page.dispatchEvent(new Event('input',{bubbles:true}));for(let i=0;i<100&&roots[1].querySelector('[data-search-status]').textContent.includes('Loading');i++)await new Promise(r=>setTimeout(r,25));const links=[...roots[1].querySelectorAll('[data-search-list] a')];page.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));return{expanded:page.getAttribute('aria-expanded'),active:page.getAttribute('aria-activedescendant'),status:roots[1].querySelector('[data-search-status]').textContent,live:roots[1].querySelector('[role=status]').getAttribute('aria-live'),listRole:roots[1].querySelector('[data-search-list]').getAttribute('role'),results:links.map(a=>({href:a.getAttribute('href'),id:Number(a.dataset.searchResultId),type:a.dataset.searchResultType,discriminator:a.dataset.searchDiscriminator,selected:a.getAttribute('aria-selected')}))}})()`,
            awaitPromise: true,
            returnByValue: true,
          });
          interaction = { requestsBefore: before, requestsAfter: requests.index, ...result.result.value };
        }
    }
    return { viewports, interaction };
  } finally {
    if (client) client.close();
    if (browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const outputRoot = path.resolve(argument('--dist') ?? 'dist');
const only = argument('--only');
if (only) assert.ok(ASSERTION_NAMES.includes(only), `unknown assertion: ${only}`);
const indexFilename = path.join(outputRoot, 'data', 'search-index.json');
const indexText = await readFile(indexFilename, 'utf8');
const index = JSON.parse(indexText);
const actualEntries = [
  ...expand('team', index.t),
  ...expand('tournament', index.l),
  ...expand('hero', index.h),
];
const actualByKey = new Map(actualEntries.map((entry) => [`${entry.type}:${entry.id}`, entry]));
const expectedGroups = await independentEntries();
const expectedEntries = Object.entries(expectedGroups).flatMap(([type, entries]) => [...entries.values()].map((entry) => ({ type, ...entry })));
const expectedByKey = new Map(expectedEntries.map((entry) => [`${entry.type}:${entry.id}`, entry]));
const routeSets = {
  team: await numericDirectories(path.join(outputRoot, 'teams')),
  tournament: await numericDirectories(path.join(outputRoot, 'tournaments')),
  hero: await numericDirectories(path.join(outputRoot, 'heroes')),
};
const indexedSets = Object.fromEntries(['team', 'tournament', 'hero'].map((type) => [type, new Set(actualEntries.filter((entry) => entry.type === type).map((entry) => entry.id))]));
const validColumns = index.v === 1 && [['t', ['i', 'n', 'g', 'w']], ['l', ['i', 'n']], ['h', ['i', 'n']]].every(([type, keys]) => {
  const columns = index[type];
  const length = columns.i.length;
  return keys.every((key) => Array.isArray(columns[key]) && columns[key].length === length)
    && columns.i.every(Number.isSafeInteger)
    && columns.n.every((name) => typeof name === 'string' && name.trim())
    && (!columns.w || columns.w.every((weight) => Number.isSafeInteger(weight) && weight >= 0))
    && (!columns.g || columns.g.every((tag) => typeof tag === 'string'))
    && (!columns.c || (columns.c.i.length === columns.c.y.length
      && columns.c.i.every((rowIndex) => Number.isSafeInteger(rowIndex) && rowIndex >= 0 && rowIndex < length)
      && columns.c.y.every((value) => Number.isSafeInteger(value) && (value === 0 || (value >= 1970 && value <= 9999)))));
});
const valueCoverage = expectedEntries.every((expected) => {
  const actual = actualByKey.get(`${expected.type}:${expected.id}`);
  return actual && actual.name === expected.name && actual.tag === expected.tag
    && actual.discriminator === expected.discriminator
    && (expected.type !== 'team' || actual.weight === expected.matchCount);
});
const htmlFiles = await filesBelow(outputRoot, 'index.html');
const indexSignature = indexText.slice(0, 256);
const inlineFiles = await matchingFiles(htmlFiles, (html) => html.includes(indexSignature));
const homeBytes = await readFile(path.join(outputRoot, 'index.html'));
const homeGzip = gzipSync(homeBytes, { level: 9 }).length;
const searchHtml = await readFile(path.join(outputRoot, 'search', 'index.html'), 'utf8');
const noscript = /<noscript>([\s\S]*?)<\/noscript>/i.exec(searchHtml)?.[1] ?? '';
const browseHrefs = [...noscript.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
const expectedBrowse = ['/teams/', '/tournaments/', '/heroes/'];
const fallbackValid = /Live search requires JavaScript/i.test(noscript)
  && expectedBrowse.every((href) => browseHrefs.includes(href)
    && statSync(path.join(outputRoot, href.slice(1), 'index.html')).isFile());
const globalNames = new Map();
for (const entry of actualEntries) {
  const group = globalNames.get(entry.name) ?? [];
  group.push(entry);
  globalNames.set(entry.name, group);
}
const sharedEntries = [...globalNames.values()].filter((group) => group.length > 1).flat();
let destinationDiscriminators = true;
const sharedPages = await Promise.all(sharedEntries.map(async (entry) => ({
  entry,
  html: await readFile(path.join(outputRoot, hrefFor(entry).slice(1), 'index.html'), 'utf8'),
})));
for (const { entry, html } of sharedPages) {
  const title = decodeHtml(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  if (titleDiscriminator(title, entry.name) !== entry.discriminator) destinationDiscriminators = false;
}
let browser = null;
if (!only || ['searchIsLazyAndSessionCached', 'sharedNameDiscriminatorsMatchDestinationTitles', 'keyboardResultsAreLabeledAnnouncedAndResponsive'].includes(only)) {
  const chrome = CHROME_PATHS.find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } });
  assert.ok(chrome, 'Chrome or Edge is required for the Step 28 search gate');
  browser = await browserCheck(chrome, outputRoot);
}
const runtimeDiscriminators = browser?.interaction.results.every((result) => {
  const entry = actualByKey.get(`${result.type}:${result.id}`);
  return entry && result.discriminator === entry.discriminator;
}) ?? true;
const assertions = Object.freeze({
  indexAndPagesCoverEachOther: ['team', 'tournament', 'hero'].every((type) => routeSets[type].size === indexedSets[type].size
    && [...routeSets[type]].every((id) => indexedSets[type].has(id))
    && [...indexedSets[type]].every((id) => routeSets[type].has(id))),
  entryCountsMatchIndependentUnprunedScan: actualEntries.length === expectedEntries.length
    && ['team', 'tournament', 'hero'].every((type) => indexedSets[type].size === expectedGroups[type].size),
  namesTagsAndWeightsMatchIndependentSource: actualByKey.size === expectedByKey.size && valueCoverage,
  compactColumnsHaveValidIntegerIdsAndValues: validColumns && actualByKey.size === actualEntries.length,
  indexIsExternalAndHomeStaysBounded: inlineFiles.length === 0 && homeGzip <= HOME_GZIP_REFERENCE + HOME_GZIP_TOLERANCE,
  searchIsLazyAndSessionCached: browser ? browser.interaction.requestsBefore === 0 && browser.interaction.requestsAfter === 1 : true,
  noJavaScriptFallbackResolvesBrowseLinks: fallbackValid,
  sharedNameDiscriminatorsMatchDestinationTitles: destinationDiscriminators && runtimeDiscriminators,
  keyboardResultsAreLabeledAnnouncedAndResponsive: browser ? browser.viewports.length === VIEWPORT_WIDTHS.length
    && browser.viewports.every((sample, index) => sample.requested === VIEWPORT_WIDTHS[index]
      && sample.width === sample.clientWidth && sample.scrollWidth === sample.clientWidth
      && sample.controls === 2 && sample.labels)
    && browser.interaction.expanded === 'true' && browser.interaction.active
    && browser.interaction.status.match(/^\d+ results? shown\.$/)
    && browser.interaction.live === 'polite' && browser.interaction.listRole === 'listbox'
    && browser.interaction.results.length > 1
    && browser.interaction.results.filter((result) => result.selected === 'true').length === 1 : true,
});
const selected = Object.freeze(Object.fromEntries(Object.entries(assertions).filter(([name]) => !only || name === only)));
const typeCounts = Object.fromEntries(['team', 'tournament', 'hero'].map((type) => [type, indexedSets[type].size]));
console.log(`STEP28_SEARCH_AUDIT=${JSON.stringify({
  entries: actualEntries.length,
  typeCounts,
  taggedTeams: actualEntries.filter((entry) => entry.type === 'team' && entry.tag).length,
  sharedNames: [...globalNames.values()].filter((group) => group.length > 1).length,
  rawBytes: Buffer.byteLength(indexText),
  gzipBytes: gzipSync(indexText, { level: 9 }).length,
  homeGzipBytes: homeGzip,
  htmlFiles: htmlFiles.length,
  scannedHtmlFiles: htmlFiles.length,
  inlineFiles,
  widths: VIEWPORT_WIDTHS,
  browser,
})}`);
console.log(`STEP28_SEARCH_ASSERTIONS=${JSON.stringify(selected)}`);
const failures = Object.entries(selected).filter(([, passed]) => !passed).map(([name]) => name);
assert.deepEqual(failures, [], `Step 28 search audit failed: ${failures.join(', ')}`);
console.log('STEP28_SEARCH_STATUS=PASS');
