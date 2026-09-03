import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';

const run = promisify(execFile);
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const VIEWPORT_WIDTHS = Object.freeze([
  320, 360, 380, 414, 480, 600, 672, 700, 760, 900, 1280,
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
    try {
      const url = new URL(request.url, 'http://localhost');
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const candidate = path.resolve(root, relative.endsWith('/') ? `${relative}index.html` : relative);
      assert.ok(candidate === root || candidate.startsWith(`${root}${path.sep}`));
      const details = await stat(candidate);
      if (!details.isFile()) throw new Error('not a file');
      response.writeHead(200, { 'content-type': contentType(candidate) });
      if (relative === 'index.html' && url.searchParams.has('browser-metrics')) {
        const html = await readFile(candidate, 'utf8');
        const measurement = `<script>document.documentElement.dataset.step22Metrics=[innerWidth,document.documentElement.clientWidth,document.documentElement.scrollWidth,document.documentElement.scrollWidth>document.documentElement.clientWidth].join(',')</script>`;
        response.end(html.replace('</body>', `${measurement}</body>`));
      } else {
        createReadStream(candidate).pipe(response);
      }
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function chromeRun(chrome, scratch, args, name) {
  const profile = await mkdtemp(path.join(scratch, `${name}-`));
  try {
    return await run(chrome, [
      '--headless=new',
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-gpu',
      '--no-default-browser-check',
      '--no-first-run',
      '--force-color-profile=srgb',
      '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1',
      `--user-data-dir=${profile}`,
      ...args,
    ], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
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
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function newTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  assert.ok(response.ok, `could not create Chrome target: ${response.status}`);
  return new CdpClient((await response.json()).webSocketDebuggerUrl);
}

async function cdpViewports(chrome, scratch, url, widths) {
  const profile = await mkdtemp(path.join(scratch, 'cdp-'));
  const port = await freePort();
  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-gpu',
    '--no-default-browser-check',
    '--no-first-run',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  try {
    await waitForChrome(port);
    const results = [];
    for (const width of widths) {
      const client = await newTarget(port);
      try {
        await client.send('Page.enable');
        await client.send('Runtime.enable');
        await client.send('Network.enable');
        await client.send('Network.setBlockedURLs', { urls: ['https://*'] });
        await client.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: true,
        });
        const loaded = client.event('Page.loadEventFired');
        await client.send('Page.navigate', { url });
        await loaded;
        const evaluated = await client.send('Runtime.evaluate', {
          expression: `(() => {
            const row = document.querySelector('.match-row');
            const view = document.querySelector('.home-view:not([hidden])');
            const style = row ? getComputedStyle(row) : null;
            return {
              viewportWidth: innerWidth,
              clientWidth: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
              horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              homeViewWidth: view?.getBoundingClientRect().width ?? null,
              rowLayout: style?.gridTemplateAreas === 'none' ? 'columns' : 'stacked',
            };
          })()`,
          returnByValue: true,
        });
        results.push(Object.freeze({ requestedWidth: width, ...evaluated.result.value }));
      } finally {
        client.close();
      }
    }
    return results;
  } finally {
    if (browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function noJavaScriptResult(chrome, scratch, url, preference) {
  const screenshot = path.join(scratch, `no-js-${preference}.png`);
  await chromeRun(chrome, scratch, [
    '--disable-javascript',
    `--window-size=380,900`,
    `--screenshot=${screenshot}`,
    ...(preference === 'dark' ? ['--force-dark-mode'] : []),
    url,
  ], `no-js-${preference}`);
  const metadata = await sharp(screenshot).metadata();
  const pixel = await sharp(screenshot)
    .extract({ left: 0, top: 450, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  return Object.freeze({
    preference,
    javaScript: false,
    screenshotWidth: metadata.width,
    screenshotHeight: metadata.height,
    backgroundPixel: `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`,
  });
}

const outputRoot = path.resolve(argument('--dist') ?? 'dist');
assert.ok(await exists(path.join(outputRoot, 'index.html')), 'built index.html is missing');
const chrome = (await Promise.all(CHROME_PATHS.map(async (candidate) => (
  await exists(candidate) ? candidate : null
)))).find(Boolean);
assert.ok(chrome, 'Chrome or Edge is required for the home browser audit');

const scratch = await mkdtemp(path.join(tmpdir(), 'dotainfo-step22-browser-'));
assert.ok(path.resolve(scratch).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
const server = await staticServer(outputRoot);
const { port } = server.address();

try {
  const url = `http://127.0.0.1:${port}/`;
  const viewports = await cdpViewports(chrome, scratch, url, VIEWPORT_WIDTHS);
  const noJavaScript = [];
  for (const preference of ['light', 'dark']) {
    noJavaScript.push(await noJavaScriptResult(chrome, scratch, url, preference));
  }
  const homeHtml = await readFile(path.join(outputRoot, 'index.html'), 'utf8');
  const visibleWithoutJavaScript = [...homeHtml.matchAll(
    /<section\b[^>]*data-home-view="([^"]+)"[^>]*>/g,
  )].filter((match) => !/\shidden(?:\s|>|=)/.test(match[0])).map((match) => match[1]);

  const assertions = Object.freeze({
    everyRequestedWidthWasMeasured: viewports.length === VIEWPORT_WIDTHS.length
      && viewports.every((viewport, index) => viewport.requestedWidth === VIEWPORT_WIDTHS[index]),
    noHorizontalOverflowAcrossSweep: viewports.every((viewport) => (
      viewport.clientWidth === viewport.requestedWidth
      && viewport.scrollWidth === viewport.clientWidth
      && !viewport.horizontalOverflow
    )),
    noJavaScriptLeavesDefaultViewVisible: visibleWithoutJavaScript.length === 1
      && visibleWithoutJavaScript[0] === 'default',
    noJavaScriptHonorsBothPreferences: noJavaScript[0].backgroundPixel === 'rgb(246, 242, 234)'
      && noJavaScript[1].backgroundPixel === 'rgb(15, 17, 20)',
  });
  console.log(`STEP22_VIEWPORTS=${JSON.stringify(viewports)}`);
  console.log(`STEP22_NO_JAVASCRIPT=${JSON.stringify({ visibleViews: visibleWithoutJavaScript, renders: noJavaScript })}`);
  console.log(`STEP22_BROWSER_ASSERTIONS=${JSON.stringify(assertions)}`);
  assert.ok(Object.values(assertions).every(Boolean), 'Step 22 browser assertions failed');
  console.log('STEP22_BROWSER_STATUS=PASS');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
