import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDuckDB, queryRows } from './duckdb.mjs';

export const HERO_ICON_BASE_URL =
  'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/';

const DEFAULT_REFERENCE_ROOT = fileURLToPath(new URL('../../../data/reference/', import.meta.url));
const MISSING_LABELS = Object.freeze({
  team: 'Team name unavailable',
  league: 'League name unavailable',
  player: 'Player name unavailable',
  hero: 'Hero name unavailable',
  tier: 'Tier unavailable',
});
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

function cleanText(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeId(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function availableName(value, source) {
  return Object.freeze({ status: 'available', value, display: value, source });
}

function missingName(label) {
  return Object.freeze({ status: 'missing', value: null, display: label, source: null });
}

function resolveName(candidates, missingLabel) {
  for (const [value, source] of candidates) {
    const cleaned = cleanText(value);
    if (cleaned) {
      return availableName(cleaned, source);
    }
  }
  return missingName(missingLabel);
}

function resolveLogo(value) {
  const url = cleanText(value);
  return url
    ? Object.freeze({ status: 'available', url })
    : Object.freeze({ status: 'missing', url: null });
}

function heroIcon(machineName) {
  const cleaned = cleanText(machineName);
  const slug = cleaned?.replace(/^npc_dota_hero_/, '') ?? null;
  if (!slug || !/^[a-z0-9_]+$/.test(slug)) {
    return Object.freeze({ status: 'missing', url: null });
  }
  return Object.freeze({ status: 'available', url: `${HERO_ICON_BASE_URL}${slug}.png` });
}

function indexRows(rows, key) {
  const index = new Map();
  for (const row of rows) {
    const id = normalizeId(row[key]);
    if (id !== null && !index.has(id)) {
      index.set(id, Object.freeze({ ...row }));
    }
  }
  return index;
}

async function readReference(connection, referenceRoot, definition) {
  const projection = definition.columns.map(sqlIdentifier).join(', ');
  const filePath = path.join(referenceRoot, definition.filename);
  return queryRows(connection, `SELECT ${projection} FROM read_parquet(${sqlString(filePath)})`);
}

export class ReferenceResolver {
  #teams;

  #leagues;

  #players;

  #heroes;

  constructor({ teams = [], leagues = [], players = [], heroes = [] } = {}) {
    this.#teams = indexRows(teams, 'team_id');
    this.#leagues = indexRows(leagues, 'leagueid');
    this.#players = indexRows(players, 'account_id');
    this.#heroes = indexRows(heroes, 'id');
    this.counts = Object.freeze({
      teams: this.#teams.size,
      leagues: this.#leagues.size,
      players: this.#players.size,
      heroes: this.#heroes.size,
    });
  }

  ids(kind) {
    const indexes = {
      teams: this.#teams,
      leagues: this.#leagues,
      players: this.#players,
      heroes: this.#heroes,
    };
    const index = indexes[kind];
    if (!index) {
      throw new TypeError(`unknown reference kind: ${kind}`);
    }
    return Object.freeze([...index.keys()]);
  }

  resolveTeam({ teamId, denormalizedName = null } = {}) {
    const id = normalizeId(teamId);
    const reference = id === null ? null : this.#teams.get(id) ?? null;
    return Object.freeze({
      teamId: id,
      referenceFound: reference !== null,
      name: resolveName(
        [
          [reference?.name, 'reference-current'],
          [denormalizedName, 'match-write-time'],
          [reference?.tag, 'reference-tag'],
        ],
        MISSING_LABELS.team,
      ),
      logo: resolveLogo(reference?.logo_url),
      tag: cleanText(reference?.tag),
    });
  }

  resolveLeague({ leagueId, denormalizedName = null, leagueTier = null } = {}) {
    const id = normalizeId(leagueId);
    const reference = id === null ? null : this.#leagues.get(id) ?? null;
    return Object.freeze({
      leagueId: id,
      referenceFound: reference !== null,
      name: resolveName(
        [
          [reference?.name, 'reference-current'],
          [denormalizedName, 'match-write-time'],
        ],
        MISSING_LABELS.league,
      ),
      tier: resolveName(
        [
          [leagueTier, 'match-write-time'],
          [reference?.tier, 'reference-current'],
        ],
        MISSING_LABELS.tier,
      ),
      banner: resolveLogo(reference?.banner),
    });
  }

  resolvePlayer(accountId) {
    const id = normalizeId(accountId);
    const reference = id === null ? null : this.#players.get(id) ?? null;
    return Object.freeze({
      accountId: id,
      referenceFound: reference !== null,
      name: resolveName([[reference?.name, 'reference-current']], MISSING_LABELS.player),
      countryCode: cleanText(reference?.country_code),
      fantasyRole: reference?.fantasy_role ?? null,
      isPro: reference?.is_pro ?? null,
      team: reference
        ? this.resolveTeam({
            teamId: reference.team_id,
            denormalizedName: reference.team_name,
          })
        : null,
      teamTag: cleanText(reference?.team_tag),
    });
  }

  resolveHero(heroId) {
    const id = normalizeId(heroId);
    const reference = id === null ? null : this.#heroes.get(id) ?? null;
    return Object.freeze({
      heroId: id,
      referenceFound: reference !== null,
      name: resolveName(
        [
          [reference?.localized_name, 'reference-localized'],
          [reference?.name?.replace(/^npc_dota_hero_/, ''), 'reference-machine'],
        ],
        MISSING_LABELS.hero,
      ),
      machineName: cleanText(reference?.name),
      primaryAttribute: cleanText(reference?.primary_attr),
      attackType: cleanText(reference?.attack_type),
      roles: Object.freeze(Array.isArray(reference?.roles) ? [...reference.roles] : []),
      icon: heroIcon(reference?.name),
    });
  }
}

export async function loadReferences({ referenceRoot = DEFAULT_REFERENCE_ROOT } = {}) {
  const resolvedRoot = path.resolve(referenceRoot);
  const database = await openDuckDB();
  try {
    const rows = {};
    for (const [kind, definition] of Object.entries(REFERENCE_FILES)) {
      rows[kind] = await readReference(database.connection, resolvedRoot, definition);
    }
    return new ReferenceResolver(rows);
  } finally {
    database.close();
  }
}
