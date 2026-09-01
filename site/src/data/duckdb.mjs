import { DuckDBInstance } from '@duckdb/node-api';
import { TABLE_SCHEMAS } from './schema.mjs';

function sqlString(value) {
  return `'${String(value).replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function validateColumns(table, columns) {
  const schema = TABLE_SCHEMAS[table];
  if (!schema) {
    throw new TypeError(`unknown fact table: ${table}`);
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError('at least one projected column is required');
  }
  for (const column of columns) {
    if (!(column in schema)) {
      throw new TypeError(`unknown ${table} column: ${column}`);
    }
  }
}

function jsonColumns(table) {
  return `{${Object.entries(TABLE_SCHEMAS[table])
    .map(([name, type]) => `${sqlIdentifier(name)}: ${sqlString(type)}`)
    .join(', ')}}`;
}

function pathList(shards) {
  return `[${shards.map((shard) => sqlString(shard.path)).join(', ')}]`;
}

export function sourceUnionSql(shards, table, columns) {
  validateColumns(table, columns);
  if (!Array.isArray(shards) || shards.length === 0) {
    throw new TypeError('at least one readable shard is required');
  }

  const projection = columns.map(sqlIdentifier).join(', ');
  const parquet = shards.filter((shard) => shard.format === 'parquet');
  const ndjson = shards.filter((shard) => shard.format === 'ndjson');
  const branches = [];

  if (parquet.length > 0) {
    branches.push(
      `SELECT ${projection} FROM read_parquet(${pathList(parquet)}, union_by_name = true)`,
    );
  }
  if (ndjson.length > 0) {
    branches.push(
      `SELECT ${projection} FROM read_json(${pathList(ndjson)}, `
        + `format = 'newline_delimited', columns = ${jsonColumns(table)}, union_by_name = true)`,
    );
  }

  return branches.join('\nUNION ALL\n');
}

function plainValue(value) {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(plainValue);
  }
  if (
    value
    && typeof value === 'object'
    && Array.isArray(value.items)
    && Object.keys(value).length === 1
  ) {
    return value.items.map(plainValue);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, plainValue(nested)]));
  }
  return value;
}

export async function queryRows(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjects().map((row) => plainValue(row));
}

export async function openDuckDB() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  return Object.freeze({
    connection,
    close() {
      connection.closeSync();
    },
  });
}
