import { buildDataPaths } from '../build-context.mjs';
import { createTeamCollection } from '../presentation/teams.mjs';
import { createCatalog, readableShards } from './catalog.mjs';
import { openDuckDB, queryRows, sourceUnionSql } from './duckdb.mjs';
import { loadReferenceRows } from './references.mjs';

const MATCH_COLUMNS = Object.freeze([
  'match_id',
  'start_time',
  'leagueid',
  'league_name',
  'radiant_team_id',
  'dire_team_id',
  'radiant_team_name',
  'dire_team_name',
  'radiant_win',
  'radiant_score',
  'dire_score',
]);
const PLAYER_COLUMNS = Object.freeze(['match_id', 'is_radiant', 'hero_id']);

function source(catalog, table, columns) {
  const shards = readableShards(catalog, table);
  if (shards.length === 0) throw new Error(`team pages require readable ${table} shards`);
  return sourceUnionSql(shards, table, columns);
}

export async function loadTeamCollection({ dataRoot, referenceRoot } = {}) {
  const catalog = await createCatalog(dataRoot ? { dataRoot } : undefined);
  const matches = source(catalog, 'matches', MATCH_COLUMNS);
  const players = source(catalog, 'players', PLAYER_COLUMNS);
  const database = await openDuckDB();
  let matchRows;
  let heroAppearances;
  try {
    matchRows = await queryRows(database.connection, `
      SELECT * FROM (${matches}) AS all_matches
      ORDER BY start_time DESC, match_id DESC
    `);
    heroAppearances = await queryRows(database.connection, `
      WITH all_matches AS (${matches}), all_players AS (${players})
      SELECT
        CASE
          WHEN p.is_radiant = true THEN m.radiant_team_id
          WHEN p.is_radiant = false THEN m.dire_team_id
          ELSE NULL
        END AS team_id,
        p.hero_id,
        count(*) AS appearances
      FROM all_players AS p
      INNER JOIN all_matches AS m USING (match_id)
      WHERE CASE
        WHEN p.is_radiant = true THEN m.radiant_team_id
        WHEN p.is_radiant = false THEN m.dire_team_id
        ELSE NULL
      END IS NOT NULL
      GROUP BY team_id, p.hero_id
    `);
  } finally {
    database.close();
  }
  const references = await loadReferenceRows({
    ...(referenceRoot ? { referenceRoot } : {}),
    kinds: ['teams', 'leagues', 'heroes'],
  });
  return createTeamCollection(matchRows, heroAppearances, references);
}

let defaultCollectionPromise;

export function teamCollection() {
  defaultCollectionPromise ??= loadTeamCollection(buildDataPaths());
  return defaultCollectionPromise;
}
