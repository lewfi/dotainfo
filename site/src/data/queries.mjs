import {
  lateShards,
  monthShards,
  regularShards,
  windowShards,
} from './catalog.mjs';
import { trailingWindow, utcMonthFromEpoch } from './clock.mjs';
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

async function selectRows(connection, shards, table, columns, suffix = '') {
  if (shards.length === 0) {
    return [];
  }
  return queryRows(connection, `${sourceUnionSql(shards, table, columns)}\n${suffix}`);
}

export class DataReader {
  static async create(catalog) {
    const database = await openDuckDB();
    return new DataReader(catalog, database);
  }

  constructor(catalog, database) {
    this.catalog = catalog;
    this.database = database;
  }

  close() {
    this.database.close();
  }

  async home({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new TypeError('home limit must be a positive integer');
    }

    const regular = regularShards(this.catalog, 'matches').sort(
      (left, right) => right.month.localeCompare(left.month),
    );
    const selected = [...lateShards(this.catalog, 'matches')];
    let rows = [];

    for (const [index, shard] of regular.entries()) {
      selected.push(shard);
      rows = await selectRows(
        this.database.connection,
        selected,
        'matches',
        HOME_COLUMNS,
        `ORDER BY start_time DESC, match_id DESC LIMIT ${limit}`,
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
        `ORDER BY start_time DESC, match_id DESC LIMIT ${limit}`,
      );
    }

    return Object.freeze({ rows, sources: Object.freeze(shardNames(selected)) });
  }

  async detail(matchId) {
    validateMatchId(matchId);
    const candidates = [
      ...lateShards(this.catalog, 'matches'),
      ...regularShards(this.catalog, 'matches').sort(
        (left, right) => right.month.localeCompare(left.month),
      ),
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
