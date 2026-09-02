import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

const DEFAULT_DATA_ROOT = fileURLToPath(new URL('../../../data/', import.meta.url));
const FACT_SHARD = /\.(?:parquet|ndjson)$/;

function sqlString(value) {
  return `'${String(value).replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function parseClock(clock) {
  if (typeof clock !== 'string' || !clock.endsWith('Z')) {
    throw new TypeError('direct recent-audit clock must be an ISO-8601 UTC instant ending in Z');
  }
  const milliseconds = Date.parse(clock);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('direct recent-audit clock must be a valid ISO-8601 UTC instant');
  }
  return Math.floor(milliseconds / 1000);
}

async function directUnion(dataRoot, table, columns) {
  const directory = path.join(dataRoot, table);
  const names = (await readdir(directory))
    .filter((name) => FACT_SHARD.test(name))
    .sort();
  const projection = columns.map(sqlIdentifier).join(', ');
  const branches = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    if ((await stat(filePath)).size === 0) continue;
    const source = name.endsWith('.parquet')
      ? `read_parquet(${sqlString(filePath)})`
      : `read_json_auto(${sqlString(filePath)}, format = 'newline_delimited')`;
    branches.push(`SELECT ${projection} FROM ${source}`);
  }
  if (branches.length === 0) {
    throw new Error(`direct recent audit found no readable ${table} shards`);
  }
  return Object.freeze({ sql: branches.join('\nUNION ALL\n'), shardsRead: names.length });
}

function plainRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'bigint' ? Number(value) : value,
  ]));
}

export async function directRecentComposition({
  clock,
  days = 90,
  dataRoot = DEFAULT_DATA_ROOT,
} = {}) {
  if (!Number.isInteger(days) || days <= 0) {
    throw new TypeError('direct recent-audit days must be a positive integer');
  }
  const endEpoch = parseClock(clock);
  const startEpoch = endEpoch - days * 86_400;
  const resolvedRoot = path.resolve(dataRoot);
  const [matches, draft, players] = await Promise.all([
    directUnion(resolvedRoot, 'matches', [
      'match_id',
      'start_time',
      'radiant_team_id',
      'dire_team_id',
      'radiant_team_name',
      'dire_team_name',
      'radiant_gold_adv',
      'radiant_xp_adv',
    ]),
    directUnion(resolvedRoot, 'draft', ['match_id']),
    directUnion(resolvedRoot, 'players', ['match_id']),
  ]);
  const database = await DuckDBInstance.create(':memory:');
  const connection = await database.connect();

  try {
    await connection.run(`CREATE TEMP VIEW all_matches AS ${matches.sql}`);
    await connection.run(`CREATE TEMP VIEW all_draft AS ${draft.sql}`);
    await connection.run(`CREATE TEMP VIEW all_players AS ${players.sql}`);
    const reader = await connection.runAndReadAll(`
      WITH window_matches AS (
        SELECT * FROM all_matches
        WHERE start_time >= ${startEpoch} AND start_time < ${endEpoch}
      ),
      drafted AS (
        SELECT DISTINCT match_id FROM all_draft
      ),
      player_counts AS (
        SELECT match_id, count(*) AS player_rows FROM all_players GROUP BY match_id
      )
      SELECT
        count(*) AS matches,
        count(*) FILTER (WHERE radiant_gold_adv IS NOT NULL) AS gold_present,
        count(*) FILTER (WHERE radiant_gold_adv IS NULL) AS gold_absent,
        count(*) FILTER (WHERE radiant_xp_adv IS NOT NULL) AS xp_present,
        count(*) FILTER (WHERE radiant_xp_adv IS NULL) AS xp_absent,
        count(*) FILTER (
          WHERE (radiant_gold_adv IS NULL) <> (radiant_xp_adv IS NULL)
        ) AS advantage_mask_mismatches,
        count(*) FILTER (
          WHERE radiant_team_id IS NULL OR dire_team_id IS NULL
        ) AS null_team_matches,
        count(*) FILTER (
          WHERE (
            radiant_team_id IS NOT NULL
            AND (radiant_team_name IS NULL OR trim(radiant_team_name) = '')
          ) OR (
            dire_team_id IS NOT NULL
            AND (dire_team_name IS NULL OR trim(dire_team_name) = '')
          )
        ) AS unusable_name_matches,
        count(*) FILTER (WHERE drafted.match_id IS NULL) AS zero_draft_matches,
        count(*) FILTER (WHERE coalesce(player_rows, 0) <> 10) AS non_ten_player_matches,
        min(coalesce(player_rows, 0)) AS min_player_rows,
        max(coalesce(player_rows, 0)) AS max_player_rows
      FROM window_matches
      LEFT JOIN drafted USING (match_id)
      LEFT JOIN player_counts USING (match_id)
    `);
    const [row] = reader.getRowObjects();
    return Object.freeze({
      days,
      startEpoch,
      endEpoch,
      ...plainRow(row),
      shardsRead: Object.freeze({
        matches: matches.shardsRead,
        draft: draft.shardsRead,
        players: players.shardsRead,
      }),
    });
  } finally {
    connection.closeSync();
  }
}
