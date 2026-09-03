import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const AUDIT = fileURLToPath(new URL('./audit-detail-visual.mjs', import.meta.url));
const DIST = path.join(SITE_ROOT, 'dist');
const ASSERTION_NAMES = Object.freeze([
  'archiveRuntimeUsesDistinctSummaryClass',
  'scoreboardsHaveSevenColumnsAndAccessibleExpansions',
  'emittedThemeTokensControlDetailAndArchive',
  'containerQuerySwitchesAtItsEmittedThreshold',
  'exactWidthSweepHasNoHorizontalOverflow',
  'homeHintsAvoidRedundantTitleAndPreserveNoJsViews',
]);

async function runAudit(assertion) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AUDIT, '--dist', DIST, '--only', assertion], {
      cwd: SITE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output: output.trim() }));
  });
}

async function recentDetail() {
  const matchesRoot = path.join(DIST, 'matches');
  const entries = (await readdir(matchesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const entry of entries) {
    const filename = path.join(matchesRoot, entry.name, 'index.html');
    const contents = await readFile(filename, 'utf8');
    if (contents.includes('data-scoreboard-table')) return { filename, contents };
  }
  throw new Error('no emitted recent detail page was found');
}

function insertStyle(html, style) {
  assert.ok(html.includes('</head>'), 'emitted page has no closing head');
  return html.replace('</head>', `<style>${style}</style></head>`);
}

async function mutation(assertion) {
  if (assertion === 'archiveRuntimeUsesDistinctSummaryClass') {
    const archiveHtml = await readFile(path.join(DIST, '404.html'), 'utf8');
    const href = /<script type="module" src="([^"]+)"><\/script>/.exec(archiveHtml)?.[1] ?? null;
    assert.ok(href, 'archive module bundle is missing');
    const filename = path.join(DIST, ...href.split('/').filter(Boolean));
    const original = await readFile(filename, 'utf8');
    const broken = original.replaceAll('archive-summary', 'match-card');
    assert.notEqual(broken, original, 'archive summary class was not present in its runtime bundle');
    return { files: [{ filename, original }], writes: [{ filename, contents: broken }] };
  }

  if (assertion === 'homeHintsAvoidRedundantTitleAndPreserveNoJsViews') {
    const filename = path.join(DIST, 'index.html');
    const original = await readFile(filename, 'utf8');
    const broken = original.replace(
      '<button type="button" class="tier-option"',
      '<button type="button" class="tier-option" title="Duplicated visible hint"',
    );
    assert.notEqual(broken, original, 'home tier button was not found');
    return { files: [{ filename, original }], writes: [{ filename, contents: broken }] };
  }

  const detail = await recentDetail();
  if (assertion === 'scoreboardsHaveSevenColumnsAndAccessibleExpansions') {
    const broken = detail.contents.replaceAll(
      'Gold per minute / Experience per minute',
      'Gold / Experience',
    );
    assert.notEqual(broken, detail.contents, 'expanded economy label was not found');
    return {
      files: [{ filename: detail.filename, original: detail.contents }],
      writes: [{ filename: detail.filename, contents: broken }],
    };
  }

  const style = assertion === 'emittedThemeTokensControlDetailAndArchive'
    ? '.match-detail-summary{background:#ff00ff!important;border-color:#ff00ff!important}'
    : assertion === 'containerQuerySwitchesAtItsEmittedThreshold'
      ? '.boxscore tbody tr{display:block!important}'
      : assertion === 'exactWidthSweepHasNoHorizontalOverflow'
        ? 'html{min-width:2000px!important}'
        : null;
  assert.ok(style, `unsupported assertion: ${assertion}`);
  return {
    files: [{ filename: detail.filename, original: detail.contents }],
    writes: [{ filename: detail.filename, contents: insertStyle(detail.contents, style) }],
  };
}

const assertion = process.argv[2];
if (!ASSERTION_NAMES.includes(assertion)) {
  console.error(`usage: node scripts/negative-detail-visual.mjs ${ASSERTION_NAMES.join('|')}`);
  process.exit(2);
}

const change = await mutation(assertion);
try {
  for (const write of change.writes) await writeFile(write.filename, write.contents);
  const negative = await runAudit(assertion);
  console.log(`NEGATIVE_TEST_ASSERTION=${assertion}`);
  console.log('NEGATIVE_TEST_OUTPUT_BEGIN');
  console.log(negative.output);
  console.log('NEGATIVE_TEST_OUTPUT_END');
  assert.notEqual(negative.code, 0, `${assertion} unexpectedly passed against broken output`);
} finally {
  for (const file of change.files) await writeFile(file.filename, file.original);
}

const restored = await runAudit(assertion);
console.log('RESTORED_TEST_OUTPUT_BEGIN');
console.log(restored.output);
console.log('RESTORED_TEST_OUTPUT_END');
assert.equal(restored.code, 0, `${assertion} did not pass after restoration`);
console.log(`NEGATIVE_TEST_STATUS=PASS assertion=${assertion}`);
