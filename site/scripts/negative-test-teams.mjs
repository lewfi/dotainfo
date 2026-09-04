import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SITE_ROOT = path.resolve(import.meta.dirname, '..');
const DIST_ROOT = path.join(SITE_ROOT, 'dist');
const TEAM_AUDIT = path.join(SITE_ROOT, 'scripts', 'audit-teams.mjs');
const LINK_AUDIT = path.join(SITE_ROOT, 'scripts', 'audit-links.mjs');

async function command(script, args) {
  try {
    const result = await run(process.execPath, [script, ...args], {
      cwd: SITE_ROOT,
      maxBuffer: 32 * 1024 * 1024,
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

async function runTeamAssertion(name, mutation) {
  await mutation.apply();
  let failed;
  try {
    failed = await command(TEAM_AUDIT, ['--dist', DIST_ROOT, '--only', name]);
  } finally {
    await mutation.restore();
  }
  assert.notEqual(failed.code, 0, `${name} mutation unexpectedly passed`);
  assert.equal(selectedValue(failed.output, name), 'false', `${name} did not report false\n${failed.output}`);
  console.log(`STEP27_NEGATIVE_FAIL=${name}`);
  console.log(failed.output.trim());

  const restored = await command(TEAM_AUDIT, ['--dist', DIST_ROOT, '--only', name]);
  assert.equal(restored.code, 0, `${name} did not pass after restoration\n${restored.output}`);
  assert.equal(selectedValue(restored.output, name), 'true');
  console.log(`STEP27_NEGATIVE_RESTORED=${name}`);
  console.log(restored.output.trim());
}

const teamRoot = path.join(DIST_ROOT, 'teams');
const teamDirectories = (await readdir(teamRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
  .map((entry) => path.join(teamRoot, entry.name))
  .sort();
const records = [];
for (const directory of teamDirectories) {
  const filename = path.join(directory, 'index.html');
  const html = await readFile(filename, 'utf8');
  records.push({
    directory,
    filename,
    html,
    pageCount: Number(/data-page-count="(\d+)"/.exec(html)?.[1]),
    matchCount: [...html.matchAll(/data-match-id="\d+"/g)].length,
    heroCount: [...html.matchAll(/class="team-hero-row"/g)].length,
  });
}
const candidates = records.filter((record) => record.pageCount === 1 && record.matchCount >= 2);
assert.ok(candidates.length >= 2, 'negative test needs two multi-match single-page teams');
const first = candidates[0];
const second = candidates[1];
const heroPage = records.find((record) => record.heroCount > 0);
assert.ok(heroPage, 'negative test needs a team with hero rows');
const teamIndex = path.join(teamRoot, 'index.html');
const homePage = path.join(DIST_ROOT, 'index.html');
const indexHtml = await readFile(teamIndex, 'utf8');
const stylesheetHref = /<link rel="stylesheet" href="([^"]+\.css)"/.exec(indexHtml)?.[1];
assert.ok(stylesheetHref, 'negative test could not locate emitted stylesheet');
const stylesheet = path.join(DIST_ROOT, ...stylesheetHref.split('/').filter(Boolean));

const hiddenPage = `${first.filename}.negative-test`;
await runTeamAssertion('everyTeamIdHasPage', {
  async apply() { await rename(first.filename, hiddenPage); },
  async restore() { await rename(hiddenPage, first.filename); },
});

const indexIds = [...indexHtml.matchAll(/data-index-team-id="(\d+)"/g)].map((match) => match[1]);
assert.ok(indexIds.length >= 2);
await runTeamAssertion('indexIsGroupedAndComplete', fileMutation(
  teamIndex,
  (html) => html.replace(`data-index-team-id="${indexIds[0]}"`, `data-index-team-id="${indexIds[1]}"`),
));

await runTeamAssertion('perTeamMatchCountsMatchIndependentUnprunedScan', fileMutation(
  first.filename,
  (html) => html.replace(/data-total-matches="(\d+)"/, (_, value) => `data-total-matches="${Number(value) + 1}"`),
));

await runTeamAssertion('paginationIsCompleteExactAndDuplicateFree', fileMutation(
  first.filename,
  (html) => {
    const ids = [...html.matchAll(/data-match-id="(\d+)"/g)].map((match) => match[1]);
    return html.replace(`data-match-id="${ids[0]}"`, 'data-match-id="STEP27_SWAP"')
      .replace(`data-match-id="${ids[1]}"`, `data-match-id="${ids[0]}"`)
      .replace('data-match-id="STEP27_SWAP"', `data-match-id="${ids[1]}"`);
  },
));

await runTeamAssertion('winLossCountsUseOnlyRecordedResults', fileMutation(
  first.filename,
  (html) => html.replace(/data-wins="(\d+)"/, (_, value) => `data-wins="${Number(value) + 1}"`),
));

await runTeamAssertion('everyMatchAppearsOnItsNonNullTeamPages', fileMutation(
  first.filename,
  (html) => html.replace(/data-match-id="\d+"/, 'data-match-id="999999999999"'),
));

await runTeamAssertion('currentEraNamesAndLogoStatesFollowContract', fileMutation(
  first.filename,
  (html) => html.replace(/data-team-name="[^"]+"/, 'data-team-name="Broken team name"'),
));

await runTeamAssertion('mostPlayedHeroesMatchIndependentScan', fileMutation(
  heroPage.filename,
  (html) => html.replace(/data-appearances="(\d+)"/, (_, value) => `data-appearances="${Number(value) + 1}"`),
));

const firstTitle = /<title>([\s\S]*?)<\/title>/.exec(first.html)?.[1];
assert.ok(firstTitle);
await runTeamAssertion('emittedTeamTitlesAreUnique', fileMutation(
  second.filename,
  (html) => html.replace(/<title>[\s\S]*?<\/title>/, `<title>${firstTitle}</title>`),
));

await runTeamAssertion('exactWidthSweepHasNoHorizontalOverflow', fileMutation(
  stylesheet,
  (css) => `${css}.team-index{width:2000px}`,
));

await runTeamAssertion('emittedTeamColorsPassContrastAndControlSurfaces', fileMutation(
  stylesheet,
  (css) => `${css}.team-index-group,.team-page-panel{background:#f00}`,
));

await runTeamAssertion('lineBordersAttachToStrongTeamBoundaries', fileMutation(
  stylesheet,
  (css) => css.replace('.team-index-group .team-index-row{', '.team-index-row.team-index-row{'),
));

const teamLinkMutation = fileMutation(
  homePage,
  (html) => html.replace('href="/teams/"', 'href="/teams/999999999/"'),
);
await teamLinkMutation.apply();
let failedLink;
try {
  failedLink = await command(LINK_AUDIT, ['--dist', DIST_ROOT]);
} finally {
  await teamLinkMutation.restore();
}
assert.notEqual(failedLink.code, 0, 'team href mutation unexpectedly passed');
assert.equal(selectedValue(failedLink.output, 'everyTeamHrefResolves'), 'false');
console.log('STEP27_NEGATIVE_FAIL=everyTeamHrefResolves');
console.log(failedLink.output.trim());
const restoredLink = await command(LINK_AUDIT, ['--dist', DIST_ROOT]);
assert.equal(restoredLink.code, 0, `team href did not pass after restoration\n${restoredLink.output}`);
assert.equal(selectedValue(restoredLink.output, 'everyTeamHrefResolves'), 'true');
console.log('STEP27_NEGATIVE_RESTORED=everyTeamHrefResolves');
console.log(restoredLink.output.trim());
console.log('STEP27_NEGATIVE_STATUS=PASS');
