import { homeTierCategory } from './home-feed.mjs';

export const TOURNAMENT_PAGE_SIZE = 200;
export const TOURNAMENT_INDEX_TITLE = 'Tournament index — DotaInfo';

const DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  weekday: 'long',
  year: 'numeric',
});

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function safeId(value) {
  if (value === null || value === undefined) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function indexRows(rows, key) {
  return new Map(rows
    .map((row) => [safeId(row[key]), row])
    .filter(([id]) => id !== null));
}

function availableName(value, source) {
  return Object.freeze({ status: 'available', display: value, source });
}

function missingName() {
  return Object.freeze({ status: 'missing', display: 'Team name unavailable', source: null });
}

function teamName(rowName, teamId, teamReferences, { currentFirst }) {
  const reference = teamId === null ? null : teamReferences.get(teamId);
  const candidates = currentFirst
    ? [[reference?.name, 'reference-current'], [rowName, 'match-write-time'], [reference?.tag, 'reference-tag']]
    : [[rowName, 'match-write-time'], [reference?.name, 'reference-current'], [reference?.tag, 'reference-tag']];
  for (const [candidate, source] of candidates) {
    const name = cleanText(candidate);
    if (name) return availableName(name, source);
  }
  return missingName();
}

function team(row, side, teamReferences, currentFirst = false) {
  const teamId = safeId(row[`${side}_team_id`]);
  return Object.freeze({
    teamId,
    name: teamName(row[`${side}_team_name`], teamId, teamReferences, { currentFirst }),
  });
}

function seriesLabel(value) {
  if (value === null || value === undefined) return 'Series format unavailable';
  return Object.freeze({ 0: 'Best of 1', 1: 'Best of 3', 2: 'Best of 5' })[Number(value)] ?? 'Other';
}

function matchPresentation(row, teamReferences) {
  const startTime = Number(row.start_time);
  const isoUtc = Number.isFinite(startTime) ? new Date(startTime * 1_000).toISOString() : null;
  const radiant = team(row, 'radiant', teamReferences);
  const dire = team(row, 'dire', teamReferences);
  const scoreAvailable = Number.isInteger(row.radiant_score) && Number.isInteger(row.dire_score);
  const resultAvailable = typeof row.radiant_win === 'boolean';
  return Object.freeze({
    matchId: Number(row.match_id),
    startTime,
    isoUtc,
    dayKey: isoUtc?.slice(0, 10) ?? 'unavailable',
    teams: Object.freeze({ radiant, dire }),
    score: Object.freeze({
      status: scoreAvailable ? 'available' : 'missing',
      radiant: scoreAvailable ? row.radiant_score : null,
      dire: scoreAvailable ? row.dire_score : null,
    }),
    result: Object.freeze({
      status: resultAvailable ? 'available' : 'missing',
      winner: resultAvailable ? (row.radiant_win ? 'radiant' : 'dire') : null,
    }),
    seriesId: safeId(row.series_id),
    seriesType: row.series_type === null || row.series_type === undefined
      ? null
      : Number(row.series_type),
  });
}

function groupPageMatches(matches) {
  const days = new Map();
  for (const match of matches) {
    let day = days.get(match.dayKey);
    if (!day) {
      day = {
        key: match.dayKey,
        label: match.isoUtc ? DAY_FORMATTER.format(new Date(match.isoUtc)) : 'Date unavailable',
        count: 0,
        series: [],
      };
      days.set(match.dayKey, day);
    }
    day.count += 1;
    const seriesKey = match.seriesId === null ? `match:${match.matchId}` : `series:${match.seriesId}`;
    let series = day.series.at(-1);
    if (series?.key !== seriesKey) series = null;
    if (!series) {
      series = {
        key: seriesKey,
        seriesId: match.seriesId,
        seriesType: match.seriesType,
        label: seriesLabel(match.seriesType),
        matches: [],
      };
      day.series.push(series);
    }
    series.matches.push(match);
  }
  return Object.freeze([...days.values()].map((day) => Object.freeze({
    key: day.key,
    label: day.label,
    count: day.count,
    series: Object.freeze(day.series.map((series) => Object.freeze({
      ...series,
      matches: Object.freeze(series.matches),
    }))),
  })));
}

function titleStems(tournaments) {
  const byName = new Map();
  for (const tournament of tournaments) {
    const group = byName.get(tournament.name) ?? [];
    group.push(tournament);
    byName.set(tournament.name, group);
  }

  const stems = new Map();
  for (const [name, sameName] of byName) {
    if (sameName.length === 1) {
      stems.set(sameName[0].leagueId, name);
      continue;
    }
    const byYear = new Map();
    for (const tournament of sameName) {
      const candidate = `${name} (${tournament.firstYear})`;
      const group = byYear.get(candidate) ?? [];
      group.push(tournament);
      byYear.set(candidate, group);
    }
    for (const [candidate, sameYear] of byYear) {
      for (const tournament of sameYear) {
        stems.set(
          tournament.leagueId,
          sameYear.length === 1 ? candidate : `${name} (${tournament.leagueId})`,
        );
      }
    }
  }
  return stems;
}

function tournamentPage(tournament, pageNumber, pageSize, titleStem) {
  const offset = (pageNumber - 1) * pageSize;
  const matches = tournament.matches.slice(offset, offset + pageSize);
  const suffix = pageNumber === 1 ? '' : ` — Page ${pageNumber}`;
  return Object.freeze({
    ...tournament,
    title: `${titleStem}${suffix} — DotaInfo`,
    pageNumber,
    pageCount: Math.ceil(tournament.matchCount / pageSize),
    matches: Object.freeze(matches),
    days: groupPageMatches(matches),
    previousHref: pageNumber === 1
      ? null
      : `/tournaments/${tournament.leagueId}/${pageNumber === 2 ? '' : `${pageNumber - 1}/`}`,
    nextHref: offset + pageSize >= tournament.matchCount
      ? null
      : `/tournaments/${tournament.leagueId}/${pageNumber + 1}/`,
  });
}

export function createTournamentCollection(matchRows, referenceRows = {}, { pageSize = TOURNAMENT_PAGE_SIZE } = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new TypeError('page size must be positive');
  const teamReferences = indexRows(referenceRows.teams ?? [], 'team_id');
  const leagueReferences = indexRows(referenceRows.leagues ?? [], 'leagueid');
  const rowsByLeague = new Map();
  const seenMatchIds = new Set();
  for (const row of matchRows) {
    const matchId = safeId(row.match_id);
    const leagueId = safeId(row.leagueid);
    if (matchId === null) throw new TypeError('tournament match has an invalid match_id');
    if (leagueId === null) throw new TypeError(`match ${matchId} has no routable leagueid`);
    if (seenMatchIds.has(matchId)) continue;
    seenMatchIds.add(matchId);
    const group = rowsByLeague.get(leagueId) ?? [];
    group.push(row);
    rowsByLeague.set(leagueId, group);
  }

  const tournaments = [];
  for (const [leagueId, rows] of rowsByLeague) {
    rows.sort((left, right) => Number(right.start_time) - Number(left.start_time)
      || Number(right.match_id) - Number(left.match_id));
    const reference = leagueReferences.get(leagueId);
    const name = cleanText(reference?.name)
      ?? rows.map((row) => cleanText(row.league_name)).find(Boolean)
      ?? 'League name unavailable';
    const tier = cleanText(reference?.tier)
      ?? rows.map((row) => cleanText(row.league_tier)).find(Boolean)
      ?? null;
    const matches = Object.freeze(rows.map((row) => matchPresentation(row, teamReferences)));
    const startTimes = matches.map((match) => match.startTime).filter(Number.isFinite);
    const participatingIds = new Set(matches.flatMap((match) => [
      match.teams.radiant.teamId,
      match.teams.dire.teamId,
    ]).filter((id) => id !== null));
    const currentTeams = Object.freeze([...participatingIds]
      .map((teamId) => {
        const sample = rows.find((row) => safeId(row.radiant_team_id) === teamId
          || safeId(row.dire_team_id) === teamId);
        const side = safeId(sample.radiant_team_id) === teamId ? 'radiant' : 'dire';
        return team(sample, side, teamReferences, true);
      })
      .sort((left, right) => left.name.display.localeCompare(right.name.display)
        || left.teamId - right.teamId));
    tournaments.push({
      leagueId,
      name,
      tier,
      category: homeTierCategory(tier),
      matchCount: matches.length,
      matches,
      firstStartTime: Math.min(...startTimes),
      lastStartTime: Math.max(...startTimes),
      firstYear: new Date(Math.min(...startTimes) * 1_000).getUTCFullYear(),
      teams: currentTeams,
    });
  }

  const categoryOrder = Object.freeze({ top: 0, pro: 1, amateur: 2, other: 3 });
  tournaments.sort((left, right) => categoryOrder[left.category.id] - categoryOrder[right.category.id]
    || left.name.localeCompare(right.name)
    || left.leagueId - right.leagueId);
  const stems = titleStems(tournaments);
  const completed = Object.freeze(tournaments.map((tournament) => Object.freeze({
    ...tournament,
    titleStem: stems.get(tournament.leagueId),
    pageCount: Math.ceil(tournament.matchCount / pageSize),
  })));
  const pages = Object.freeze(completed.flatMap((tournament) => Array.from(
    { length: tournament.pageCount },
    (_, index) => tournamentPage(tournament, index + 1, pageSize, tournament.titleStem),
  )));
  const titles = [TOURNAMENT_INDEX_TITLE, ...pages.map((page) => page.title)];
  if (new Set(titles).size !== titles.length) throw new Error('tournament page title collision');

  const groups = new Map();
  for (const tournament of completed) {
    const group = groups.get(tournament.category.id) ?? {
      ...tournament.category,
      tournaments: [],
      matchCount: 0,
    };
    group.tournaments.push(tournament);
    group.matchCount += tournament.matchCount;
    groups.set(tournament.category.id, group);
  }
  return Object.freeze({
    pageSize,
    matchCount: completed.reduce((sum, tournament) => sum + tournament.matchCount, 0),
    tournaments: completed,
    pages,
    groups: Object.freeze([...groups.values()].map((group) => Object.freeze({
      ...group,
      tournaments: Object.freeze(group.tournaments),
    }))),
  });
}
