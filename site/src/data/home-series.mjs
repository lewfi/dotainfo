export const SERIES_SPLIT_SECONDS = 6 * 60 * 60;

function idPart(value) {
  return value === null || value === undefined ? 'null' : String(value);
}

function teamPair(row) {
  const ids = [row.radiant_team_id ?? null, row.dire_team_id ?? null];
  ids.sort((left, right) => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left - right;
  });
  return Object.freeze(ids);
}

function baseKey(row, pair) {
  return [row.series_id, row.leagueid, ...pair].map(idPart).join(':');
}

function freezeGroup(rows, pair, segment) {
  const first = rows[0];
  const last = rows.at(-1);
  const standalone = first.series_id === null || first.series_id === undefined;
  return Object.freeze({
    id: standalone
      ? `match-${first.match_id}`
      : `series-${baseKey(first, pair)}-${segment}-${first.match_id}`,
    kind: standalone ? 'standalone' : 'series',
    seriesId: standalone ? null : first.series_id,
    seriesType: standalone ? null : first.series_type ?? null,
    leagueId: first.leagueid ?? null,
    leagueTier: last.league_tier ?? null,
    teamPair: pair,
    startTime: first.start_time,
    endTime: last.start_time,
    latestMatchId: last.match_id,
    rows: Object.freeze(rows),
  });
}

export function groupHomeSeriesRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError('home series rows must be an array');
  const groups = [];
  const keyed = new Map();

  for (const row of rows) {
    if (row.series_id === null || row.series_id === undefined) {
      groups.push(freezeGroup([row], teamPair(row), 0));
      continue;
    }
    const pair = teamPair(row);
    const key = baseKey(row, pair);
    const bucket = keyed.get(key) ?? { pair, rows: [] };
    bucket.rows.push(row);
    keyed.set(key, bucket);
  }

  for (const { pair, rows: bucket } of keyed.values()) {
    bucket.sort((left, right) => left.start_time - right.start_time || left.match_id - right.match_id);
    let segmentRows = [];
    let segment = 0;
    for (const row of bucket) {
      if (
        segmentRows.length > 0
        && row.start_time - segmentRows.at(-1).start_time > SERIES_SPLIT_SECONDS
      ) {
        groups.push(freezeGroup(segmentRows, pair, segment));
        segment += 1;
        segmentRows = [];
      }
      segmentRows.push(row);
    }
    if (segmentRows.length > 0) groups.push(freezeGroup(segmentRows, pair, segment));
  }

  groups.sort((left, right) => (
    right.endTime - left.endTime || right.latestMatchId - left.latestMatchId
  ));
  return Object.freeze(groups);
}
