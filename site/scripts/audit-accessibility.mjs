import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SHARED_TOKENS = Object.freeze({
  '--sans': '-apple-system, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif',
  '--mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
});
const THEME_TOKENS = Object.freeze([
  '--bg', '--surface', '--surface-2', '--line', '--line-strong',
  '--fg', '--fg-2', '--fg-3', '--accent-a', '--accent-b',
  '--win-bg', '--win-fg', '--focus',
]);
const TEXT_FOREGROUNDS = Object.freeze([
  ['fg', '--fg'],
  ['fg_2', '--fg-2'],
  ['fg_3', '--fg-3'],
  ['accent_a', '--accent-a'],
  ['accent_b', '--accent-b'],
]);
const TEXT_BACKGROUNDS = Object.freeze([
  ['bg', '--bg'],
  ['surface', '--surface'],
  ['surface_2', '--surface-2'],
]);
const TEXT_PAIRS = Object.freeze([
  ...TEXT_FOREGROUNDS.flatMap(([foregroundName, foreground]) => (
    TEXT_BACKGROUNDS.map(([backgroundName, background]) => (
      [`${foregroundName}_on_${backgroundName}`, foreground, background, 4.5, 'text']
    ))
  )),
  ['win_fg_on_win_bg', '--win-fg', '--win-bg', 4.5, 'text'],
]);
const STRUCTURAL_BORDER_PAIRS = Object.freeze([
  ['line_strong_against_bg', '--line-strong', '--bg', 3, 'structural-border'],
  ['line_strong_against_surface', '--line-strong', '--surface', 3, 'structural-border'],
]);
const FOCUS_PAIRS = Object.freeze([
  ['focus_against_bg', '--focus', '--bg', 3, 'focus'],
  ['focus_against_surface', '--focus', '--surface', 3, 'focus'],
  ['focus_against_surface_2', '--focus', '--surface-2', 3, 'focus'],
]);
const REFERENCE_LINE_TOKENS = Object.freeze({
  light: '#a89c88',
  dark: '#4a535d',
});
const CONTRAST_PAIRS = Object.freeze([
  ...TEXT_PAIRS,
  ...STRUCTURAL_BORDER_PAIRS,
  ...FOCUS_PAIRS,
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

function cssRules(css) {
  const rules = [];

  function walk(source, media = []) {
    let cursor = 0;
    while (cursor < source.length) {
      const open = source.indexOf('{', cursor);
      if (open === -1) break;

      let prelude = source.slice(cursor, open).trim();
      const atRuleEnd = prelude.lastIndexOf(';');
      if (atRuleEnd !== -1) prelude = prelude.slice(atRuleEnd + 1).trim();

      let depth = 1;
      let close = open + 1;
      while (close < source.length && depth > 0) {
        if (source[close] === '{') depth += 1;
        else if (source[close] === '}') depth -= 1;
        close += 1;
      }
      assert.equal(depth, 0, `unclosed emitted CSS rule: ${prelude}`);

      const body = source.slice(open + 1, close - 1);
      if (/^@media\b/i.test(prelude)) {
        walk(body, [...media, prelude.replace(/^@media\s*/i, '')]);
      } else if (prelude.startsWith('@')) {
        walk(body, media);
      } else {
        rules.push(Object.freeze({ selector: prelude, body, media }));
      }
      cursor = close;
    }
  }

  walk(css.replaceAll(/\/\*[\s\S]*?\*\//g, ''));
  return rules;
}

function declarations(body) {
  const tokens = new Map();
  for (const declaration of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;?/gi)) {
    tokens.set(declaration[1], declaration[2].toLowerCase());
  }
  return tokens;
}

function customProperties(body) {
  const tokens = new Map();
  for (const declaration of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)\s*;?/gi)) {
    tokens.set(declaration[1], declaration[2].trim().replaceAll(/\s+/g, ' '));
  }
  return tokens;
}

function selectorIncludes(selector, expected) {
  return selector.split(',').some((part) => part.trim() === expected);
}

function selectorIncludesTheme(selector, theme) {
  const themeSelector = new RegExp(
    `^:root\\[data-theme\\s*=\\s*(?:['"]${theme}['"]|${theme})\\]$`,
    'i',
  );
  return selector.split(',').some((part) => themeSelector.test(part.trim()));
}

function paletteFromRules(rules, applies) {
  const tokens = new Map();
  for (const rule of rules) {
    if (!applies(rule)) continue;
    for (const [token, value] of declarations(rule.body)) tokens.set(token, value);
  }
  return tokens;
}

function themePalette(rules, theme) {
  return paletteFromRules(rules, (rule) => (
    rule.media.length === 0
    && selectorIncludesTheme(rule.selector, theme)
  ));
}

function noAttributePalette(rules, prefersDark) {
  return paletteFromRules(rules, (rule) => {
    if (!selectorIncludes(rule.selector, ':root')) return false;
    if (rule.media.length === 0) return true;
    return prefersDark && rule.media.every(
      (condition) => /prefers-color-scheme\s*:\s*dark/i.test(condition),
    );
  });
}

function darkPreferenceOverrides(rules) {
  return paletteFromRules(rules, (rule) => (
    selectorIncludes(rule.selector, ':root')
    && rule.media.length > 0
    && rule.media.every((condition) => /prefers-color-scheme\s*:\s*dark/i.test(condition))
  ));
}

function palettesEqual(left, right, requiredTokens) {
  return [...requiredTokens].every((token) => left.get(token) === right.get(token));
}

function plainRootProperties(rules) {
  const tokens = new Map();
  for (const rule of rules) {
    if (rule.media.length > 0 || !selectorIncludes(rule.selector, ':root')) continue;
    for (const [token, value] of customProperties(rule.body)) tokens.set(token, value);
  }
  return tokens;
}

function borderUses(body, token) {
  const escaped = token.replaceAll('-', '\\-');
  return new RegExp(
    `\\bborder(?:-[\\w-]+)?\\s*:[^;{}]*var\\(\\s*${escaped}\\s*\\)`,
    'i',
  ).test(body);
}

function selectorParts(selector) {
  return selector.split(',').map((part) => part.trim()).filter(Boolean);
}

function decorativeLineAudit(rules) {
  const structuralSelectors = new Set();
  for (const rule of rules) {
    if (!borderUses(rule.body, '--line-strong')) continue;
    for (const selector of selectorParts(rule.selector)) structuralSelectors.add(selector);
  }

  const uses = [];
  const violations = [];
  for (const rule of rules) {
    if (!borderUses(rule.body, '--line')) continue;
    for (const selector of selectorParts(rule.selector)) {
      const structuralAncestor = [...structuralSelectors]
        .filter((candidate) => selector.startsWith(`${candidate} `))
        .sort((left, right) => right.length - left.length)[0] ?? null;
      const result = Object.freeze({ selector, structuralAncestor });
      uses.push(result);
      if (!structuralAncestor) violations.push(result);
    }
  }
  return Object.freeze({
    assertion: 'Every CSS border using --line must target a descendant selector of a separately declared ancestor whose border uses --line-strong.',
    structuralSelectors: [...structuralSelectors].sort(),
    decorativeUses: uses,
    violations,
    pass: uses.length > 0 && violations.length === 0,
  });
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
const tierGroupTag = homeHtml.match(/<div\b[^>]*class=["'][^"']*tier-options[^"']*["'][^>]*>/i)?.[0] ?? '';
const tierGroup = attributes(tierGroupTag);
const describedBy = (tierGroup.get('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
const tierButtons = [...homeHtml.matchAll(/<button\b[^>]*data-home-view-option=["'][^"']+["'][^>]*>/gi)];
const tierButtonAttributes = tierButtons.map((match) => attributes(match[0]));
const controlled = tierButtonAttributes.map((button) => button.get('aria-controls') ?? '');
const homeMatchCards = [...homeHtml.matchAll(/<li\b[^>]*>/gi)]
  .filter((match) => (attributes(match[0]).get('class') ?? '').split(/\s+/).includes('match-card'));
const homeMatchLinks = [...homeHtml.matchAll(/<a\b[^>]*>/gi)]
  .filter((match) => /^\/matches\/\d+\/$/.test(attributes(match[0]).get('href') ?? ''));
const homeTeamLogos = [...homeHtml.matchAll(/<img\b[^>]*data-team-logo[^>]*>/gi)]
  .map((match) => attributes(match[0]));
const tierViewIds = new Set(tierButtonAttributes.map((button) => button.get('data-home-view-option')));
const tierAssertions = Object.freeze({
  nativeKeyboardControl: tierButtons.length === 5
    && tierButtonAttributes.every((button) => (
      (button.get('type') ?? '').toLowerCase() === 'button'
      && !button.has('disabled')
      && button.get('tabindex') !== '-1'
    )),
  associatedLabel: tierGroup.get('role') === 'group'
    && (tierGroup.get('aria-label') ?? '').trim().length > 0,
  selectedStateInMarkup: tierButtonAttributes.filter(
    (button) => button.get('aria-pressed') === 'true',
  ).length === 1 && tierButtonAttributes.every((button) => button.has('aria-pressed')),
  currentStateDescribed: describedBy.length >= 1
    && describedBy.every((id) => idExists(homeHtml, id))
    && /role=["']status["']/i.test(homeHtml),
  controlsReferenceViews: controlled.length === 5 && controlled.every((id) => idExists(homeHtml, id)),
  openTierDomainMapsToOther: ['all', 'top', 'pro', 'amateur', 'other'].every(
    (id) => tierViewIds.has(id),
  ),
  categoryHintsAreVisible: /Top tier<\/strong>\s*=\s*Flagship events/i.test(homeHtml)
    && /Other<\/strong>\s*=\s*Unclassified, excluded/i.test(homeHtml),
  stateNotColorOnly: /Current view:/i.test(homeHtml) && /matches hidden/i.test(homeHtml),
  everyMatchCardLinksToItsCanonicalRoute: homeMatchCards.length > 0
    && homeMatchLinks.length === homeMatchCards.length,
  everyWholeRowLinkNamesItsMatch: homeMatchLinks.every((match) => {
    const link = attributes(match[0]);
    return (link.get('class') ?? '').split(/\s+/).includes('match-row')
      && (link.get('aria-label') ?? '').includes('view match details');
  }),
  everyTeamLogoIsStableAndAccessible: homeTeamLogos.length > 0
    && homeTeamLogos.every((logo) => (
      logo.get('width') === '30'
      && logo.get('height') === '30'
      && (logo.get('alt') ?? '').trim().length > 0
      && logo.get('loading') === 'lazy'
    )),
  monogramFallbacksArePresent: /class=["']team-mark["'][^>]*data-monogram=["'][^"']+["'][^>]*role=["']img["']/i.test(homeHtml),
  realDayAndLeagueHeadings: /<h3\b[^>]*>[^<]*(?:<span[^>]*>[^<]+<\/span>)/i.test(homeHtml)
    && /<h4\b[^>]*>[^<]+<\/h4>/i.test(homeHtml),
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
const rules = cssRules(css);
const requiredThemeTokens = new Set(THEME_TOKENS);
const plainRootTokens = plainRootProperties(rules);
const sharedTokenAssertions = Object.freeze(Object.fromEntries(
  Object.entries(SHARED_TOKENS).map(([token, expected]) => [
    token.slice(2).replaceAll('-', '_'),
    plainRootTokens.get(token) === expected,
  ]),
));
const explicitPalettes = new Map(['light', 'dark'].map((theme) => {
  const tokens = themePalette(rules, theme);
  for (const token of requiredThemeTokens) {
    assert.ok(tokens.has(token), `missing ${theme} palette token ${token}`);
  }
  assert.equal(tokens.size, requiredThemeTokens.size, `unexpected token in ${theme} palette`);
  return [theme, tokens];
}));
const noAttributeDefault = noAttributePalette(rules, false);
const noAttributeDark = noAttributePalette(rules, true);
const darkOverrides = darkPreferenceOverrides(rules);
const noAttributePalettes = new Map([
  ['light', noAttributeDefault],
  ['dark', noAttributeDark],
]);
const themeContrasts = [...noAttributePalettes].map(([theme, tokens]) => {
  for (const token of requiredThemeTokens) {
    assert.ok(tokens.has(token), `missing no-attribute ${theme} palette token ${token}`);
  }
  const pairs = CONTRAST_PAIRS.map(([name, foreground, background, minimum, kind]) => {
    const ratio = contrastRatio(tokens.get(foreground), tokens.get(background));
    return Object.freeze({
      name,
      kind,
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
const referenceLineContrasts = themeContrasts.map(({ theme, tokens }) => {
  const foreground = REFERENCE_LINE_TOKENS[theme];
  const background = tokens['--surface'];
  const ratio = contrastRatio(foreground, background);
  return Object.freeze({
    theme,
    foreground,
    background,
    ratio: Number(ratio.toFixed(3)),
    minimum: 3,
    pass: ratio >= 3,
  });
});

const hasEveryToken = (tokens) => [...requiredThemeTokens].every((token) => tokens.has(token));
const legacyTokenPattern = new RegExp(`--${'color'}-[\\w-]+`, 'gi');
const legacyTokens = [...new Set([...css.matchAll(legacyTokenPattern)].map((match) => match[0]))]
  .sort();
const decorativeLines = decorativeLineAudit(rules);
const noJavaScriptThemeAssertions = Object.freeze({
  plainRootDeclaresBothSharedTokens: Object.values(sharedTokenAssertions).every(Boolean),
  defaultDeclaresEveryTokenOnPlainRoot: hasEveryToken(noAttributeDefault),
  darkPreferenceOverridesEveryTokenOnPlainRoot: hasEveryToken(darkOverrides),
  darkPreferenceResolvesEveryToken: hasEveryToken(noAttributeDark),
  defaultMatchesExplicitLight: palettesEqual(
    noAttributeDefault,
    explicitPalettes.get('light'),
    requiredThemeTokens,
  ),
  darkPreferenceMatchesExplicitDark: palettesEqual(
    noAttributeDark,
    explicitPalettes.get('dark'),
    requiredThemeTokens,
  ),
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
  colorsResolveWithoutJavaScript: Object.values(noJavaScriptThemeAssertions).every(Boolean),
  notFoundIsRendered: Object.values(notFoundAssertions).every(Boolean),
  emittedCssHasNoLegacyColorTokens: legacyTokens.length === 0,
  referenceLineValuesFailStructuralThreshold: referenceLineContrasts.every(
    (entry) => !entry.pass,
  ),
  everyContrastPairPasses: themeContrasts.every(
    ({ pairs }) => pairs.every((entry) => entry.pass),
  ),
  decorativeLinesStayInsideStructurallyBoundedComponents: decorativeLines.pass,
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
console.log(`STEP18_NO_JS_CASCADE=${JSON.stringify({
  assertions: noJavaScriptThemeAssertions,
  sharedTokens: Object.fromEntries(
    Object.keys(SHARED_TOKENS).map((token) => [token, plainRootTokens.get(token)]),
  ),
  defaultTokens: Object.fromEntries(noAttributeDefault),
  darkPreferenceTokens: Object.fromEntries(noAttributeDark),
})}`);
console.log(`STEP21_TOKEN_MIGRATION=${JSON.stringify({
  requiredSharedTokens: Object.keys(SHARED_TOKENS),
  requiredThemeTokens: THEME_TOKENS,
  legacyTokens,
})}`);
console.log(`STEP21_BORDER_RULE=${JSON.stringify(decorativeLines)}`);
console.log(`STEP21_REFERENCE_LINE_CONTRAST=${JSON.stringify(referenceLineContrasts)}`);
console.log(`STEP21_CONTRAST=${JSON.stringify(themeContrasts)}`);
console.log(`STEP16_ASSERTIONS=${JSON.stringify(assertions)}`);
assert.ok(Object.values(assertions).every(Boolean), 'Step 16 accessibility assertions failed');
console.log('STEP16_ACCESSIBILITY_STATUS=PASS');
