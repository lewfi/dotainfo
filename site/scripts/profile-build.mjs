import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  historicalManifest,
  historicalMatchShards,
  historicalMonthPayload,
  serializeArtifact,
} from '../src/data/historical-artifacts.mjs';

const PEAK_RECENT_MATCHES = 8_673;
const TEN_MINUTES_MS = 10 * 60 * 1_000;
const TWENTY_MINUTES_MS = 20 * 60 * 1_000;
const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ASTRO_CLI = fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function buildClock() {
  const value = argument('--clock') ?? process.env.DOTAINFO_BUILD_CLOCK ?? new Date().toISOString();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`invalid build clock: ${value}`);
  return parsed.toISOString().replace('.000Z', 'Z');
}

function runAstro(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ASTRO_CLI, 'build'], {
      cwd: SITE_ROOT,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Astro build terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function countHtml(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) count += await countHtml(entryPath);
    else if (entry.name.endsWith('.html')) count += 1;
  }
  return count;
}

async function countRecentMatchPages(outputRoot) {
  const entries = await readdir(path.join(outputRoot, 'matches'), { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).length;
}

const clock = buildClock();
const totalStarted = performance.now();
const scratchRoot = await mkdtemp(path.join(tmpdir(), 'dotainfo-profile-build-'));
const resolvedTemp = path.resolve(tmpdir());
if (!path.resolve(scratchRoot).startsWith(`${resolvedTemp}${path.sep}`)) {
  throw new Error('profile scratch directory escaped the system temp directory');
}

let exitCode = 1;
try {
  const artifactRoot = path.join(scratchRoot, 'matches');
  await mkdir(artifactRoot, { recursive: true });
  const payloadStarted = performance.now();
  for (const shard of await historicalMatchShards()) {
    const payload = await historicalMonthPayload(shard.month);
    await writeFile(
      path.join(artifactRoot, `${shard.month}.json`),
      serializeArtifact(payload),
      'utf8',
    );
  }
  await writeFile(
    path.join(artifactRoot, 'manifest.json'),
    serializeArtifact(await historicalManifest()),
    'utf8',
  );
  const payloadGenerationMs = performance.now() - payloadStarted;

  const pageStarted = performance.now();
  exitCode = await runAstro({
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: '1',
    DOTAINFO_BUILD_CLOCK: clock,
    DOTAINFO_PREGENERATED_ARTIFACT_ROOT: artifactRoot,
  });
  const pageGenerationMs = performance.now() - pageStarted;
  if (exitCode !== 0) process.exitCode = exitCode;
  else {
    const outputRoot = path.join(SITE_ROOT, 'dist');
    const [pagesBuilt, recentMatches, tournamentPages, heroPages, teamPages] = await Promise.all([
      countHtml(outputRoot),
      countRecentMatchPages(outputRoot),
      countHtml(path.join(outputRoot, 'tournaments')),
      countHtml(path.join(outputRoot, 'heroes')),
      countHtml(path.join(outputRoot, 'teams')),
    ]);
    const totalWallMs = performance.now() - totalStarted;
    const meanMsPerPage = pageGenerationMs / pagesBuilt;
    const nonMatchPages = pagesBuilt - recentMatches;
    const peakPages = PEAK_RECENT_MATCHES + nonMatchPages;
    const projectedPeakPageMs = meanMsPerPage * peakPages;
    const projectedPeakTotalMs = payloadGenerationMs + projectedPeakPageMs;
    const assertions = Object.freeze({
      currentBuildUnderCloudflareTwentyMinutes: totalWallMs < TWENTY_MINUTES_MS,
      htmlPageCountConsistent:
        pagesBuilt === recentMatches + tournamentPages + heroPages + teamPages + 2,
    });
    const warnings = Object.freeze({
      currentBuildExceedsTenMinutes: totalWallMs >= TEN_MINUTES_MS,
      projectedPeakExceedsTenMinutes: projectedPeakTotalMs >= TEN_MINUTES_MS,
    });

    console.log(`STEP16_BUILD_CLOCK=${clock}`);
    console.log(`STEP16_PAYLOAD_GENERATION_MS=${payloadGenerationMs.toFixed(3)}`);
    console.log(`STEP16_PAGE_GENERATION_MS=${pageGenerationMs.toFixed(3)}`);
    console.log(`STEP16_TOTAL_WALL_MS=${totalWallMs.toFixed(3)}`);
    console.log(`STEP16_PAGES_BUILT=${pagesBuilt}`);
    console.log(`STEP25_TOURNAMENT_PAGES_BUILT=${tournamentPages}`);
    console.log(`STEP26_HERO_PAGES_BUILT=${heroPages}`);
    console.log(`STEP27_TEAM_PAGES_BUILT=${teamPages}`);
    console.log(`STEP16_MEAN_MS_PER_PAGE=${meanMsPerPage.toFixed(3)}`);
    console.log(`STEP16_PEAK_PROJECTION=${JSON.stringify({
      peakRecentMatches: PEAK_RECENT_MATCHES,
      peakPages,
      projectedPageGenerationMs: Number(projectedPeakPageMs.toFixed(3)),
      projectedTotalWallMs: Number(projectedPeakTotalMs.toFixed(3)),
      tenMinuteHeadroomMs: Number((TEN_MINUTES_MS - projectedPeakTotalMs).toFixed(3)),
      tenMinuteHeadroomPercent: Number((((TEN_MINUTES_MS - projectedPeakTotalMs) / TEN_MINUTES_MS) * 100).toFixed(3)),
      cloudflareHeadroomMs: Number((TWENTY_MINUTES_MS - projectedPeakTotalMs).toFixed(3)),
      cloudflareHeadroomPercent: Number((((TWENTY_MINUTES_MS - projectedPeakTotalMs) / TWENTY_MINUTES_MS) * 100).toFixed(3)),
    })}`);
    console.log(`STEP16_BUILD_ASSERTIONS=${JSON.stringify(assertions)}`);
    console.log(`STEP16_BUILD_WARNINGS=${JSON.stringify(warnings)}`);
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error('Step 16 build assertions failed');
    }
    console.log('STEP16_BUILD_STATUS=PASS');
  }
} finally {
  await rm(scratchRoot, { recursive: true, force: true });
}
