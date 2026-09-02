import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createMatchDetailModel } from '../src/presentation/match-detail.mjs';
import {
  DETAIL_FIXTURE_CASES,
  fixtureReferences,
} from './fixtures/match-detail/cases.mjs';

const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ASTRO_CLI = fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url));
const CLOCK = '2026-09-01T20:42:40Z';

function fixtureBuild(outputRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ASTRO_CLI, 'build'], {
      cwd: SITE_ROOT,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: '1',
        DOTAINFO_BUILD_CLOCK: CLOCK,
        DOTAINFO_STEP14_FIXTURE_BUILD: '1',
        DOTAINFO_FIXTURE_OUT_DIR: outputRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}

test('normal and edge-case fixtures produce complete detail models without ten-player assumptions', () => {
  const models = Object.fromEntries(DETAIL_FIXTURE_CASES.map((fixture) => [
    fixture.id,
    createMatchDetailModel(fixture.detail, fixtureReferences()),
  ]));

  assert.equal(models.normal.boxscores.radiant.length, 1);
  assert.equal(models.normal.boxscores.dire.length, 1);
  assert.equal(models.normal.boxscores.radiant[0].level, 25);
  assert.equal(models.normal.boxscores.dire[0].level, 19);
  assert.equal(models.normal.draft.length, 2);
  assert.ok(models.normal.advantage);
  assert.equal(models['no-draft'].draft.length, 0);
  assert.equal(models['null-advantage'].advantage, null);
  assert.equal(models['null-team'].summary.teams.radiant.name.status, 'missing');
  assert.equal(models['whitespace-name'].summary.teams.radiant.name.status, 'missing');
  assert.equal(models['whitespace-name'].summary.teams.dire.name.status, 'missing');
  assert.equal(models['tag-fallback'].summary.teams.radiant.name.source, 'reference-tag');
  assert.equal(models['null-result-score'].summary.result.status, 'missing');
  assert.equal(models['null-result-score'].summary.score.status, 'missing');
});

test('Astro renders all Step 14 fixtures with defined team displays and conditional sections', async (t) => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'dotainfo-step14-render-'));
  assert.ok(path.resolve(outputRoot).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
  t.after(async () => rm(outputRoot, { recursive: true, force: true }));

  const build = await fixtureBuild(outputRoot);
  assert.equal(build.code, 0, build.output);
  const pages = {};
  for (const fixture of DETAIL_FIXTURE_CASES) {
    const html = await readFile(
      path.join(outputRoot, 'fixture-render', fixture.id, 'index.html'),
      'utf8',
    );
    pages[fixture.id] = html;
    const displays = [...html.matchAll(/data-team-display="([^"]*)"/g)];
    assert.equal(displays.length, 2, fixture.id);
    assert.ok(displays.every((match) => {
      const display = match[1].trim();
      return display.length > 0 && display !== 'undefined';
    }), fixture.id);
    assert.equal((html.match(/data-player-slot=/g) ?? []).length, 2, fixture.id);
  }

  assert.match(pages.normal, /data-draft-state="available"/);
  assert.match(pages.normal, /data-advantage-graph/);
  assert.match(pages.normal, /<th scope="col">Lvl<\/th>/);
  assert.match(pages.normal, /<td>25<\/td>/);
  assert.match(pages.normal, /role="region" tabindex="0" aria-labelledby="boxscore-radiant"/);
  assert.match(pages['no-draft'], /data-draft-state="unavailable"/);
  assert.match(pages['no-draft'], /Draft data is not available for this match/);
  assert.doesNotMatch(pages['null-advantage'], /data-advantage-graph/);
  assert.match(pages['null-team'], /Team name unavailable/);
  assert.match(pages['whitespace-name'], /Team name unavailable/);
  assert.match(pages['tag-fallback'], /TAG ONLY/);
  assert.match(pages['tag-fallback'], /Tag fallback/);
  assert.match(pages['null-result-score'], /Result unavailable/);
  assert.match(pages['null-result-score'], /Score unavailable/);
  assert.match(pages.normal, /data-logo-state="missing"/);
  assert.match(pages.normal, /Logo unavailable/);
});
