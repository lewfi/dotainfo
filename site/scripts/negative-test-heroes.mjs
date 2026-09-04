import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SITE_ROOT = path.resolve(import.meta.dirname, '..');
const DIST_ROOT = path.join(SITE_ROOT, 'dist');
const HERO_AUDIT = path.join(SITE_ROOT, 'scripts', 'audit-heroes.mjs');
const LINK_AUDIT = path.join(SITE_ROOT, 'scripts', 'audit-links.mjs');

async function command(script, args) {
  try {
    const result = await run(process.execPath, [script, ...args], {
      cwd: SITE_ROOT,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    return { code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function selectedValue(output, name) {
  return new RegExp(`"${name}":(true|false)`).exec(output)?.[1] ?? null;
}

function fileMutation(filename, transform) {
  let original;
  return {
    async apply() {
      original = await readFile(filename, 'utf8');
      const changed = transform(original);
      assert.notEqual(changed, original, `mutation did not change ${filename}`);
      await writeFile(filename, changed, 'utf8');
    },
    async restore() {
      if (original !== undefined) await writeFile(filename, original, 'utf8');
    },
  };
}

async function runHeroAssertion(name, mutation, extraArgs = []) {
  if (mutation) await mutation.apply();
  let failed;
  try {
    failed = await command(HERO_AUDIT, ['--dist', DIST_ROOT, '--only', name, ...extraArgs]);
  } finally {
    if (mutation) await mutation.restore();
  }
  assert.notEqual(failed.code, 0, `${name} mutation unexpectedly passed`);
  assert.equal(selectedValue(failed.output, name), 'false', `${name} did not report false\n${failed.output}`);
  console.log(`STEP26_NEGATIVE_FAIL=${name}`);
  console.log(failed.output.trim());

  const restored = await command(HERO_AUDIT, ['--dist', DIST_ROOT, '--only', name]);
  assert.equal(restored.code, 0, `${name} did not pass after restoration\n${restored.output}`);
  assert.equal(selectedValue(restored.output, name), 'true');
  console.log(`STEP26_NEGATIVE_RESTORED=${name}`);
  console.log(restored.output.trim());
}

const heroRoot = path.join(DIST_ROOT, 'heroes');
const heroDirectories = (await readdir(heroRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
  .map((entry) => path.join(heroRoot, entry.name))
  .sort();
assert.ok(heroDirectories.length >= 2, 'negative test needs two hero pages');
const firstHeroPage = path.join(heroDirectories[0], 'index.html');
const secondHeroPage = path.join(heroDirectories[1], 'index.html');
const heroIndex = path.join(heroRoot, 'index.html');
const homePage = path.join(DIST_ROOT, 'index.html');
const indexHtml = await readFile(heroIndex, 'utf8');
const stylesheetHref = /<link rel="stylesheet" href="([^"]+\.css)"/.exec(indexHtml)?.[1];
assert.ok(stylesheetHref, 'negative test could not locate emitted stylesheet');
const stylesheet = path.join(DIST_ROOT, ...stylesheetHref.split('/').filter(Boolean));

const hiddenDirectory = `${heroDirectories[0]}.negative-test`;
await runHeroAssertion('allHeroesHavePagesAndFactIdsResolve', {
  async apply() { await rename(heroDirectories[0], hiddenDirectory); },
  async restore() { await rename(hiddenDirectory, heroDirectories[0]); },
});

await runHeroAssertion('indexContainsAllHeroReferenceFields', fileMutation(
  heroIndex,
  (html) => html.replace(/data-attack-type="[^"]+"/, 'data-attack-type="Broken"'),
));

await runHeroAssertion('heroCountsMatchIndependentUnprunedScan', fileMutation(
  firstHeroPage,
  (html) => html.replace(/data-pick-count="(\d+)"/, (_, value) => `data-pick-count="${Number(value) + 1}"`),
));

await runHeroAssertion('draftTeamZeroIsRadiant', null, ['--invert-team-encoding']);

await runHeroAssertion('rateDenominatorsAreDocumentedPopulations', fileMutation(
  firstHeroPage,
  (html) => html.replace(/data-draft-match-denominator="(\d+)"/, (_, value) => `data-draft-match-denominator="${Number(value) + 1}"`),
));

const firstTitle = /<title>([\s\S]*?)<\/title>/.exec(await readFile(firstHeroPage, 'utf8'))?.[1];
assert.ok(firstTitle, 'negative test could not read hero title');
await runHeroAssertion('emittedHeroTitlesAreUnique', fileMutation(
  secondHeroPage,
  (html) => html.replace(/<title>[\s\S]*?<\/title>/, `<title>${firstTitle}</title>`),
));

await runHeroAssertion('summedHeroPicksEqualAllPickRows', fileMutation(
  heroIndex,
  (html) => html.replace(/data-total-picks="(\d+)"/, (_, value) => `data-total-picks="${Number(value) + 1}"`),
));

await runHeroAssertion('patchTrendMatchesIndependentUnprunedScan', fileMutation(
  firstHeroPage,
  (html) => html.replace(
    /(<div\b[^>]*data-patch="[^"]+"[^>]*data-pick-count=")(\d+)(")/,
    (_, before, value, after) => `${before}${Number(value) + 1}${after}`,
  ),
));

await runHeroAssertion('laneDistributionMatchesIndependentUnprunedScan', fileMutation(
  firstHeroPage,
  (html) => html.replace(
    /(<li\b[^>]*data-lane-role="[^"]+"[^>]*data-appearances=")(\d+)(")/,
    (_, before, value, after) => `${before}${Number(value) + 1}${after}`,
  ),
));

await runHeroAssertion('exactWidthSweepHasNoHorizontalOverflow', fileMutation(
  stylesheet,
  (css) => `${css}.hero-index{width:2000px}`,
));

await runHeroAssertion('emittedHeroColorsPassContrastAndControlSurfaces', fileMutation(
  stylesheet,
  (css) => `${css}.hero-index-group,.hero-page-panel{background:#f00}`,
));

await runHeroAssertion('lineBordersAttachToStrongHeroBoundaries', fileMutation(
  stylesheet,
  (css) => css.replace('.hero-index-group .hero-index-row{', '.hero-index-row.hero-index-row{'),
));

const heroLinkMutation = fileMutation(
  homePage,
  (html) => html.replace('href="/heroes/"', 'href="/heroes/999999999/"'),
);
await heroLinkMutation.apply();
let failedLink;
try {
  failedLink = await command(LINK_AUDIT, ['--dist', DIST_ROOT]);
} finally {
  await heroLinkMutation.restore();
}
assert.notEqual(failedLink.code, 0, 'hero href mutation unexpectedly passed');
assert.equal(selectedValue(failedLink.output, 'everyHeroHrefResolves'), 'false');
console.log('STEP26_NEGATIVE_FAIL=everyHeroHrefResolves');
console.log(failedLink.output.trim());
const restoredLink = await command(LINK_AUDIT, ['--dist', DIST_ROOT]);
assert.equal(restoredLink.code, 0, `hero href did not pass after restoration\n${restoredLink.output}`);
assert.equal(selectedValue(restoredLink.output, 'everyHeroHrefResolves'), 'true');
console.log('STEP26_NEGATIVE_RESTORED=everyHeroHrefResolves');
console.log(restoredLink.output.trim());
console.log('STEP26_NEGATIVE_STATUS=PASS');
