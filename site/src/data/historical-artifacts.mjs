import { buildDataPaths } from '../build-context.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCatalog, regularShards } from './catalog.mjs';
import { openDuckDB, queryRows, sourceUnionSql } from './duckdb.mjs';
import { loadReferenceRows } from './references.mjs';
import { MATCH_COLUMNS } from './schema.mjs';

export const HISTORICAL_MATCH_COLUMNS = Object.freeze(
  MATCH_COLUMNS.filter((column) => !['radiant_gold_adv', 'radiant_xp_adv'].includes(column)),
);

const payloadPromises = new Map();
let shardsPromise;
let manifestPromise;
let referenceRowsPromise;

export function serializeArtifact(value) {
  return `${JSON.stringify(value)}\n`;
}

async function pregeneratedArtifact(filename) {
  const root = process.env.DOTAINFO_PREGENERATED_ARTIFACT_ROOT;
  if (!root) return null;
  return readFile(path.join(path.resolve(root), filename), 'utf8');
}

export async function historicalMatchShards() {
  if (!shardsPromise) {
    shardsPromise = (async () => {
      const { dataRoot } = buildDataPaths();
      const catalog = await createCatalog({ dataRoot });
      return Object.freeze(
        regularShards(catalog, 'matches').sort((left, right) => left.month.localeCompare(right.month)),
      );
    })();
  }
  return shardsPromise;
}

export async function historicalMonthPayload(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new TypeError('invalid historical month');
  if (!payloadPromises.has(month)) {
    payloadPromises.set(month, (async () => {
      const shard = (await historicalMatchShards()).find((candidate) => candidate.month === month);
      if (!shard) throw new Error(`no committed match shard for ${month}`);
      const database = await openDuckDB();
      try {
        const rows = await queryRows(
          database.connection,
          `SELECT * FROM (${sourceUnionSql([shard], 'matches', HISTORICAL_MATCH_COLUMNS)}) `
            + 'ORDER BY match_id',
        );
        return Object.freeze({ month, matches: Object.freeze(rows) });
      } finally {
        database.close();
      }
    })());
  }
  return payloadPromises.get(month);
}

export async function historicalMonthArtifact(month) {
  return await pregeneratedArtifact(`${month}.json`)
    ?? serializeArtifact(await historicalMonthPayload(month));
}

export async function historicalManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const ranges = [];
      for (const shard of await historicalMatchShards()) {
        const payload = await historicalMonthPayload(shard.month);
        const ids = payload.matches.map((match) => match.match_id);
        if (ids.length === 0) continue;
        ranges.push(Object.freeze({
          month: shard.month,
          min_match_id: Math.min(...ids),
          max_match_id: Math.max(...ids),
        }));
      }
      return Object.freeze({ ranges: Object.freeze(ranges) });
    })();
  }
  return manifestPromise;
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
      const rows = await loadReferenceRows({ referenceRoot, kinds: ['teams', 'leagues'] });
      return Object.freeze({
        teams: Object.freeze(rows.teams),
        leagues: Object.freeze(rows.leagues),
      });
    })();
  }
  return referenceRowsPromise;
}
