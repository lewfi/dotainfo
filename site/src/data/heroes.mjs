import { buildDataPaths } from '../build-context.mjs';
import { createHeroCollection } from '../presentation/heroes.mjs';
import { createCatalog, readableShards } from './catalog.mjs';
import { openDuckDB, queryRows, sourceUnionSql } from './duckdb.mjs';
import { loadReferenceRows } from './references.mjs';

const MATCH_COLUMNS = Object.freeze(['match_id', 'start_time', 'radiant_win', 'patch']);
const DRAFT_COLUMNS = Object.freeze(['match_id', 'is_pick', 'hero_id', 'team']);
const PLAYER_COLUMNS = Object.freeze(['match_id', 'hero_id', 'lane_role']);

function source(catalog, table, columns) {
  const shards = readableShards(catalog, table);
  if (shards.length === 0) throw new Error(`hero statistics require readable ${table} shards`);
  return sourceUnionSql(shards, table, columns);
}

export async function loadHeroCollection({ dataRoot, referenceRoot } = {}) {
  const catalog = await createCatalog(dataRoot ? { dataRoot } : undefined);
  const matches = source(catalog, 'matches', MATCH_COLUMNS);
  const draft = source(catalog, 'draft', DRAFT_COLUMNS);
  const players = source(catalog, 'players', PLAYER_COLUMNS);
  const database = await openDuckDB();
  let aggregates;
  try {
    const [global] = await queryRows(database.connection, `
      WITH all_matches AS (${matches}), all_draft AS (${draft})
      SELECT
        (SELECT count(*) FROM all_matches) AS total_matches,
        count(DISTINCT match_id) AS draft_match_count,
        count(*) AS total_draft_rows,
        count(*) FILTER (WHERE is_pick) AS total_picks,
        count(*) FILTER (WHERE NOT is_pick) AS total_bans
      FROM all_draft
    `);
    const heroDraft = await queryRows(database.connection, `
      WITH all_matches AS (${matches}), all_draft AS (${draft})
      SELECT
        d.hero_id,
        count(*) FILTER (WHERE d.is_pick) AS pick_count,
        count(*) FILTER (WHERE NOT d.is_pick) AS ban_count,
        count(*) FILTER (WHERE d.is_pick AND m.radiant_win IS NOT NULL) AS win_eligible_picks,
        count(*) FILTER (
          WHERE d.is_pick AND m.radiant_win IS NOT NULL
            AND ((d.team = 0 AND m.radiant_win) OR (d.team = 1 AND NOT m.radiant_win))
        ) AS wins
      FROM all_draft AS d
      LEFT JOIN all_matches AS m USING (match_id)
      GROUP BY d.hero_id
    `);
    const patches = await queryRows(database.connection, `
      WITH all_matches AS (${matches}), all_draft AS (${draft})
      SELECT m.patch, count(DISTINCT d.match_id) AS draft_match_count, min(m.start_time) AS first_start
      FROM all_draft AS d
      LEFT JOIN all_matches AS m USING (match_id)
      GROUP BY m.patch
      ORDER BY first_start, m.patch
    `);
    const heroPatches = await queryRows(database.connection, `
      WITH all_matches AS (${matches}), all_draft AS (${draft})
      SELECT
        d.hero_id,
        m.patch,
        count(*) FILTER (WHERE d.is_pick) AS pick_count,
        count(*) FILTER (WHERE NOT d.is_pick) AS ban_count,
        count(*) FILTER (WHERE d.is_pick AND m.radiant_win IS NOT NULL) AS win_eligible_picks,
        count(*) FILTER (
          WHERE d.is_pick AND m.radiant_win IS NOT NULL
            AND ((d.team = 0 AND m.radiant_win) OR (d.team = 1 AND NOT m.radiant_win))
        ) AS wins
      FROM all_draft AS d
      LEFT JOIN all_matches AS m USING (match_id)
      GROUP BY d.hero_id, m.patch
    `);
    const lanes = await queryRows(database.connection, `
      WITH all_players AS (${players})
      SELECT hero_id, lane_role, count(*) AS appearances
      FROM all_players
      GROUP BY hero_id, lane_role
    `);
    aggregates = { global, heroDraft, patches, heroPatches, lanes };
  } finally {
    database.close();
  }
  const references = await loadReferenceRows({
    ...(referenceRoot ? { referenceRoot } : {}),
    kinds: ['heroes'],
  });
  return createHeroCollection(references.heroes, aggregates);
}

let defaultCollectionPromise;

export function heroCollection() {
  defaultCollectionPromise ??= loadHeroCollection(buildDataPaths());
  return defaultCollectionPromise;
}
