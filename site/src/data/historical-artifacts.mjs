import { buildDataPaths } from '../build-context.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCatalog, lateShards, regularShards } from './catalog.mjs';
import { openDuckDB, queryRows, sourceUnionSql } from './duckdb.mjs';
import { loadReferenceRows } from './references.mjs';
import { MATCH_COLUMNS } from './schema.mjs';

export const HISTORICAL_MATCH_COLUMNS = Object.freeze(
  MATCH_COLUMNS.filter((column) => !['radiant_gold_adv', 'radiant_xp_adv'].includes(column)),
);

const payloadPromises = new Map();
const catalogPromises = new Map();
const shardsPromises = new Map();
const lateShardPromises = new Map();
const lateCoveragePromises = new Map();
const manifestPromises = new Map();
let referenceRowsPromise;

const HISTORICAL_REFERENCE_MATCH_COLUMNS = Object.freeze([
  'radiant_team_id',
  'dire_team_id',
  'leagueid',
]);

export function serializeArtifact(value) {
  return `${JSON.stringify(value)}\n`;
}

async function pregeneratedArtifact(filename) {
  const root = process.env.DOTAINFO_PREGENERATED_ARTIFACT_ROOT;
  if (!root) return null;
  return readFile(path.join(path.resolve(root), filename), 'utf8');
}

function historicalDataRoot(options = {}) {
  return path.resolve(options.dataRoot ?? buildDataPaths().dataRoot);
}

function historicalCatalog(dataRoot) {
  if (!catalogPromises.has(dataRoot)) {
    catalogPromises.set(dataRoot, createCatalog({ dataRoot }));
  }
  return catalogPromises.get(dataRoot);
}

function startTimeMonth(startTime) {
  if (!Number.isSafeInteger(startTime)) {
    throw new TypeError(`late match has invalid start_time: ${startTime}`);
  }
  const date = new Date(startTime * 1_000);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`late match has invalid start_time: ${startTime}`);
  }
  return date.toISOString().slice(0, 7);
}

async function assertLateMonthsHaveRegularShards(dataRoot) {
  if (!lateCoveragePromises.has(dataRoot)) {
    lateCoveragePromises.set(dataRoot, (async () => {
      const [shards, lateShard] = await Promise.all([
        historicalMatchShards({ dataRoot }),
        historicalLateMatchShard({ dataRoot }),
      ]);
      if (!lateShard) return;

      const regularMonths = new Set(shards.map((shard) => shard.month));
      const rows = (await readFile(lateShard.path, 'utf8'))
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      const orphanMonths = [...new Set(rows.map((row) => startTimeMonth(row.start_time)))]
        .filter((month) => !regularMonths.has(month))
        .sort();
      if (orphanMonths.length > 0) {
        throw new Error(
          `late match month(s) have no regular shard: ${orphanMonths.join(', ')}`,
        );
      }
    })());
  }
  return lateCoveragePromises.get(dataRoot);
}

export async function historicalMatchShards(options = {}) {
  const dataRoot = historicalDataRoot(options);
  if (!shardsPromises.has(dataRoot)) {
    shardsPromises.set(dataRoot, (async () => {
      const catalog = await historicalCatalog(dataRoot);
      return Object.freeze(
        regularShards(catalog, 'matches').sort((left, right) => left.month.localeCompare(right.month)),
      );
    })());
  }
  return shardsPromises.get(dataRoot);
}

export async function historicalLateMatchShard(options = {}) {
  const dataRoot = historicalDataRoot(options);
  if (!lateShardPromises.has(dataRoot)) {
    lateShardPromises.set(dataRoot, (async () => {
      const shards = lateShards(await historicalCatalog(dataRoot), 'matches');
      if (shards.length > 1) throw new Error('multiple late match shards found');
      return shards[0] ?? null;
    })());
  }
  return lateShardPromises.get(dataRoot);
}

export async function historicalMonthPayload(month, options = {}) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new TypeError('invalid historical month');
  const dataRoot = historicalDataRoot(options);
  const cacheKey = `${dataRoot}\0${month}`;
  if (!payloadPromises.has(cacheKey)) {
    payloadPromises.set(cacheKey, (async () => {
      const [shards, lateShard] = await Promise.all([
        historicalMatchShards({ dataRoot }),
        historicalLateMatchShard({ dataRoot }),
      ]);
      await assertLateMonthsHaveRegularShards(dataRoot);
      const shard = shards.find((candidate) => candidate.month === month);
      if (!shard) throw new Error(`no committed match shard for ${month}`);
      const projection = HISTORICAL_MATCH_COLUMNS.map((column) => `"${column}"`).join(', ');
      const branches = [
        `SELECT ${projection}, 0 AS source_priority FROM (`
          + `${sourceUnionSql([shard], 'matches', HISTORICAL_MATCH_COLUMNS)})`,
      ];
      if (lateShard) {
        branches.push(
          `SELECT ${projection}, 1 AS source_priority FROM (`
            + `${sourceUnionSql([lateShard], 'matches', HISTORICAL_MATCH_COLUMNS)}) `
            + `WHERE start_time >= ${shard.startEpoch} AND start_time < ${shard.endEpoch}`,
        );
      }
      const database = await openDuckDB();
      try {
        const rows = await queryRows(
          database.connection,
          'WITH combined AS (' + branches.join('\nUNION ALL\n') + ') '
            + `SELECT ${projection} FROM combined `
            + 'QUALIFY row_number() OVER ('
            + 'PARTITION BY match_id ORDER BY source_priority'
            + ') = 1 ORDER BY match_id',
        );
        if (new Set(rows.map((row) => row.match_id)).size !== rows.length) {
          throw new Error(`historical payload contains duplicate match_id for ${month}`);
        }
        return Object.freeze({ month, matches: Object.freeze(rows) });
      } finally {
        database.close();
      }
    })());
  }
  return payloadPromises.get(cacheKey);
}

export async function historicalMonthArtifact(month) {
  return await pregeneratedArtifact(`${month}.json`)
    ?? serializeArtifact(await historicalMonthPayload(month));
}

export async function historicalManifest() {
  const dataRoot = historicalDataRoot();
  if (!manifestPromises.has(dataRoot)) {
    manifestPromises.set(dataRoot, (async () => {
      const ranges = [];
      for (const shard of await historicalMatchShards({ dataRoot })) {
        const payload = await historicalMonthPayload(shard.month, { dataRoot });
        const ids = payload.matches.map((match) => match.match_id);
        if (ids.length === 0) continue;
        ranges.push(Object.freeze({
          month: shard.month,
          min_match_id: Math.min(...ids),
          max_match_id: Math.max(...ids),
        }));
      }
      return Object.freeze({ ranges: Object.freeze(ranges) });
    })());
  }
  return manifestPromises.get(dataRoot);
}

export async function historicalManifestArtifact() {
  return await pregeneratedArtifact('manifest.json')
    ?? serializeArtifact(await historicalManifest());
}

export async function historicalSummaryReferenceRows() {
  if (!referenceRowsPromise) {
    referenceRowsPromise = (async () => {
      if (process.env.DOTAINFO_STEP14_FIXTURE_BUILD === '1') {
        return Object.freeze({ teams: [], leagues: [] });
      }
      const { referenceRoot } = buildDataPaths();
      const database = await openDuckDB();
      let referencedIds;
      try {
        const source = sourceUnionSql(
          await historicalMatchShards(),
          'matches',
          HISTORICAL_REFERENCE_MATCH_COLUMNS,
        );
        referencedIds = await queryRows(
          database.connection,
          'WITH match_references AS (' + source + ') '
            + "SELECT DISTINCT 'team' AS kind, radiant_team_id AS id FROM match_references "
            + 'WHERE radiant_team_id IS NOT NULL '
            + "UNION SELECT DISTINCT 'team' AS kind, dire_team_id AS id FROM match_references "
            + 'WHERE dire_team_id IS NOT NULL '
            + "UNION SELECT DISTINCT 'league' AS kind, leagueid AS id FROM match_references "
            + 'WHERE leagueid IS NOT NULL',
        );
      } finally {
        database.close();
      }
      const teamIds = new Set(
        referencedIds.filter((row) => row.kind === 'team').map((row) => row.id),
      );
      const leagueIds = new Set(
        referencedIds.filter((row) => row.kind === 'league').map((row) => row.id),
      );
      const rows = await loadReferenceRows({
        referenceRoot,
        kinds: ['teams', 'leagues'],
        columns: {
          teams: ['team_id', 'name', 'tag'],
          leagues: ['leagueid', 'name', 'tier'],
        },
      });
      return Object.freeze({
        teams: Object.freeze(rows.teams.filter((row) => teamIds.has(row.team_id))),
        leagues: Object.freeze(rows.leagues.filter((row) => leagueIds.has(row.leagueid))),
      });
    })();
  }
  return referenceRowsPromise;
}
