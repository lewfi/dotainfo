import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDuckDB, queryRows } from './duckdb.mjs';
import { ReferenceResolver } from '../presentation/reference-model.mjs';

export { HERO_ICON_BASE_URL, ReferenceResolver } from '../presentation/reference-model.mjs';

const DEFAULT_REFERENCE_ROOT = fileURLToPath(new URL('../../../data/reference/', import.meta.url));
const REFERENCE_FILES = Object.freeze({
  teams: Object.freeze({
    filename: 'teams.parquet',
    columns: Object.freeze(['team_id', 'name', 'tag', 'logo_url']),
  }),
  leagues: Object.freeze({
    filename: 'leagues.parquet',
    columns: Object.freeze(['leagueid', 'name', 'tier', 'banner']),
  }),
  players: Object.freeze({
    filename: 'players.parquet',
    columns: Object.freeze([
      'account_id',
      'name',
      'country_code',
      'fantasy_role',
      'team_id',
      'team_name',
      'team_tag',
      'is_pro',
    ]),
  }),
  heroes: Object.freeze({
    filename: 'heroes.parquet',
    columns: Object.freeze([
      'id',
      'name',
      'localized_name',
      'primary_attr',
      'attack_type',
      'roles',
    ]),
  }),
});

function sqlString(value) {
  return `'${String(value).replaceAll('\\', '/').replaceAll("'", "''")}'`;
}

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function readReference(connection, referenceRoot, definition) {
  const projection = definition.columns.map(sqlIdentifier).join(', ');
  const filePath = path.join(referenceRoot, definition.filename);
  return queryRows(connection, `SELECT ${projection} FROM read_parquet(${sqlString(filePath)})`);
}

export async function loadReferenceRows({
  referenceRoot = DEFAULT_REFERENCE_ROOT,
  kinds = Object.keys(REFERENCE_FILES),
  columns = {},
} = {}) {
  const resolvedRoot = path.resolve(referenceRoot);
  const database = await openDuckDB();
  try {
    const rows = {};
    for (const kind of kinds) {
      const definition = REFERENCE_FILES[kind];
      if (!definition) throw new TypeError(`unknown reference kind: ${kind}`);
      const selectedColumns = columns[kind] ?? definition.columns;
      if (
        !Array.isArray(selectedColumns)
        || selectedColumns.length === 0
        || selectedColumns.some((column) => !definition.columns.includes(column))
      ) {
        throw new TypeError(`invalid ${kind} reference projection`);
      }
      rows[kind] = await readReference(database.connection, resolvedRoot, {
        ...definition,
        columns: selectedColumns,
      });
    }
    return rows;
  } finally {
    database.close();
  }
}

export async function loadReferences({ referenceRoot = DEFAULT_REFERENCE_ROOT } = {}) {
  return new ReferenceResolver(await loadReferenceRows({ referenceRoot }));
}
