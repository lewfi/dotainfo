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

function themePalette(css, theme) {
  const tokens = new Map();
  const themeSelector = new RegExp(`data-theme\\s*=\\s*['"]?${theme}['"]?`, 'i');
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!themeSelector.test(rule[1])) continue;
    for (const declaration of rule[2].matchAll(/(--color-[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;?/gi)) {
      tokens.set(declaration[1], declaration[2].toLowerCase());
    }
  }
  return tokens;
}

async function emittedCss(html, outputRoot) {
  const chunks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1]);
  const links = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => attributes(match[0]))
    .filter((link) => (link.get('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet'));
  for (const link of links) {
    const href = link.get('href') ?? '';
    const pathname = new URL(href, 'https://dotainfo.invalid/').pathname;
    const file = path.resolve(outputRoot, `.${decodeURIComponent(pathname)}`);
    assert.ok(
      file.startsWith(`${outputRoot}${path.sep}`),
      `emitted stylesheet escaped dist: ${href}`,
    );
    chunks.push(await readFile(file, 'utf8'));
  }
  assert.ok(chunks.length > 0, 'no emitted CSS found');
  return chunks.join('\n');
}

function themeBootstrapAudit(html) {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  const bootstrap = head.match(/<script\b([^>]*)data-theme-bootstrap([^>]*)>([\s\S]*?)<\/script>/i);
  const bootstrapTag = bootstrap ? `<script${bootstrap[1]}data-theme-bootstrap${bootstrap[2]}>` : '';
  const bootstrapAttributes = attributes(bootstrapTag);
  const bootstrapIndex = bootstrap ? head.indexOf(bootstrap[0]) : -1;
  const stylesheetIndex = head.search(/<link\b[^>]*\brel=["'][^"']*stylesheet/i);
  const source = bootstrap?.[3] ?? '';
  return Object.freeze({
    blockingInlineScript: bootstrapIndex >= 0
      && !bootstrapAttributes.has('src')
      && !bootstrapAttributes.has('async')
      && !bootstrapAttributes.has('defer')
      && (bootstrapAttributes.get('type') ?? '').toLowerCase() !== 'module',
    beforeFirstStylesheet: bootstrapIndex >= 0
      && stylesheetIndex >= 0
      && bootstrapIndex < stylesheetIndex,
    readsPersistentChoice: /localStorage\.getItem\(storageKey\)/.test(source),
    fallsBackToColorScheme: /prefers-color-scheme:\s*dark/.test(source),
    setsHtmlThemeSynchronously: /document\.documentElement\.dataset\.theme\s*=\s*theme/.test(source),
  });
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

const themeButtons = [...homeHtml.matchAll(
  /<button\b[^>]*\bdata-theme-option=["'](light|dark)["'][^>]*>/gi,
)];
const themeButtonValues = new Set(themeButtons.map((match) => match[1].toLowerCase()));
const themeControlScript = homeHtml.match(
  /<script\b[^>]*data-theme-controls[^>]*>([\s\S]*?)<\/script>/i,
)?.[1] ?? '';
const themeControlAssertions = Object.freeze({
  hasLightAndDarkButtons: themeButtonValues.size === 2
    && themeButtonValues.has('light')
    && themeButtonValues.has('dark'),
  nativeKeyboardButtons: themeButtons.every((match) => {
    const button = attributes(match[0]);
    return (button.get('type') ?? '').toLowerCase() === 'button'
      && !button.has('disabled')
      && button.get('tabindex') !== '-1';
  }),
  selectedStateInMarkup: themeButtons.every(
    (match) => attributes(match[0]).has('aria-pressed'),
  ),
  visibleSelectedIndicator: /theme-option-check/i.test(homeHtml),
  persistsExplicitChoice: /localStorage\.setItem\(storageKey, theme\)/.test(themeControlScript),
  followsPreferenceWithoutChoice: /if\s*\(!storedTheme\(\)\)/.test(themeControlScript),
  availableOn404: /data-theme-option=["']light["']/i.test(notFoundHtml)
    && /data-theme-option=["']dark["']/i.test(notFoundHtml)
    && /data-theme-controls/i.test(notFoundHtml),
});

const themeBootstrapResults = [];
for (const file of pages) {
  themeBootstrapResults.push(Object.freeze({
    path: path.relative(process.cwd(), file).replaceAll('\\', '/'),
    assertions: themeBootstrapAudit(await readFile(file, 'utf8')),
  }));
}
const themeBootstrapFailures = themeBootstrapResults.filter(
  (page) => !Object.values(page.assertions).every(Boolean),
);

const css = await emittedCss(homeHtml, outputRoot);
const requiredThemeTokens = new Set(
  CONTRAST_PAIRS.flatMap(([, foreground, background]) => [foreground, background]),
);
const themeContrasts = ['light', 'dark'].map((theme) => {
  const tokens = themePalette(css, theme);
  for (const token of requiredThemeTokens) {
    assert.ok(tokens.has(token), `missing ${theme} palette token ${token}`);
  }
  const pairs = CONTRAST_PAIRS.map(([name, foreground, background, minimum]) => {
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
  const tightest = pairs.reduce((current, entry) => (
    entry.ratio < current.ratio ? entry : current
  ));
  return Object.freeze({
    theme,
    tokens: Object.fromEntries(tokens),
    pairs,
    tightest,
  });
});

const assertions = Object.freeze({
  everyPagePassesStructure: pageFailures.length === 0,
  titlesAreUnique: duplicateTitles.length === 0,
  everyInternalPageLinkUsesTrailingSlash: pageResults.every(
    (page) => page.assertions.internalPageLinksUseTrailingSlash,
  ),
  tierControlIsKeyboardAndAtAccessible: Object.values(tierAssertions).every(Boolean),
  themeControlIsKeyboardAndAccessible: Object.values(themeControlAssertions).every(Boolean),
  themeIsAppliedBeforeFirstPaint: themeBootstrapFailures.length === 0,
  notFoundIsRendered: Object.values(notFoundAssertions).every(Boolean),
  everyContrastPairPasses: themeContrasts.every(
    ({ pairs }) => pairs.every((entry) => entry.pass),
  ),
});

console.log(`STEP16_HTML=${JSON.stringify({
  pages: pages.length,
  pageFailures: pageFailures.map((page) => ({ path: page.relative, assertions: page.assertions })),
  duplicateTitles,
})}`);
console.log(`STEP16_TIER_CONTROL=${JSON.stringify(tierAssertions)}`);
console.log(`STEP16_NOT_FOUND=${JSON.stringify(notFoundAssertions)}`);
console.log(`STEP18_THEME_CONTROL=${JSON.stringify(themeControlAssertions)}`);
console.log(`STEP18_THEME_BOOTSTRAP=${JSON.stringify({
  pages: themeBootstrapResults.length,
  failures: themeBootstrapFailures,
})}`);
console.log(`STEP18_CONTRAST=${JSON.stringify(themeContrasts)}`);
console.log(`STEP16_ASSERTIONS=${JSON.stringify(assertions)}`);
assert.ok(Object.values(assertions).every(Boolean), 'Step 16 accessibility assertions failed');
console.log('STEP16_ACCESSIBILITY_STATUS=PASS');
