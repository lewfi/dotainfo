import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const CONTRAST_PAIRS = Object.freeze([
  ['text_on_background', '--color-text', '--color-bg', 4.5],
  ['text_on_surface', '--color-text', '--color-surface', 4.5],
  ['text_on_raised_surface', '--color-text', '--color-surface-raised', 4.5],
  ['muted_on_background', '--color-muted', '--color-bg', 4.5],
  ['muted_on_surface', '--color-muted', '--color-surface', 4.5],
  ['accent_on_background', '--color-accent', '--color-bg', 4.5],
  ['winner_on_surface', '--color-winner', '--color-surface', 4.5],
  ['error_on_background', '--color-error', '--color-bg', 4.5],
  ['border_against_background', '--color-border', '--color-bg', 3],
  ['border_against_surface', '--color-border', '--color-surface', 3],
  ['focus_against_background', '--color-focus', '--color-bg', 3],
  ['focus_against_surface', '--color-focus', '--color-surface', 3],
  ['focus_against_raised_surface', '--color-focus', '--color-surface-raised', 3],
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function htmlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(entryPath));
    else if (entry.name.endsWith('.html')) files.push(entryPath);
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

function decodeText(value) {
  return value
    .replaceAll(/<[^>]*>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function idExists(html, id) {
  const escaped = id.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bid=["']${escaped}["']`).test(html);
}

function pageAudit(file, html) {
  const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
  const lang = attributes(htmlTag).get('lang')?.trim() ?? '';
  const title = decodeText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const metaTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const description = metaTags.find((meta) => meta.get('name')?.toLowerCase() === 'description')
    ?.get('content')?.trim() ?? '';
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((match) => Number(match[1]));
  const skippedHeading = headings.some(
    (level, index) => index > 0 && level > headings[index - 1] + 1,
  );
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const badLinks = anchors.filter((match) => {
    const attrs = attributes(`<a ${match[1]}>`);
    const text = decodeText(match[2]) || attrs.get('aria-label')?.trim() || '';
    return text.length === 0 || /^click here$/i.test(text);
  });
  const internalPageLinks = anchors
    .map((match) => attributes(`<a ${match[1]}>`).get('href') ?? '')
    .filter((href) => href.startsWith('/') && !href.startsWith('/data/'));

  return {
    relative,
    title,
    assertions: {
      lang: lang.length > 0,
      title: title.length > 0,
      description: description.length > 0,
      exactlyOneH1: headings.filter((level) => level === 1).length === 1,
      headingsStartAtH1: headings[0] === 1,
      noSkippedHeadingLevels: !skippedHeading,
      everyImageHasAlt: images.every((image) => image.has('alt')),
      everyLinkHasDiscernibleText: badLinks.length === 0,
      internalPageLinksUseTrailingSlash: internalPageLinks.every((href) => href.endsWith('/')),
      mainLandmark: /<main\b[^>]*>/i.test(html),
      navigationLandmark: /<nav\b[^>]*>/i.test(html),
    },
  };
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16));
  return 0.2126 * channel(channels[0])
    + 0.7152 * channel(channels[1])
    + 0.0722 * channel(channels[2]);
}

function contrastRatio(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function palette(css) {
  const tokens = new Map();
  for (const match of css.matchAll(/(--color-[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)) {
    tokens.set(match[1], match[2].toLowerCase());
  }
  return tokens;
}

const distArgument = argument('--dist');
if (!distArgument) {
  console.error('usage: npm run audit:a11y -- --dist PATH');
  process.exit(2);
}

const outputRoot = path.resolve(distArgument);
const pages = await htmlFiles(outputRoot);
const pageResults = [];
for (const file of pages) pageResults.push(pageAudit(file, await readFile(file, 'utf8')));
const titleCounts = new Map();
for (const page of pageResults) titleCounts.set(page.title, (titleCounts.get(page.title) ?? 0) + 1);
const duplicateTitles = [...titleCounts].filter(([, count]) => count > 1).map(([title]) => title);
const pageFailures = pageResults.filter(
  (page) => !Object.values(page.assertions).every(Boolean),
);

const homeHtml = await readFile(path.join(outputRoot, 'index.html'), 'utf8');
const selectTag = homeHtml.match(/<select\b[^>]*data-home-view-select[^>]*>/i)?.[0] ?? '';
const select = attributes(selectTag);
const describedBy = (select.get('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
const controlled = (select.get('aria-controls') ?? '').split(/\s+/).filter(Boolean);
const homeMatchCards = [...homeHtml.matchAll(/<li\b[^>]*>/gi)]
  .filter((match) => (attributes(match[0]).get('class') ?? '').split(/\s+/).includes('match-card'));
const homeMatchLinks = [...homeHtml.matchAll(/<a\b[^>]*>/gi)]
  .filter((match) => /^\/matches\/\d+\/$/.test(attributes(match[0]).get('href') ?? ''));
const tierAssertions = Object.freeze({
  nativeKeyboardControl: selectTag.startsWith('<select')
    && !select.has('disabled')
    && select.get('tabindex') !== '-1',
  associatedLabel: new RegExp(`<label\\b[^>]*for=["']${select.get('id')}["']`, 'i').test(homeHtml),
  selectedStateInMarkup: /<option\b[^>]*\bselected(?:\s|>|=)/i.test(homeHtml),
  currentStateDescribed: describedBy.length >= 1
    && describedBy.every((id) => idExists(homeHtml, id))
    && /role=["']status["']/i.test(homeHtml),
  controlsReferenceViews: controlled.length > 0 && controlled.every((id) => idExists(homeHtml, id)),
  stateNotColorOnly: /Current view:/i.test(homeHtml) && /matches hidden/i.test(homeHtml),
  everyMatchCardLinksToItsCanonicalRoute: homeMatchCards.length > 0
    && homeMatchLinks.length === homeMatchCards.length,
});

const notFoundHtml = await readFile(path.join(outputRoot, '404.html'), 'utf8');
const notFoundAssertions = Object.freeze({
  renderedNotFoundState: /data-route-state=["']not-found["']/i.test(notFoundHtml),
  renderedNotFoundHeading: /<h1\b[^>]*>\s*Page not found\s*<\/h1>/i.test(notFoundHtml),
  renderedNotFoundMessage: /The requested page does not exist\./i.test(notFoundHtml),
});

const css = await readFile(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const tokens = palette(css);
const contrasts = CONTRAST_PAIRS.map(([name, foreground, background, minimum]) => {
  assert.ok(tokens.has(foreground), `missing palette token ${foreground}`);
  assert.ok(tokens.has(background), `missing palette token ${background}`);
  const ratio = contrastRatio(tokens.get(foreground), tokens.get(background));
  return Object.freeze({
    name,
    foreground: tokens.get(foreground),
    background: tokens.get(background),
    ratio: Number(ratio.toFixed(3)),
    minimum,
    pass: ratio >= minimum,
  });
});

const assertions = Object.freeze({
  everyPagePassesStructure: pageFailures.length === 0,
  titlesAreUnique: duplicateTitles.length === 0,
  everyInternalPageLinkUsesTrailingSlash: pageResults.every(
    (page) => page.assertions.internalPageLinksUseTrailingSlash,
  ),
  tierControlIsKeyboardAndAtAccessible: Object.values(tierAssertions).every(Boolean),
  notFoundIsRendered: Object.values(notFoundAssertions).every(Boolean),
  everyContrastPairPasses: contrasts.every((entry) => entry.pass),
});

console.log(`STEP16_HTML=${JSON.stringify({
  pages: pages.length,
  pageFailures: pageFailures.map((page) => ({ path: page.relative, assertions: page.assertions })),
  duplicateTitles,
})}`);
console.log(`STEP16_TIER_CONTROL=${JSON.stringify(tierAssertions)}`);
console.log(`STEP16_NOT_FOUND=${JSON.stringify(notFoundAssertions)}`);
console.log(`STEP16_CONTRAST=${JSON.stringify(contrasts)}`);
console.log(`STEP16_ASSERTIONS=${JSON.stringify(assertions)}`);
assert.ok(Object.values(assertions).every(Boolean), 'Step 16 accessibility assertions failed');
console.log('STEP16_ACCESSIBILITY_STATUS=PASS');
