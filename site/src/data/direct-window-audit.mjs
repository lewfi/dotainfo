import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

const DEFAULT_MATCH_ROOT = fileURLToPath(new URL('../../../data/matches/', import.meta.url));
const MATCH_SHARD = /\.(?:parquet|ndjson)$/;

function sqlString(value) {
  return `'${String(value).replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

function parseClock(clock) {
  if (typeof clock !== 'string' || !clock.endsWith('Z')) {
    throw new TypeError('direct audit clock must be an ISO-8601 UTC instant ending in Z');
  }
  const milliseconds = Date.parse(clock);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('direct audit clock must be a valid ISO-8601 UTC instant');
  }
  return Math.floor(milliseconds / 1000);
}

function plainTier(value) {
  return value ?? 'null';
}

export async function directWindowAudit({
  clock,
  days = [30, 90, 180],
  matchRoot = DEFAULT_MATCH_ROOT,
} = {}) {
  const endEpoch = parseClock(clock);
  const directory = path.resolve(matchRoot);
  const names = (await readdir(directory))
    .filter((name) => MATCH_SHARD.test(name))
    .sort();
  const database = await DuckDBInstance.create(':memory:');
  const connection = await database.connect();
  const rows = [];

  try {
    for (const name of names) {
      const filePath = path.join(directory, name);
      if ((await stat(filePath)).size === 0) {
        continue;
      }
      const source = name.endsWith('.parquet')
        ? `read_parquet(${sqlString(filePath)})`
        : `read_json_auto(${sqlString(filePath)}, format = 'newline_delimited')`;
      const reader = await connection.runAndReadAll(
        `SELECT start_time, league_tier FROM ${source}`,
      );
      for (const row of reader.getRowObjects()) {
        rows.push(Object.freeze({
          startTime: Number(row.start_time),
          tier: plainTier(row.league_tier),
        }));
      }
    }
  } finally {
    connection.closeSync();
  }

  return days.map((windowDays) => {
    if (!Number.isInteger(windowDays) || windowDays <= 0) {
      throw new TypeError('direct audit window days must be positive integers');
    }
    const startEpoch = endEpoch - windowDays * 86_400;
    const tiers = {};
    let count = 0;
    for (const row of rows) {
      if (row.startTime < startEpoch || row.startTime >= endEpoch) {
        continue;
      }
      count += 1;
      tiers[row.tier] = (tiers[row.tier] ?? 0) + 1;
    }
    return Object.freeze({
      days: windowDays,
      startEpoch,
      endEpoch,
      count,
      tiers: Object.freeze(tiers),
      shardsRead: names.length,
    });
  });
}
