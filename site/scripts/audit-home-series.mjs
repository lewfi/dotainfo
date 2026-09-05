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
import { gzipSync } from 'node:zlib';

import { DuckDBInstance } from '@duckdb/node-api';

const DATA_ROOT = fileURLToPath(new URL('../../data/', import.meta.url));
const VIEWPORT_WIDTHS = Object.freeze([320, 360, 380, 414, 480, 600, 672, 700, 760, 900, 1200, 1280, 1440]);
const HOME_LIMIT = 300;
const SIX_HOURS = 21_600;
const DAY_SECONDS = 86_400;
const HOME_GZIP_LIMIT = 56_024;
const PLAYER_KEYS = Object.freeze(['account_id', 'assists', 'deaths', 'hero_id', 'is_radiant', 'kills', 'level', 'match_id']);
const CHROME_PATHS = Object.freeze([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]);
const ASSERTION_NAMES = Object.freeze([
  'emittedRowsMatchIndependentGrouping',
  'feedPartitionMatchesIndependentRecomputation',
  'noSeriesGroupContainsNoSeriesSentinel',
  'noSeriesGroupContainsNullTeamId',
  'standaloneRowCountMatchesIndependentRecomputation',
  'groupingKeyKeepsLeaguePairAndSpanValid',
  'seriesScoresCountWinsPerTeamId',
  'sideSwappedSeriesScoresCorrectly',
  'feedHasExactlyThreeHundredTypedRows',
  'standaloneRowsAreLabelledAndUnscored',
  'dayShardsContainEveryExpectedPlayerRow',
  'sixViewsAndApprovedDefaultWorkWithoutJavaScript',
  'activeTournamentsMatchIndependentFourteenDayScan',
  'expansionIsLazyAndDayCached',
  'expandersAndMapTabsAreAccessible',
  'expandedScoreboardFitsEveryWidth',
  'homeGzipRemainsBounded',
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
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
  return files.sort((left, right) => (left.endsWith('late.ndjson') ? 1 : right.endsWith('late.ndjson') ? -1 : left.localeCompare(right)));
}

function directSource(files, table) {
  const parquet = files.filter((filename) => filename.endsWith('.parquet'));
  const ndjson = files.filter((filename) => filename.endsWith('.ndjson'));
  const projection = table === 'matches'
    ? 'match_id,start_time,leagueid,league_tier,series_id,series_type,radiant_team_id,dire_team_id,radiant_win'
    : 'match_id,account_id,hero_id,is_radiant,kills,deaths,assists,level';
  const definitions = table === 'matches'
    ? "{match_id:'UBIGINT',start_time:'BIGINT',leagueid:'INTEGER',league_tier:'VARCHAR',series_id:'INTEGER',series_type:'INTEGER',radiant_team_id:'INTEGER',dire_team_id:'INTEGER',radiant_win:'BOOLEAN'}"
    : "{match_id:'UBIGINT',account_id:'UBIGINT',hero_id:'INTEGER',is_radiant:'BOOLEAN',kills:'INTEGER',deaths:'INTEGER',assists:'INTEGER',level:'INTEGER'}";
  const branches = [];
  if (parquet.length) branches.push(`SELECT ${projection} FROM read_parquet([${parquet.map(sqlString).join(',')}],union_by_name=true)`);
  if (ndjson.length) branches.push(`SELECT ${projection} FROM read_json([${ndjson.map(sqlString).join(',')}],format='newline_delimited',columns=${definitions},union_by_name=true)`);
  assert.ok(branches.length, `no ${table} fact shards found`);
  return branches.join('\nUNION ALL\n');
}

function plain(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]));
}

async function rows(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjects().map(plain);
}

function pair(row) {
  return [row.radiant_team_id ?? null, row.dire_team_id ?? null].sort((left, right) => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left - right;
  });
}

function samePair(left, right) {
  return left[0] === right[0] && left[1] === right[1];
}

function groupKey(row) {
  return JSON.stringify([row.series_id, row.leagueid, ...pair(row)]);
}

function isDirectStandalone(row) {
  return row.series_id === null || row.series_id === 0
    || row.radiant_team_id === null || row.dire_team_id === null;
}

function directGroups(input) {
  const groups = [];
  const keyed = new Map();
  for (const row of input) {
    if (isDirectStandalone(row)) {
      groups.push({ kind: 'standalone', rows: [row] });
      continue;
    }
    const bucket = keyed.get(groupKey(row)) ?? [];
    bucket.push(row);
    keyed.set(groupKey(row), bucket);
  }
  for (const bucket of keyed.values()) {
    bucket.sort((left, right) => left.start_time - right.start_time || left.match_id - right.match_id);
    let segment = [];
    for (const row of bucket) {
      if (segment.length && row.start_time - segment.at(-1).start_time > SIX_HOURS) {
        groups.push({ kind: 'series', rows: segment });
        segment = [];
      }
      segment.push(row);
    }
    if (segment.length) groups.push({ kind: 'series', rows: segment });
  }
  groups.sort((left, right) => {
    const leftRow = left.rows.at(-1);
    const rightRow = right.rows.at(-1);
    return rightRow.start_time - leftRow.start_time || rightRow.match_id - leftRow.match_id;
  });
  return groups;
}

function decodeHtml(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function attributes(tag) {
  const result = new Map();
  for (const match of tag.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    result.set(match[1].toLowerCase(), decodeHtml(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return result;
}

function numberOrNull(value) {
  return value === 'null' || value === undefined ? null : Number(value);
}

function emittedRows(html) {
  const tags = [...html.matchAll(/<li\b[^>]*\bdata-series-row(?:\s|>|=)[^>]*>/gi)].map((match) => attributes(match[0]));
  const expansions = [...html.matchAll(/<section\b[^>]*\bdata-series-expansion(?:\s|>|=)[^>]*>/gi)].map((match) => attributes(match[0]));
  assert.equal(tags.length, expansions.length, 'series rows and expansion payloads differ');
  return tags.map((tag, index) => {
    const result = tag.has('data-series-result')
      ? tag.get('data-series-result').split(',').map(Number) : null;
    return {
      kind: tag.get('data-series-kind'),
      label: tag.get('data-row-label'),
      tier: tag.get('data-tier-category'),
      scoreOne: result?.[0] ?? null,
      scoreTwo: result?.[1] ?? null,
      unknownMaps: result?.[2] ?? null,
      day: expansions[index].get('data-player-day'),
      maps: expansions[index].get('data-map-rows').split(',').map((value) => [Number(value)]),
    };
  });
}

function directScore(group) {
  const teamOne = group.rows[0].radiant_team_id ?? null;
  const teamTwo = group.rows[0].dire_team_id ?? null;
  const valid = teamOne !== null && teamTwo !== null && teamOne !== teamTwo;
  let one = 0;
  let two = 0;
  let unknown = 0;
  for (const row of group.rows) {
    const winner = row.radiant_win === true ? row.radiant_team_id
      : row.radiant_win === false ? row.dire_team_id : null;
    if (!valid || winner === null) unknown += 1;
    else if (winner === teamOne) one += 1;
    else if (winner === teamTwo) two += 1;
    else unknown += 1;
  }
  const swapped = valid && group.rows.some((row) => row.radiant_team_id === teamTwo && row.dire_team_id === teamOne);
  return { one, two, unknown, swapped };
}

function sideScore(group) {
  let radiant = 0;
  let dire = 0;
  let unknown = 0;
  for (const row of group.rows) {
    if (row.radiant_win === true) radiant += 1;
    else if (row.radiant_win === false) dire += 1;
    else unknown += 1;
  }
  return { radiant, dire, unknown };
}

function rowSignature(row) {
  return JSON.stringify(['match_id', 'account_id', 'hero_id', 'is_radiant', 'kills', 'deaths', 'assists', 'level'].map((key) => row[key] ?? null));
}

function contentType(filename) {
  if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filename.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filename.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function staticServer(root) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/data/home-players/')) requests.push(url.pathname);
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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
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
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', async (event) => {
      const text = typeof event.data === 'string' ? event.data : await event.data.text();
      const message = JSON.parse(text);
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
  close() { this.socket.close(); }
}

async function waitForChrome(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function newTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  return new CdpClient((await response.json()).webSocketDebuggerUrl);
}

async function ready(client) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await client.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (state.result.value === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('page did not become ready');
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function browserCheck(chrome, outputRoot) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'dotainfo-step29-'));
  const profile = path.join(scratch, 'profile');
  const chromePort = await freePort();
  const { server, requests } = await staticServer(outputRoot);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(chrome, [
    '--headless=new', '--disable-background-networking', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-allow-origins=*', `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let client;
  try {
    await waitForChrome(chromePort);
    client = await newTarget(chromePort);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');
    await client.send('Network.setBlockedURLs', { urls: ['https://*'] });
    await client.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: true });
    await client.send('Page.navigate', { url: `${origin}/` });
    await ready(client);
    const requestsBefore = requests.length;
    const interaction = await evaluate(client, `(async()=>{
      const rows=[...document.querySelectorAll('[data-series-row]')];
      const first=rows.find(row=>row.querySelector('[data-series-expansion]').dataset.mapRows.split(',').length>1)??rows[0];
      const day=first.dataset.day;
      const second=rows.find(row=>row!==first&&row.dataset.day===day);
      const button=first.querySelector('[data-series-expand]');
      const link=first.querySelector('.series-row-link');
      const order=link.compareDocumentPosition(button)&Node.DOCUMENT_POSITION_FOLLOWING;
      button.click();
      for(let i=0;i<200&&!first.querySelector('[data-map-scoreboard][data-load-state=loaded]');i++)await new Promise(r=>setTimeout(r,25));
      const tabs=[...first.querySelectorAll('[role=tab]')];
      if(tabs.length>1){tabs[0].focus();tabs[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));}
      if(second){second.querySelector('[data-series-expand]').click();for(let i=0;i<200&&!second.querySelector('[data-map-scoreboard][data-load-state=loaded]');i++)await new Promise(r=>setTimeout(r,25));}
      return{day,hasSecond:Boolean(second),expanded:button.getAttribute('aria-expanded'),buttonLabel:button.getAttribute('aria-label'),regionRole:first.querySelector('[data-series-expansion]').getAttribute('role'),tabCount:tabs.length,selected:tabs.filter(tab=>tab.getAttribute('aria-selected')==='true').length,focusedRole:document.activeElement?.getAttribute('role'),linkBeforeButton:Boolean(order),status:first.querySelector('[data-map-scoreboard] [role=status]')?.textContent??''};
    })()`);
    const requestsAfter = requests.length;

    const widths = [];
    for (const width of VIEWPORT_WIDTHS) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: true });
      await client.send('Page.navigate', { url: `${origin}/` });
      await ready(client);
      const metrics = await evaluate(client, `(async()=>{const row=document.querySelector('[data-series-row]');row.querySelector('[data-series-expand]').click();for(let i=0;i<200&&!row.querySelector('[data-map-scoreboard][data-load-state=loaded]');i++)await new Promise(r=>setTimeout(r,25));const expansion=row.querySelector('[data-series-expansion]');return{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,expansionWidth:expansion.getBoundingClientRect().width,expansionScrollWidth:expansion.scrollWidth}})()`);
      widths.push({ width, ...metrics });
    }

    const noJavaScript = [];
    const noJs = await newTarget(chromePort);
    try {
      await noJs.send('Page.enable');
      await noJs.send('Runtime.enable');
      await noJs.send('Emulation.setScriptExecutionDisabled', { value: true });
      for (const view of ['default', 'all', 'top', 'pro', 'amateur', 'other']) {
        await noJs.send('Page.navigate', { url: `${origin}/#home-filter-${view}` });
        await ready(noJs);
        const count = await evaluate(noJs, `[...document.querySelectorAll('[data-series-row]')].filter(row=>getComputedStyle(row).display!=='none').length`);
        noJavaScript.push({ view, count });
      }
    } finally { noJs.close(); }
    return { interaction: { requestsBefore, requestsAfter, ...interaction }, widths, noJavaScript };
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
const clockText = argument('--clock');
const only = argument('--only');
if (!clockText || !Number.isFinite(new Date(clockText).getTime())) {
  console.error('usage: npm run audit:home-series -- --dist PATH --clock YYYY-MM-DDTHH:mm:ssZ');
  process.exit(2);
}
if (only) assert.ok(ASSERTION_NAMES.includes(only), `unknown assertion: ${only}`);
const endEpoch = Math.floor(new Date(clockText).getTime() / 1000);
const homeBuffer = await readFile(path.join(outputRoot, 'index.html'));
const homeHtml = homeBuffer.toString('utf8');
const emitted = emittedRows(homeHtml);

const [matchFiles, playerFiles] = await Promise.all([factFiles('matches'), factFiles('players')]);
const database = await DuckDBInstance.create(':memory:');
const connection = await database.connect();
let matches;
let players;
try {
  const rawMatches = await rows(connection, `SELECT * FROM (${directSource(matchFiles, 'matches')}) WHERE start_time<${endEpoch} ORDER BY start_time,match_id`);
  const uniqueMatches = new Map();
  for (const row of rawMatches) if (!uniqueMatches.has(row.match_id)) uniqueMatches.set(row.match_id, row);
  matches = [...uniqueMatches.values()];
  const selectedIds = directGroups(matches).slice(0, HOME_LIMIT).flatMap((group) => group.rows.map((row) => row.match_id));
  players = await rows(connection, `SELECT * FROM (${directSource(playerFiles, 'players')}) WHERE match_id IN (${selectedIds.join(',')})`);
} finally {
  connection.closeSync();
}
const expectedGroups = directGroups(matches).slice(0, HOME_LIMIT);
const sourceByMatch = new Map(matches.map((row) => [row.match_id, row]));
const expectedMapIds = expectedGroups.map((group) => group.rows.map((row) => row.match_id));
const emittedMapIds = emitted.map((group) => group.maps.map((map) => Number(map[0])));
const groupSignature = (ids) => ids.join(',');
const partitionSignature = (kind, ids) => JSON.stringify([
  kind,
  [...ids].sort((left, right) => left - right),
]);
const expectedPartition = expectedGroups
  .map((group) => partitionSignature(group.kind, group.rows.map((row) => row.match_id))).sort();
const emittedPartition = emitted
  .map((group) => partitionSignature(group.kind, group.maps.map((map) => Number(map[0])))).sort();
const expectedBySignature = new Map(expectedGroups.map((group) => [
  groupSignature(group.rows.map((row) => row.match_id)), group,
]));

const structuralValidity = emitted.every((group) => {
  const source = group.maps.map((map) => sourceByMatch.get(Number(map[0]))).filter(Boolean);
  const first = source[0];
  return source.length === group.maps.length
    && source.every((row) => row.series_id === first.series_id && row.leagueid === first.leagueid)
    && source.every((row) => samePair(pair(row), pair(first)))
    && source.slice(1).every((row, index) => row.start_time - source[index].start_time <= SIX_HOURS)
    && source.at(-1).start_time - first.start_time <= DAY_SECONDS;
});
const emittedSeriesSources = emitted.filter((group) => group.kind === 'series').map((group) => (
  group.maps.map((map) => sourceByMatch.get(Number(map[0])))
));
const noSeriesSentinelInSeries = emittedSeriesSources.every((source) => (
  source.length > 0 && source.every((row) => row && row.series_id !== null && row.series_id !== 0)
));
const noNullTeamInSeries = emittedSeriesSources.every((source) => (
  source.length > 0 && source.every((row) => (
    row && row.radiant_team_id !== null && row.dire_team_id !== null
  ))
));
const expectedStandaloneCount = expectedGroups.filter((group) => group.kind === 'standalone').length;
const emittedStandaloneCount = emitted.filter((group) => group.kind === 'standalone').length;
const zeroSeriesStandaloneGroup = emitted.find((group) => (
  group.kind === 'standalone'
  && group.maps.some((map) => sourceByMatch.get(Number(map[0]))?.series_id === 0)
));
const nullTeamStandaloneGroup = emitted.find((group) => (
  group.kind === 'standalone'
  && group.maps.some((map) => {
    const row = sourceByMatch.get(Number(map[0]));
    return row && (row.radiant_team_id === null || row.dire_team_id === null);
  })
));
function wrongSeriesExample(group) {
  if (!group) return null;
  const maps = group.maps.map((map) => Number(map[0]));
  const expected = directScore({ rows: maps.map((matchId) => sourceByMatch.get(matchId)) });
  return { maps, result: [expected.one, expected.two, expected.unknown] };
}
const zeroSeriesStandaloneExample = wrongSeriesExample(zeroSeriesStandaloneGroup);
const nullTeamStandaloneExample = wrongSeriesExample(nullTeamStandaloneGroup);
const scoreResults = emitted.map((actual) => {
  const group = expectedBySignature.get(groupSignature(actual.maps.map((map) => Number(map[0]))));
  return { actual, group, expected: group ? directScore(group) : null };
});
const scoreValidity = scoreResults.every(({ actual, group, expected }) => (
  group?.kind === 'standalone'
  || (expected && actual.scoreOne === expected.one && actual.scoreTwo === expected.two && actual.unknownMaps === expected.unknown)
));
const swappedResults = scoreResults.filter(({ expected }) => expected?.swapped);
const swappedMutationExample = swappedResults.map(({ actual, group, expected }) => ({
  maps: actual.maps.map((map) => Number(map[0])),
  teamScore: [expected.one, expected.two, expected.unknown],
  sideScore: Object.values(sideScore(group)),
})).find((entry) => JSON.stringify(entry.teamScore) !== JSON.stringify(entry.sideScore)) ?? null;

const playerArtifactRoot = path.join(outputRoot, 'data', 'home-players');
const playerFilesOut = (await readdir(playerArtifactRoot)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
const artifactRows = [];
const shardSizes = [];
let playerSchemaExact = true;
for (const name of playerFilesOut) {
  const buffer = await readFile(path.join(playerArtifactRoot, name));
  const payload = JSON.parse(buffer.toString('utf8'));
  shardSizes.push({ day: payload.day, raw: buffer.length, gzip: gzipSync(buffer, { level: 9 }).length });
  for (const row of payload.rows) {
    playerSchemaExact &&= JSON.stringify(Object.keys(row).sort()) === JSON.stringify(PLAYER_KEYS);
    artifactRows.push({ day: payload.day, row });
  }
}
const expectedDayByMatch = new Map(expectedGroups.flatMap((group) => {
  const day = new Date(group.rows.at(-1).start_time * 1000).toISOString().slice(0, 10);
  return group.rows.map((row) => [row.match_id, day]);
}));
const expectedDays = [...new Set(expectedDayByMatch.values())].sort();
const emittedDayPlacementValid = emitted.every((group) => group.maps.every((map) => (
  expectedDayByMatch.get(Number(map[0])) === group.day
)));
const expectedPlayerSignatures = players.map((row) => `${expectedDayByMatch.get(row.match_id)}:${rowSignature(row)}`).sort();
const artifactPlayerSignatures = artifactRows.map(({ day, row }) => `${day}:${rowSignature(row)}`).sort();

const activeStart = endEpoch - 14 * DAY_SECONDS;
const expectedActive = [...new Set(matches.filter((row) => (
  row.start_time >= activeStart && row.start_time < endEpoch && Number.isSafeInteger(row.leagueid)
)).map((row) => row.leagueid))].sort((a, b) => a - b);
const actualActive = [...homeHtml.matchAll(/<li\b[^>]*\bdata-active-league-id="(\d+)"[^>]*>/g)]
  .map((match) => Number(match[1])).sort((a, b) => a - b);

const buttons = [...homeHtml.matchAll(/<button\b[^>]*\bdata-home-view-option="([^"]+)"[^>]*>/g)];
const noScriptLinks = [...homeHtml.matchAll(/<a\b[^>]*href="#home-filter-([^"]+)"[^>]*>/g)];
const viewCounts = Object.fromEntries(buttons.map((match) => {
  const attrs = attributes(match[0]);
  return [match[1], Number(attrs.get('data-result-count'))];
}));

let browser = null;
if (!only || ['sixViewsAndApprovedDefaultWorkWithoutJavaScript', 'expansionIsLazyAndDayCached', 'expandersAndMapTabsAreAccessible', 'expandedScoreboardFitsEveryWidth'].includes(only)) {
  const chrome = CHROME_PATHS.find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } });
  assert.ok(chrome, 'Chrome or Edge is required for the Step 29 home-series gate');
  browser = await browserCheck(chrome, outputRoot);
}

const computed = {
  emittedRowsMatchIndependentGrouping: JSON.stringify(emittedMapIds.map(groupSignature).sort())
    === JSON.stringify(expectedMapIds.map(groupSignature).sort()),
  feedPartitionMatchesIndependentRecomputation: JSON.stringify(emittedPartition)
    === JSON.stringify(expectedPartition),
  noSeriesGroupContainsNoSeriesSentinel: noSeriesSentinelInSeries,
  noSeriesGroupContainsNullTeamId: noNullTeamInSeries,
  standaloneRowCountMatchesIndependentRecomputation: emittedStandaloneCount === expectedStandaloneCount,
  groupingKeyKeepsLeaguePairAndSpanValid: structuralValidity,
  seriesScoresCountWinsPerTeamId: scoreValidity,
  sideSwappedSeriesScoresCorrectly: swappedResults.length > 0 && swappedResults.every(({ actual, expected }) => (
    actual.scoreOne === expected.one && actual.scoreTwo === expected.two
  )),
  feedHasExactlyThreeHundredTypedRows: emitted.length === HOME_LIMIT
    && emitted.every((group) => group.kind === 'series' || group.kind === 'standalone'),
  standaloneRowsAreLabelledAndUnscored: emitted.filter((group) => group.kind === 'standalone').length > 0
    && emitted.filter((group) => group.kind === 'standalone').every((group) => (
      group.label === 'Single game' && group.scoreOne === null && group.scoreTwo === null && group.unknownMaps === null
    )),
  dayShardsContainEveryExpectedPlayerRow: JSON.stringify(playerFilesOut.map((name) => name.slice(0, -5))) === JSON.stringify(expectedDays)
    && JSON.stringify(artifactPlayerSignatures) === JSON.stringify(expectedPlayerSignatures)
    && emittedDayPlacementValid && playerSchemaExact && !homeHtml.includes('"account_id"'),
  sixViewsAndApprovedDefaultWorkWithoutJavaScript: buttons.length === 6
    && buttons[0][1] === 'default' && /aria-pressed="true"/.test(buttons[0][0])
    && /data-view-label="Top tier \+ Pro"/.test(buttons[0][0])
    && noScriptLinks.length === 6
    && browser?.noJavaScript.every(({ view, count }) => count === viewCounts[view]),
  activeTournamentsMatchIndependentFourteenDayScan: JSON.stringify(actualActive) === JSON.stringify(expectedActive),
  expansionIsLazyAndDayCached: browser?.interaction.requestsBefore === 0
    && browser.interaction.hasSecond && browser.interaction.requestsAfter === 1,
  expandersAndMapTabsAreAccessible: emitted.length > 0
    && [...homeHtml.matchAll(/<button\b[^>]*\bdata-series-expand(?:\s|>|=)[^>]*>/g)].length === emitted.length
    && [...homeHtml.matchAll(/<button\b[^>]*\bdata-series-expand(?:\s|>|=)[^>]*>/g)].every((match) => (
      /aria-expanded="false"/.test(match[0]) && /aria-controls="[^"]+"/.test(match[0])
      && /aria-label="Show maps for [^"]+ versus [^"]+"/.test(match[0]) && !/\btitle=/.test(match[0])
    ))
    && browser?.interaction.expanded === 'true'
    && /^Hide maps for .+ versus .+/.test(browser.interaction.buttonLabel)
    && browser.interaction.regionRole === 'region'
    && browser.interaction.tabCount > 1
    && browser.interaction.selected === 1
    && browser.interaction.focusedRole === 'tab'
    && browser.interaction.linkBeforeButton
    && /player rows loaded/.test(browser.interaction.status),
  expandedScoreboardFitsEveryWidth: browser?.widths.length === VIEWPORT_WIDTHS.length
    && browser.widths.every((entry, index) => entry.width === VIEWPORT_WIDTHS[index]
      && entry.scrollWidth === entry.clientWidth && entry.expansionScrollWidth <= Math.ceil(entry.expansionWidth)),
  homeGzipRemainsBounded: gzipSync(homeBuffer, { level: 9 }).length <= HOME_GZIP_LIMIT,
};
const assertions = Object.freeze(Object.fromEntries(ASSERTION_NAMES
  .filter((name) => !only || name === only).map((name) => [name, Boolean(computed[name])])));
const largestShard = shardSizes.sort((left, right) => right.raw - left.raw)[0] ?? null;
console.log(`STEP29_HOME_SERIES_AUDIT=${JSON.stringify({
  clock: clockText,
  rows: emitted.length,
  series: emitted.filter((row) => row.kind === 'series').length,
  standalone: emitted.filter((row) => row.kind === 'standalone').length,
  expectedStandalone: expectedStandaloneCount,
  zeroSeriesStandaloneExample,
  nullTeamStandaloneExample,
  sideSwappedSeries: swappedResults.length,
  swappedMutationExample,
  activeTournaments: actualActive.length,
  dayShards: playerFilesOut.length,
  largestShard,
  homeRawBytes: homeBuffer.length,
  homeGzipBytes: gzipSync(homeBuffer, { level: 9 }).length,
  browser,
})}`);
console.log(`STEP29_HOME_SERIES_ASSERTIONS=${JSON.stringify(assertions)}`);
const failures = Object.entries(assertions).filter(([, pass]) => !pass).map(([name]) => name);
assert.deepEqual(failures, [], `Step 29 home-series audit failed: ${failures.join(', ')}`);
console.log('STEP29_HOME_SERIES_STATUS=PASS');
