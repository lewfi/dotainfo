import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SITE_ROOT = path.resolve(import.meta.dirname, '..');
const DIST_ROOT = path.join(SITE_ROOT, 'dist');
const TOURNAMENT_AUDIT = path.join(SITE_ROOT, 'scripts', 'audit-tournaments.mjs');
const LINK_AUDIT = path.join(SITE_ROOT, 'scripts', 'audit-links.mjs');

async function tournamentHtmlFiles() {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.name === 'index.html' && directory !== path.join(DIST_ROOT, 'tournaments')) {
        files.push(entryPath);
      }
    }
  }
  await visit(path.join(DIST_ROOT, 'tournaments'));
  return files;
}

async function command(script, args) {
  try {
    const result = await run(process.execPath, [script, ...args], {
      cwd: SITE_ROOT,
      maxBuffer: 8 * 1024 * 1024,
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

async function runTournamentAssertion(name, mutation) {
  await mutation.apply();
  let failed;
  try {
    failed = await command(TOURNAMENT_AUDIT, ['--dist', DIST_ROOT, '--only', name]);
  } finally {
    await mutation.restore();
  }
  assert.notEqual(failed.code, 0, `${name} mutation unexpectedly passed`);
  assert.equal(selectedValue(failed.output, name), 'false', `${name} did not report false`);
  console.log(`STEP25_NEGATIVE_FAIL=${name}`);
  console.log(failed.output.trim());

  const restored = await command(TOURNAMENT_AUDIT, ['--dist', DIST_ROOT, '--only', name]);
  assert.equal(restored.code, 0, `${name} did not pass after restoration\n${restored.output}`);
  assert.equal(selectedValue(restored.output, name), 'true');
  console.log(`STEP25_NEGATIVE_RESTORED=${name}`);
  console.log(restored.output.trim());
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

const pages = await tournamentHtmlFiles();
const pageRecords = await Promise.all(pages.map(async (filename) => {
  const html = await readFile(filename, 'utf8');
  return {
    filename,
    html,
    pageCount: Number(/data-page-count="(\d+)"/.exec(html)?.[1]),
  };
}));
const singlePages = pageRecords.filter((record) => record.pageCount === 1
  && [...record.html.matchAll(/data-match-id="(\d+)"/g)].length >= 2);
assert.ok(singlePages.length >= 2, 'negative test needs two single-page tournaments');
const firstPage = singlePages[0];
const secondPage = singlePages[1];
const tournamentIndex = path.join(DIST_ROOT, 'tournaments', 'index.html');
const indexHtml = await readFile(tournamentIndex, 'utf8');
const stylesheetHref = /<link rel="stylesheet" href="([^"]+\.css)"/.exec(indexHtml)?.[1];
assert.ok(stylesheetHref, 'negative test could not locate emitted stylesheet');
const stylesheet = path.join(DIST_ROOT, ...stylesheetHref.split('/').filter(Boolean));

const hiddenPage = `${firstPage.filename}.negative-test`;
await runTournamentAssertion('everyLeagueHasPage', {
  async apply() { await rename(firstPage.filename, hiddenPage); },
  async restore() { await rename(hiddenPage, firstPage.filename); },
});

await runTournamentAssertion('perLeagueCountsMatchIndependentScan', fileMutation(
  firstPage.filename,
  (html) => html.replace(/data-total-matches="(\d+)"/, (_, count) => `data-total-matches="${Number(count) + 1}"`),
));

await runTournamentAssertion('paginationIsCompleteExactAndUnique', fileMutation(
  firstPage.filename,
  (html) => {
    const ids = [...html.matchAll(/data-match-id="(\d+)"/g)].map((match) => match[1]);
    assert.ok(ids.length >= 2, 'negative test needs a page with two matches');
    return html
      .replace(`data-match-id="${ids[0]}"`, 'data-match-id="STEP25_SWAP"')
      .replace(`data-match-id="${ids[1]}"`, `data-match-id="${ids[0]}"`)
      .replace('data-match-id="STEP25_SWAP"', `data-match-id="${ids[1]}"`);
  },
));

const firstTitle = /<title>([\s\S]*?)<\/title>/.exec(firstPage.html)?.[1];
assert.ok(firstTitle, 'negative test could not read tournament title');
await runTournamentAssertion('emittedTitlesAreUnique', fileMutation(
  secondPage.filename,
  (html) => html.replace(/<title>[\s\S]*?<\/title>/, `<title>${firstTitle}</title>`),
));

await runTournamentAssertion('tierGroupingDropsNoMatches', fileMutation(
  tournamentIndex,
  (html) => html.replace(/data-match-count="(\d+)"/, (_, count) => `data-match-count="${Number(count) + 1}"`),
));

await runTournamentAssertion('exactWidthSweepHasNoHorizontalOverflow', fileMutation(
  stylesheet,
  (css) => `${css}.tournament-index{width:2000px}`,
));

await runTournamentAssertion('emittedTournamentColorsPassContrastAndControlSurfaces', fileMutation(
  stylesheet,
  (css) => `${css}.tournament-panel,.tournament-index-group{background:#f00}`,
));

await runTournamentAssertion('lineBordersAttachToStrongTournamentBoundaries', fileMutation(
  stylesheet,
  (css) => css.replace('.tournament-panel .tournament-day-heading{', '.tournament-day-heading.tournament-day-heading{'),
));

const homePage = path.join(DIST_ROOT, 'index.html');
const linkMutation = fileMutation(
  homePage,
  (html) => html.replace('href="/tournaments/"', 'href="/tournaments/999999999/"'),
);
await linkMutation.apply();
let failedLink;
try {
  failedLink = await command(LINK_AUDIT, ['--dist', DIST_ROOT]);
} finally {
  await linkMutation.restore();
}
assert.notEqual(failedLink.code, 0, 'tournament href mutation unexpectedly passed');
assert.equal(selectedValue(failedLink.output, 'everyTournamentHrefResolves'), 'false');
console.log('STEP25_NEGATIVE_FAIL=everyTournamentHrefResolves');
console.log(failedLink.output.trim());
const restoredLink = await command(LINK_AUDIT, ['--dist', DIST_ROOT]);
assert.equal(restoredLink.code, 0, `tournament href did not pass after restoration\n${restoredLink.output}`);
assert.equal(selectedValue(restoredLink.output, 'everyTournamentHrefResolves'), 'true');
console.log('STEP25_NEGATIVE_RESTORED=everyTournamentHrefResolves');
console.log(restoredLink.output.trim());
console.log('STEP25_NEGATIVE_STATUS=PASS');
