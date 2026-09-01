import { regularShards } from './catalog.mjs';
import { queryRows, sourceUnionSql } from './duckdb.mjs';

export const EXPECTED_SEALED_AUDIT = Object.freeze({
  months: 67,
  matches: 146_875,
  bytes: 75_620_523,
  tiers: Object.freeze({
    professional: 110_786,
    premium: 12_718,
    excluded: 23_371,
  }),
  matchesWithoutDraft: 1_367,
  playerRowCountAnomalies: 1,
  duplicateMatchIdsWithinMonths: 0,
  duplicateMatchIdsAcrossMonths: 0,
});

function parquetShards(catalog, table) {
  return regularShards(catalog, table, { format: 'parquet' });
}

function ensureAlignedMonths(shardsByTable) {
  const matchMonths = shardsByTable.matches.map((shard) => shard.month);
  for (const table of ['players', 'draft']) {
    const months = shardsByTable[table].map((shard) => shard.month);
    if (JSON.stringify(months) !== JSON.stringify(matchMonths)) {
      throw new Error(`sealed ${table} months do not align with matches`);
    }
  }
  return matchMonths;
}

export async function auditSealedData(catalog, connection) {
  const shards = {
    matches: parquetShards(catalog, 'matches'),
    players: parquetShards(catalog, 'players'),
    draft: parquetShards(catalog, 'draft'),
  };
  const months = ensureAlignedMonths(shards);
  const bytes = Object.values(shards)
    .flat()
    .reduce((total, shard) => total + shard.bytes, 0);

  const matchesSql = sourceUnionSql(shards.matches, 'matches', ['match_id', 'league_tier']);
  const playersSql = sourceUnionSql(shards.players, 'players', ['match_id']);
  const draftSql = sourceUnionSql(shards.draft, 'draft', ['match_id']);

  const [matchSummary] = await queryRows(connection, `
    SELECT
      count(*) AS matches,
      count(*) FILTER (WHERE league_tier = 'professional') AS professional,
      count(*) FILTER (WHERE league_tier = 'premium') AS premium,
      count(*) FILTER (WHERE league_tier = 'excluded') AS excluded
    FROM (${matchesSql})
  `);

  const [draftSummary] = await queryRows(connection, `
    SELECT count(*) AS matches_without_draft
    FROM (${matchesSql}) AS matches
    WHERE NOT EXISTS (
      SELECT 1 FROM (${draftSql}) AS draft WHERE draft.match_id = matches.match_id
    )
  `);

  const [playerSummary] = await queryRows(connection, `
    SELECT count(*) AS anomalies
    FROM (${matchesSql}) AS matches
    LEFT JOIN (
      SELECT match_id, count(*) AS player_rows
      FROM (${playersSql})
      GROUP BY match_id
    ) AS player_counts USING (match_id)
    WHERE coalesce(player_rows, 0) <> 10
  `);

  const matchIdsByMonth = shards.matches.map((shard) => `
    SELECT match_id, '${shard.month}' AS month
    FROM (${sourceUnionSql([shard], 'matches', ['match_id'])})
  `);
  const duplicateByMonthBranches = matchIdsByMonth.map((branch) => `
    SELECT count(*) - count(DISTINCT match_id) AS duplicates FROM (${branch})
  `);
  const [withinSummary] = await queryRows(connection, `
    SELECT coalesce(sum(duplicates), 0) AS duplicate_within
    FROM (${duplicateByMonthBranches.join('\nUNION ALL\n')})
  `);
  const [acrossSummary] = await queryRows(connection, `
    SELECT count(*) AS duplicate_across
    FROM (
      SELECT match_id
      FROM (${matchIdsByMonth.join('\nUNION ALL\n')})
      GROUP BY match_id
      HAVING count(DISTINCT month) > 1
    )
  `);

  return Object.freeze({
    months: months.length,
    matches: matchSummary.matches,
    bytes,
    tiers: Object.freeze({
      professional: matchSummary.professional,
      premium: matchSummary.premium,
      excluded: matchSummary.excluded,
    }),
    matchesWithoutDraft: draftSummary.matches_without_draft,
    playerRowCountAnomalies: playerSummary.anomalies,
    duplicateMatchIdsWithinMonths: withinSummary.duplicate_within,
    duplicateMatchIdsAcrossMonths: acrossSummary.duplicate_across,
  });
}

export function sealedAuditDifferences(actual) {
  const differences = [];
  for (const key of [
    'months',
    'matches',
    'bytes',
    'matchesWithoutDraft',
    'playerRowCountAnomalies',
    'duplicateMatchIdsWithinMonths',
    'duplicateMatchIdsAcrossMonths',
  ]) {
    if (actual[key] !== EXPECTED_SEALED_AUDIT[key]) {
      differences.push(`${key}: expected ${EXPECTED_SEALED_AUDIT[key]}, got ${actual[key]}`);
    }
  }
  for (const tier of ['professional', 'premium', 'excluded']) {
    if (actual.tiers[tier] !== EXPECTED_SEALED_AUDIT.tiers[tier]) {
      differences.push(
        `tiers.${tier}: expected ${EXPECTED_SEALED_AUDIT.tiers[tier]}, got ${actual.tiers[tier]}`,
      );
    }
  }
  return differences;
}
