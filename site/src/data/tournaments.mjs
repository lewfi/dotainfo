import { createCatalog, readableShards } from './catalog.mjs';
import { openDuckDB, queryRows, sourceUnionSql } from './duckdb.mjs';
import { loadReferenceRows } from './references.mjs';
import { createTournamentCollection } from '../presentation/tournaments.mjs';
import { buildDataPaths } from '../build-context.mjs';

const MATCH_COLUMNS = Object.freeze([
  'match_id',
  'start_time',
  'leagueid',
  'league_name',
  'league_tier',
  'series_id',
  'series_type',
  'radiant_team_id',
  'dire_team_id',
  'radiant_team_name',
  'dire_team_name',
  'radiant_win',
  'radiant_score',
  'dire_score',
]);

export async function loadTournamentCollection({ dataRoot, referenceRoot } = {}) {
  const catalog = await createCatalog(dataRoot ? { dataRoot } : undefined);
  const shards = readableShards(catalog, 'matches');
  if (shards.length === 0) return createTournamentCollection([], { teams: [], leagues: [] });
  const database = await openDuckDB();
  let matchRows;
  try {
    matchRows = await queryRows(
      database.connection,
      `SELECT * FROM (\n${sourceUnionSql(shards, 'matches', MATCH_COLUMNS)}\n) AS all_matches `
        + 'ORDER BY start_time DESC, match_id DESC',
    );
  } finally {
    database.close();
  }
  const referenceRows = await loadReferenceRows({
    ...(referenceRoot ? { referenceRoot } : {}),
    kinds: ['teams', 'leagues'],
  });
  return createTournamentCollection(matchRows, referenceRows);
}

let defaultCollectionPromise;

export function tournamentCollection() {
  defaultCollectionPromise ??= loadTournamentCollection(buildDataPaths());
  return defaultCollectionPromise;
}
