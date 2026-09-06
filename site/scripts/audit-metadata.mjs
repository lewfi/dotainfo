import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SITE_ORIGIN = 'https://dotainfo.pages.dev';
const SITE_TITLE_SUFFIX = ' — DotaInfo';

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--dist' || !argv[1]) {
    throw new Error('usage: node scripts/audit-metadata.mjs --dist DIST');
  }
  return path.resolve(argv[1]);
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(entryPath));
    else files.push(entryPath);
  }
  return files;
}

function decodeEntities(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([\da-f]+);/gi, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)));
}

function attributes(tag) {
  const result = new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    result.set(name, decodeEntities(value));
  }
  return result;
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi'))]
    .map((match) => attributes(match[0]));
}

function metadataValues(html, attributeName, attributeValue) {
  return tags(html, 'meta')
    .filter((tag) => tag.get(attributeName) === attributeValue)
    .map((tag) => tag.get('content') ?? '');
}

function canonicalValues(html) {
  return tags(html, 'link')
    .filter((tag) => (tag.get('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'))
    .map((tag) => tag.get('href') ?? '');
}

function elementTextValues(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi'))]
    .map((match) => decodeEntities(match[1].replace(/<[^>]*>/g, '').trim()));
}

function jsonLdValues(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => attributes(`<script${match[1]}>`).get('type') === 'application/ld+json')
    .map((match) => match[2].trim());
}

function pairedElements(html, name) {
  const pattern = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}>`, 'gi');
  return [...html.matchAll(pattern)].map((match) => Object.freeze({
    attributes: attributes(`<${name}${match[1]}>`),
    html: match[2],
  }));
}

function visibleBreadcrumbs(html) {
  return pairedElements(html, 'nav')
    .filter((nav) => nav.attributes.get('aria-label') === 'Breadcrumb')
    .map((nav) => {
      const lists = pairedElements(nav.html, 'ol');
      const items = lists.length === 1
        ? pairedElements(lists[0].html, 'li').map((item) => {
          const links = pairedElements(item.html, 'a');
          return Object.freeze({
            name: decodeEntities(item.html.replace(/<[^>]*>/g, '').trim()),
            href: links.length === 1 ? links[0].attributes.get('href') ?? '' : null,
            linkCount: links.length,
          });
        })
        : [];
      return Object.freeze({ listCount: lists.length, items: Object.freeze(items) });
    });
}

function titleStem(html, kind) {
  const marker = tags(html, 'article').find((tag) => (
    kind === 'team' ? tag.has('data-team-page') : tag.has('data-tournament-page')
  ));
  return marker?.get('data-title-stem') ?? null;
}

function routeKind(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, '/');
  const match = /^matches\/(\d+)\/index\.html$/.exec(normalized);
  if (match) return Object.freeze({ kind: 'match', id: match[1] });
  const team = /^teams\/(\d+)(?:\/(\d+))?\/index\.html$/.exec(normalized);
  if (team) return Object.freeze({ kind: 'team', id: team[1], page: Number(team[2] ?? 1) });
  const tournament = /^tournaments\/(\d+)(?:\/(\d+))?\/index\.html$/.exec(normalized);
  if (tournament) {
    return Object.freeze({ kind: 'tournament', id: tournament[1], page: Number(tournament[2] ?? 1) });
  }
  const hero = /^heroes\/(\d+)\/index\.html$/.exec(normalized);
  if (hero) return Object.freeze({ kind: 'hero', id: hero[1] });
  return Object.freeze({ kind: 'other' });
}

function routePath(relativePath) {
  const normalized = relativePath.replaceAll(path.sep, '/');
  if (normalized === 'index.html') return '/';
  if (normalized.endsWith('/index.html')) {
    return `/${normalized.slice(0, -'index.html'.length)}`;
  }
  if (normalized.endsWith('.html')) {
    return `/${normalized.slice(0, -'.html'.length)}/`;
  }
  throw new Error(`cannot derive route from ${relativePath}`);
}

function describeList(values) {
  const shown = values.slice(0, 5).join(', ');
  return values.length > 5 ? `${shown}, and ${values.length - 5} more` : shown;
}

function assertSetEquality(errors, label, expected, actual) {
  const missing = [...expected].filter((value) => !actual.has(value)).sort();
  const unexpected = [...actual].filter((value) => !expected.has(value)).sort();
  if (missing.length > 0) errors.push(`${label} is missing route(s): ${describeList(missing)}`);
  if (unexpected.length > 0) errors.push(`${label} has unexpected route(s): ${describeList(unexpected)}`);
}

async function main() {
  const dist = parseArguments(process.argv.slice(2));
  const allFiles = await filesUnder(dist);
  const htmlFiles = allFiles
    .filter((file) => file.toLowerCase().endsWith('.html'))
    .sort((left, right) => left.localeCompare(right));
  const emittedPageUrls = new Set(htmlFiles.map((file) => new URL(
    routePath(path.relative(dist, file)),
    SITE_ORIGIN,
  ).href));
  const errors = [];
  const canonicalToPage = new Map();
  const expectedSitemapUrls = new Set();
  const expectedMatchUrls = new Set();
  const articleUrls = new Set();
  const sportsEventUrls = new Set();
  const paginatedDescriptions = new Map();
  const expectedMatchTitleUrls = new Set();
  const matchTitleFragmentUrls = new Set();
  const expectedPaginatedTitleUrls = new Set();
  const paginatedTitleFragmentUrls = new Set();
  const expectedPageOneTitleUrls = new Set();
  const pageOneWithoutFragmentUrls = new Set();
  const expectedBreadcrumbUrls = new Set();
  const visibleBreadcrumbUrls = new Set();
  const breadcrumbListUrls = new Set();
  const breadcrumbLinks = [];

  for (const file of htmlFiles) {
    const relativePath = path.relative(dist, file);
    const html = await readFile(file, 'utf8');
    const expectedUrl = new URL(routePath(relativePath), SITE_ORIGIN).href;
    const kind = routeKind(relativePath);
    if (kind.kind === 'match') expectedMatchUrls.add(expectedUrl);
    if (['match', 'team', 'tournament', 'hero'].includes(kind.kind)) {
      expectedBreadcrumbUrls.add(expectedUrl);
    }

    const titles = elementTextValues(html, 'title');
    if (titles.length !== 1) {
      errors.push(`${relativePath}: expected exactly one title, found ${titles.length}`);
    } else {
      const title = titles[0];
      if (title !== 'DotaInfo' && !title.endsWith(SITE_TITLE_SUFFIX)) {
        errors.push(`${relativePath}: title must end with the exact site-name suffix: ${title}`);
      } else {
        const fragment = title === 'DotaInfo' ? '' : title.slice(0, -SITE_TITLE_SUFFIX.length);
        const matchFragment = /, match (\d+)$/.exec(fragment);
        if (kind.kind === 'match') {
          expectedMatchTitleUrls.add(expectedUrl);
          if (matchFragment) {
            matchTitleFragmentUrls.add(expectedUrl);
            if (matchFragment[1] !== kind.id) {
              errors.push(`${relativePath}: title match ID ${matchFragment[1]} does not equal route ID ${kind.id}`);
            }
          }
        }

        if (kind.kind === 'team' || kind.kind === 'tournament') {
          const stem = titleStem(html, kind.kind);
          if (stem === null) {
            errors.push(`${relativePath}: missing emitted title stem for ${kind.kind} route`);
          }
          const expectedFragment = kind.page === 1 ? stem : `${stem}, page ${kind.page}`;
          if (kind.page === 1) {
            expectedPageOneTitleUrls.add(expectedUrl);
            if (stem !== null && fragment === expectedFragment) {
              pageOneWithoutFragmentUrls.add(expectedUrl);
            }
          } else {
            expectedPaginatedTitleUrls.add(expectedUrl);
            if (stem !== null && fragment === expectedFragment) {
              paginatedTitleFragmentUrls.add(expectedUrl);
            }
          }
        }
      }
    }

    const breadcrumbs = visibleBreadcrumbs(html);
    if (breadcrumbs.length > 0) visibleBreadcrumbUrls.add(expectedUrl);
    if (breadcrumbs.length > 1) {
      errors.push(`${relativePath}: expected at most one breadcrumb nav, found ${breadcrumbs.length}`);
    }
    if (breadcrumbs.length === 1) {
      const breadcrumb = breadcrumbs[0];
      if (breadcrumb.listCount !== 1) {
        errors.push(`${relativePath}: breadcrumb must contain exactly one ordered list`);
      }
      const finalItem = breadcrumb.items.at(-1);
      if (finalItem?.linkCount > 0) {
        errors.push(`${relativePath}: breadcrumb final crumb must not be a link`);
      }
      for (const item of breadcrumb.items) {
        if (item.linkCount > 1) {
          errors.push(`${relativePath}: breadcrumb item contains more than one link`);
        }
        if (item.href !== null) breadcrumbLinks.push({ relativePath, pageUrl: expectedUrl, href: item.href });
      }
    }

    const canonicals = canonicalValues(html);
    if (canonicals.length !== 1) {
      errors.push(`${relativePath}: expected exactly one canonical link, found ${canonicals.length}`);
      continue;
    }

    const canonical = canonicals[0];
    let parsedCanonical;
    try {
      parsedCanonical = new URL(canonical);
    } catch {
      errors.push(`${relativePath}: canonical is not an absolute URL: ${canonical}`);
      continue;
    }
    if (
      parsedCanonical.origin !== SITE_ORIGIN
      || !parsedCanonical.pathname.endsWith('/')
      || parsedCanonical.search
      || parsedCanonical.hash
    ) {
      errors.push(`${relativePath}: canonical must be on ${SITE_ORIGIN} with a trailing slash: ${canonical}`);
    }
    if (parsedCanonical.href !== expectedUrl) {
      errors.push(`${relativePath}: canonical ${parsedCanonical.href} does not match page URL ${expectedUrl}`);
    }
    const previousPage = canonicalToPage.get(parsedCanonical.href);
    if (previousPage) {
      errors.push(`${relativePath}: canonical duplicates ${previousPage}: ${parsedCanonical.href}`);
    } else {
      canonicalToPage.set(parsedCanonical.href, relativePath);
    }

    const descriptions = metadataValues(html, 'name', 'description');
    if (descriptions.length !== 1) {
      errors.push(`${relativePath}: expected exactly one description, found ${descriptions.length}`);
    } else if (!descriptions[0].trim()) {
      errors.push(`${relativePath}: description is empty`);
    } else if (descriptions[0].length >= 200) {
      errors.push(`${relativePath}: description must be under 200 characters, found ${descriptions[0].length}`);
    }
    if (
      descriptions.length === 1
      && (kind.kind === 'team' || kind.kind === 'tournament')
    ) {
      const series = `${kind.kind}:${kind.id}`;
      const byDescription = paginatedDescriptions.get(series) ?? new Map();
      const previousCanonical = byDescription.get(descriptions[0]);
      if (previousCanonical && previousCanonical !== canonical) {
        errors.push(
          `${relativePath}: ${kind.kind} pagination description duplicates ${previousCanonical}: ${descriptions[0]}`,
        );
      } else {
        byDescription.set(descriptions[0], canonical);
      }
      paginatedDescriptions.set(series, byDescription);
    }

    const ogUrls = metadataValues(html, 'property', 'og:url');
    if (ogUrls.length !== 1 || ogUrls[0] !== canonical) {
      errors.push(`${relativePath}: og:url must equal the canonical URL`);
    }
    for (const property of ['og:title', 'og:description']) {
      const values = metadataValues(html, 'property', property);
      if (values.length !== 1 || !values[0].trim()) {
        errors.push(`${relativePath}: ${property} must occur once with non-empty content`);
      }
    }

    const ogTypes = metadataValues(html, 'property', 'og:type');
    if (ogTypes.length !== 1) {
      errors.push(`${relativePath}: expected exactly one og:type, found ${ogTypes.length}`);
    } else if (ogTypes[0] === 'article') {
      articleUrls.add(expectedUrl);
    } else if (ogTypes[0] !== 'website') {
      errors.push(`${relativePath}: og:type must be article or website, found ${ogTypes[0]}`);
    }

    const jsonLdBlocks = jsonLdValues(html);
    const parsedJsonLd = [];
    for (const block of jsonLdBlocks) {
      let value;
      try {
        value = JSON.parse(block);
      } catch (error) {
        errors.push(`${relativePath}: JSON-LD does not parse: ${error.message}`);
        continue;
      }
      parsedJsonLd.push(value);
      if (!['SportsEvent', 'SportsTeam', 'BreadcrumbList'].includes(value?.['@type'])) {
        errors.push(`${relativePath}: unsupported JSON-LD @type: ${String(value?.['@type'])}`);
      }
      if (value?.['@type'] === 'SportsEvent') sportsEventUrls.add(expectedUrl);
    }

    const breadcrumbLists = parsedJsonLd.filter((value) => value?.['@type'] === 'BreadcrumbList');
    if (breadcrumbLists.length > 0) breadcrumbListUrls.add(expectedUrl);
    if (breadcrumbLists.length > 1) {
      errors.push(`${relativePath}: expected at most one BreadcrumbList, found ${breadcrumbLists.length}`);
    }
    if (breadcrumbs.length === 1 && breadcrumbLists.length !== 1) {
      errors.push(`${relativePath}: breadcrumb nav must have exactly one BreadcrumbList JSON-LD block`);
    }
    if (breadcrumbs.length === 1 && breadcrumbLists.length === 1) {
      const visibleItems = breadcrumbs[0].items;
      const structuredItems = breadcrumbLists[0].itemListElement;
      if (!Array.isArray(structuredItems)) {
        errors.push(`${relativePath}: BreadcrumbList itemListElement must be an array`);
      } else if (structuredItems.length !== visibleItems.length) {
        errors.push(
          `${relativePath}: BreadcrumbList item count ${structuredItems.length} does not match visible count ${visibleItems.length}`,
        );
      } else {
        for (let index = 0; index < visibleItems.length; index += 1) {
          const visibleItem = visibleItems[index];
          const structuredItem = structuredItems[index];
          const expectedItemUrl = visibleItem.href === null
            ? null
            : new URL(visibleItem.href, expectedUrl).href;
          const actualItemUrl = structuredItem?.item ?? null;
          if (index < structuredItems.length - 1 && !actualItemUrl) {
            errors.push(`${relativePath}: BreadcrumbList non-final item ${index + 1} must have an item URL`);
          }
          if (
            structuredItem?.['@type'] !== 'ListItem'
            || structuredItem?.position !== index + 1
            || structuredItem?.name !== visibleItem.name
            || actualItemUrl !== expectedItemUrl
          ) {
            errors.push(`${relativePath}: BreadcrumbList item ${index + 1} does not match visible breadcrumb order`);
          }
        }
      }
    }

    if (relativePath.replaceAll(path.sep, '/') !== '404.html') {
      expectedSitemapUrls.add(parsedCanonical.href);
    }
  }

  assertSetEquality(errors, 'match title fragment route set', expectedMatchTitleUrls, matchTitleFragmentUrls);
  assertSetEquality(
    errors,
    'paginated team/tournament title fragment route set',
    expectedPaginatedTitleUrls,
    paginatedTitleFragmentUrls,
  );
  assertSetEquality(
    errors,
    'page-one team/tournament route set without page fragments',
    expectedPageOneTitleUrls,
    pageOneWithoutFragmentUrls,
  );
  assertSetEquality(errors, 'visible breadcrumb route set', expectedBreadcrumbUrls, visibleBreadcrumbUrls);
  assertSetEquality(errors, 'BreadcrumbList route set', expectedBreadcrumbUrls, breadcrumbListUrls);

  for (const link of breadcrumbLinks) {
    let target;
    try {
      target = new URL(link.href, link.pageUrl);
    } catch {
      errors.push(`${link.relativePath}: breadcrumb link is not a URL: ${link.href}`);
      continue;
    }
    if (!emittedPageUrls.has(target.href)) {
      errors.push(`${link.relativePath}: breadcrumb link target does not exist in dist: ${target.href}`);
    }
  }

  const missingArticleUrls = [...expectedMatchUrls].filter((url) => !articleUrls.has(url)).sort();
  const unexpectedArticleUrls = [...articleUrls].filter((url) => !expectedMatchUrls.has(url)).sort();
  if (missingArticleUrls.length > 0) {
    errors.push(`og:type article is missing from match route(s): ${describeList(missingArticleUrls)}`);
  }
  if (unexpectedArticleUrls.length > 0) {
    errors.push(`og:type article appears on non-match route(s): ${describeList(unexpectedArticleUrls)}`);
  }

  const missingSportsEvents = [...expectedMatchUrls]
    .filter((url) => !sportsEventUrls.has(url))
    .sort();
  const unexpectedSportsEvents = [...sportsEventUrls]
    .filter((url) => !expectedMatchUrls.has(url))
    .sort();
  if (missingSportsEvents.length > 0) {
    errors.push(`SportsEvent JSON-LD is missing from match route(s): ${describeList(missingSportsEvents)}`);
  }
  if (unexpectedSportsEvents.length > 0) {
    errors.push(`SportsEvent JSON-LD appears on non-match route(s): ${describeList(unexpectedSportsEvents)}`);
  }

  const sitemapFiles = allFiles
    .filter((file) => /^sitemap-\d+\.xml$/i.test(path.basename(file)))
    .sort((left, right) => left.localeCompare(right));
  if (sitemapFiles.length === 0) errors.push('no numbered sitemap XML files were emitted');

  const sitemapEntries = [];
  for (const file of sitemapFiles) {
    const xml = await readFile(file, 'utf8');
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      sitemapEntries.push(decodeEntities(match[1].trim()));
    }
  }
  const sitemapUrls = new Set(sitemapEntries);
  if (sitemapUrls.size !== sitemapEntries.length) {
    errors.push(`sitemap contains ${sitemapEntries.length - sitemapUrls.size} duplicate URL entries`);
  }

  const missingFromSitemap = [...expectedSitemapUrls]
    .filter((url) => !sitemapUrls.has(url))
    .sort();
  const unexpectedInSitemap = [...sitemapUrls]
    .filter((url) => !expectedSitemapUrls.has(url))
    .sort();
  if (missingFromSitemap.length > 0) {
    errors.push(`sitemap is missing canonical URL(s): ${describeList(missingFromSitemap)}`);
  }
  if (unexpectedInSitemap.length > 0) {
    errors.push(`sitemap has unexpected URL(s): ${describeList(unexpectedInSitemap)}`);
  }

  console.log(`STEP31_HTML_PAGES_SCANNED=${htmlFiles.length}`);
  console.log(`STEP31_SITEMAP_URLS=${sitemapEntries.length}`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`STEP31_METADATA_ERROR=${error}`);
    console.error('STEP31_METADATA_STATUS=FAIL');
    process.exitCode = 1;
    return;
  }
  console.log('STEP31_METADATA_STATUS=PASS');
}

main().catch((error) => {
  console.error(`STEP31_METADATA_ERROR=${error.message}`);
  console.error('STEP31_METADATA_STATUS=FAIL');
  process.exitCode = 1;
});
