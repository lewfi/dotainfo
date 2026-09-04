export const SEARCH_INDEX_VERSION = 1;
export const SEARCH_INDEX_PATH = '/data/search-index.json';

function safeColumns(entries, fields) {
  const columns = Object.fromEntries(fields.map((field) => [field.key, []]));
  for (const entry of entries) {
    for (const field of fields) columns[field.key].push(field.value(entry));
  }
  const lengths = new Set(Object.values(columns).map((column) => column.length));
  if (lengths.size !== 1) throw new Error('search-index columns have different lengths');
  if (!columns.i.every((id) => Number.isSafeInteger(id))) {
    throw new TypeError('search-index ids must be safe integers');
  }
  return Object.freeze(Object.fromEntries(Object.entries(columns)
    .map(([key, column]) => [key, Object.freeze(column)])));
}

function titleDiscriminator(name, titleStem) {
  if (titleStem === name) return '';
  if (!titleStem.startsWith(name)) {
    throw new Error(`search title stem does not begin with its display name: ${titleStem}`);
  }
  return titleStem.slice(name.length).trim();
}

function collisionColumns(entries, name, titleStem) {
  const counts = new Map();
  for (const entry of entries) counts.set(name(entry), (counts.get(name(entry)) ?? 0) + 1);
  const collisions = entries.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => counts.get(name(entry)) > 1);
  return safeColumns(collisions, [
    { key: 'i', value: ({ index }) => index },
    { key: 'y', value: ({ entry }) => {
      const discriminator = titleDiscriminator(name(entry), titleStem(entry));
      const year = /^\((\d{4})\)$/.exec(discriminator)?.[1];
      return year ? Number(year) : 0;
    } },
  ]);
}

export function createSearchIndex({ teams, tournaments, heroes }) {
  const teamColumns = safeColumns(teams, [
    { key: 'i', value: (entry) => entry.teamId },
    { key: 'n', value: (entry) => entry.name.display },
    { key: 'g', value: (entry) => entry.tag ?? '' },
    { key: 'w', value: (entry) => entry.matchCount },
  ]);
  const tournamentColumns = safeColumns(tournaments, [
    { key: 'i', value: (entry) => entry.leagueId },
    { key: 'n', value: (entry) => entry.name },
  ]);
  const heroColumns = safeColumns(heroes, [
    { key: 'i', value: (entry) => entry.heroId },
    { key: 'n', value: (entry) => entry.name },
  ]);
  return Object.freeze({
    v: SEARCH_INDEX_VERSION,
    t: Object.freeze({
      ...teamColumns,
      c: collisionColumns(teams, (entry) => entry.name.display, (entry) => entry.titleStem),
    }),
    l: Object.freeze({
      ...tournamentColumns,
      c: collisionColumns(tournaments, (entry) => entry.name, (entry) => entry.titleStem),
    }),
    h: heroColumns,
  });
}
