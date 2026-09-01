import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FACT_TABLES = Object.freeze(['matches', 'players', 'draft']);

const MONTHLY_SHARD = /^(\d{4})-(\d{2})\.(parquet|ndjson)$/;
const DEFAULT_DATA_ROOT = fileURLToPath(new URL('../../../data/', import.meta.url));

function monthBounds(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const startEpoch = Date.UTC(year, monthNumber - 1, 1) / 1000;
  const endEpoch = Date.UTC(year, monthNumber, 1) / 1000;
  return { startEpoch, endEpoch };
}

async function discoverTable(dataRoot, table) {
  const directory = path.join(dataRoot, table);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const shards = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = MONTHLY_SHARD.exec(entry.name);
    const isLate = entry.name === 'late.ndjson';
    if (!match && !isLate) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    const fileStat = await stat(filePath);
    const month = match ? `${match[1]}-${match[2]}` : null;
    const bounds = month ? monthBounds(month) : { startEpoch: null, endEpoch: null };
    shards.push(Object.freeze({
      table,
      path: filePath,
      name: entry.name,
      month,
      format: match?.[3] ?? 'ndjson',
      isLate,
      bytes: fileStat.size,
      ...bounds,
    }));
  }

  return shards.sort((left, right) => left.name.localeCompare(right.name));
}

export async function createCatalog({ dataRoot = DEFAULT_DATA_ROOT } = {}) {
  const resolvedRoot = path.resolve(dataRoot);
  const discovered = await Promise.all(
    FACT_TABLES.map(async (table) => [table, await discoverTable(resolvedRoot, table)]),
  );

  return Object.freeze({
    dataRoot: resolvedRoot,
    tables: Object.freeze(Object.fromEntries(discovered)),
  });
}

export function readableShards(catalog, table) {
  return catalog.tables[table].filter((shard) => shard.bytes > 0);
}

export function regularShards(catalog, table, { format } = {}) {
  return readableShards(catalog, table).filter(
    (shard) => !shard.isLate && (!format || shard.format === format),
  );
}

export function lateShards(catalog, table) {
  return readableShards(catalog, table).filter((shard) => shard.isLate);
}

export function windowShards(catalog, table, startEpoch, endEpoch) {
  if (!Number.isInteger(startEpoch) || !Number.isInteger(endEpoch) || startEpoch >= endEpoch) {
    throw new TypeError('window cutoffs must be increasing integer epoch seconds');
  }

  return readableShards(catalog, table).filter(
    (shard) => shard.isLate || (shard.startEpoch < endEpoch && shard.endEpoch > startEpoch),
  );
}

export function monthShards(catalog, table, month) {
  return readableShards(catalog, table).filter(
    (shard) => shard.isLate || shard.month === month,
  );
}
