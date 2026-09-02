import {
  lateShards,
  monthShards,
  readableShards,
  regularShards,
  windowShards,
} from './catalog.mjs';
import { buildClockEpoch, trailingWindow, utcMonthFromEpoch } from './clock.mjs';
import { openDuckDB, queryRows, sourceUnionSql } from './duckdb.mjs';
import {
  DRAFT_COLUMNS,
  HOME_COLUMNS,
  MATCH_COLUMNS,
  PLAYER_COLUMNS,
} from './schema.mjs';

function validateMatchId(matchId) {
  if (!Number.isSafeInteger(matchId) || matchId <= 0) {
    throw new TypeError('match id must be a positive safe integer');
  }
}

function shardNames(shards) {
  return shards.map((shard) => `${shard.table}/${shard.name}`);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeHomeTiers(tiers) {
  if (tiers === null || tiers === undefined) {
    return null;
  }
  if (!Array.isArray(tiers)) {
    throw new TypeError('home tiers must be an array or null for all tiers');
  }
  for (const tier of tiers) {
    if (tier !== null && typeof tier !== 'string') {
      throw new TypeError('home tier values must be strings or null');
    }
  }
  return Object.freeze([...new Set(tiers)]);
}

function tierPredicate(tiers) {
  if (tiers === null) {
    return null;
  }
  if (tiers.length === 0) {
    return 'FALSE';
  }
  const values = tiers.filter((tier) => tier !== null);
  const clauses = [];
  if (values.length > 0) {
    clauses.push(`league_tier IN (${values.map(sqlString).join(', ')})`);
  }
  if (tiers.includes(null)) {
    clauses.push('league_tier IS NULL');
  }
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`;
}

function homeWhere(endEpoch, tiers, startEpoch = null) {
  const clauses = [`start_time < ${endEpoch}`];
  if (startEpoch !== null) {
    clauses.unshift(`start_time >= ${startEpoch}`);
  }
  const selectedTierPredicate = tierPredicate(tiers);
  if (selectedTierPredicate) {
    clauses.push(selectedTierPredicate);
  }
  return `WHERE ${clauses.join(' AND ')}`;
}

function tierIsSelected(tier, selectedTiers) {
  return selectedTiers === null || selectedTiers.includes(tier);
}

function sortedTiers(tiers) {
  return [...tiers].sort((left, right) => {
    if (left === null) return 1;
    if (right === null) return -1;
    return left.localeCompare(right);
  });
}

async function selectRows(connection, shards, table, columns, suffix = '') {
  if (shards.length === 0) {
    return [];
  }
  return queryRows(
    connection,
    `SELECT * FROM (\n${sourceUnionSql(shards, table, columns)}\n) AS shard_rows\n${suffix}`,
  );
}

export class DataReader {
  static async create(catalog) {
    const database = await openDuckDB();
    return new DataReader(catalog, database);
  }

  constructor(catalog, database) {
    this.catalog = catalog;
    this.database = database;
    this.homeTiers = null;
  }

  close() {
    this.database.close();
  }

  async availableHomeTiers() {
    if (this.homeTiers !== null) {
      return this.homeTiers;
    }
    const shards = readableShards(this.catalog, 'matches');
    const rows = await selectRows(
      this.database.connection,
      shards,
      'matches',
      ['league_tier'],
    );
    this.homeTiers = Object.freeze(sortedTiers(new Set(rows.map((row) => row.league_tier))));
    return this.homeTiers;
  }

  async home({ limit = 100, tiers = null, clock = new Date() } = {}) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new TypeError('home limit must be a positive integer');
    }

    const endEpoch = buildClockEpoch(clock);
    const selectedTiers = normalizeHomeTiers(tiers);

    const regular = regularShards(this.catalog, 'matches')
      .filter((shard) => shard.startEpoch < endEpoch)
      .sort((left, right) => right.month.localeCompare(left.month));
    const selected = [...lateShards(this.catalog, 'matches')];
    let rows = [];

    for (const [index, shard] of regular.entries()) {
      selected.push(shard);
      rows = await selectRows(
        this.database.connection,
        selected,
        'matches',
        HOME_COLUMNS,
        `${homeWhere(endEpoch, selectedTiers)} `
          + `ORDER BY start_time DESC, match_id DESC LIMIT ${limit}`,
      );
      const nextOlderShard = regular[index + 1];
      const oldestSelectedStart = rows.at(-1)?.start_time;
      if (
        rows.length >= limit
        && (!nextOlderShard || oldestSelectedStart >= nextOlderShard.endEpoch)
      ) {
        break;
      }
    }

    if (regular.length === 0 && selected.length > 0) {
      rows = await selectRows(
        this.database.connection,
        selected,
        'matches',
        HOME_COLUMNS,
        `${homeWhere(endEpoch, selectedTiers)} `
          + `ORDER BY start_time DESC, match_id DESC LIMIT ${limit}`,
      );
    }

    const startEpoch = rows.at(-1)?.start_time ?? endEpoch;
    const rangeRows = rows.length === 0
      ? []
      : await selectRows(
        this.database.connection,
        selected,
        'matches',
        ['start_time', 'league_tier'],
        homeWhere(endEpoch, null, startEpoch),
      );
    const tierCounts = new Map();
    for (const row of rangeRows) {
      tierCounts.set(row.league_tier, (tierCounts.get(row.league_tier) ?? 0) + 1);
    }
    const tierCountRows = Object.freeze(
      sortedTiers(tierCounts.keys()).map((tier) => Object.freeze({
        tier,
        count: tierCounts.get(tier),
      })),
    );
    const hiddenCount = tierCountRows.reduce(
      (count, entry) => count + (tierIsSelected(entry.tier, selectedTiers) ? 0 : entry.count),
      0,
    );

    return Object.freeze({
      rows,
      sources: Object.freeze(shardNames(selected)),
      selectedTiers,
      availableTiers: await this.availableHomeTiers(),
      tierCounts: tierCountRows,
      hiddenCount,
      range: Object.freeze({ startEpoch, endEpoch }),
    });
  }

  async detail(matchId) {
    validateMatchId(matchId);
    // Write-time deduplication should make overlap unreachable, but regular REST rows must
    // still take precedence over SQL-backfilled late rows if duplicate data is encountered.
    const candidates = [
      ...regularShards(this.catalog, 'matches').sort(
        (left, right) => right.month.localeCompare(left.month),
      ),
      ...lateShards(this.catalog, 'matches'),
    ];
    const scanned = [];
    let match = null;

    for (const shard of candidates) {
      scanned.push(shard);
      const rows = await selectRows(
        this.database.connection,
        [shard],
        'matches',
        MATCH_COLUMNS,
        `WHERE match_id = ${matchId} LIMIT 1`,
      );
      if (rows.length === 1) {
        match = rows[0];
        break;
      }
    }

    if (!match) {
      return null;
    }

    const month = utcMonthFromEpoch(match.start_time);
    const playerSources = monthShards(this.catalog, 'players', month);
    const draftSources = monthShards(this.catalog, 'draft', month);
    const [players, draft] = await Promise.all([
      selectRows(
        this.database.connection,
        playerSources,
        'players',
        PLAYER_COLUMNS,
        `WHERE match_id = ${matchId} ORDER BY player_slot`,
      ),
      selectRows(
        this.database.connection,
        draftSources,
        'draft',
        DRAFT_COLUMNS,
        `WHERE match_id = ${matchId} ORDER BY ord`,
      ),
    ]);

    return Object.freeze({
      match,
      players,
      draft,
      sources: Object.freeze({
        matches: Object.freeze(shardNames(scanned)),
        players: Object.freeze(shardNames(playerSources)),
        draft: Object.freeze(shardNames(draftSources)),
      }),
    });
  }

  async window({ clock, days }) {
    const range = trailingWindow(clock, days);
    const sources = windowShards(
      this.catalog,
      'matches',
      range.startEpoch,
      range.endEpoch,
    );
    const rows = await selectRows(
      this.database.connection,
      sources,
      'matches',
      ['match_id', 'start_time', 'league_tier'],
      `WHERE start_time >= ${range.startEpoch} AND start_time < ${range.endEpoch}`,
    );
    const tiers = {};
    for (const row of rows) {
      const tier = row.league_tier ?? 'null';
      tiers[tier] = (tiers[tier] ?? 0) + 1;
    }

    return Object.freeze({
      ...range,
      count: rows.length,
      tiers: Object.freeze(tiers),
      sources: Object.freeze(shardNames(sources)),
    });
  }

  async windows({ clock, days = [30, 90, 180] }) {
    const results = [];
    for (const windowDays of days) {
      results.push(await this.window({ clock, days: windowDays }));
    }
    return results;
  }
}
