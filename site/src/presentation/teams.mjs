export const TEAM_PAGE_SIZE = 200;
export const TEAM_INDEX_TITLE = 'Teams — DotaInfo';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
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

function count(value) {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`invalid aggregate count: ${value}`);
  }
  return result;
}

function indexRows(rows, key) {
  const indexed = new Map();
  for (const row of rows) {
    const id = safeId(row[key]);
    if (id !== null && !indexed.has(id)) indexed.set(id, row);
  }
  return indexed;
}

function availableName(display, source) {
  return Object.freeze({ status: 'available', display, source });
}

function missingName() {
  return Object.freeze({ status: 'missing', display: 'Team name unavailable', source: null });
}

function eraTeamName(value, teamId, teamReferences) {
  const reference = teamId === null ? null : teamReferences.get(teamId);
  const candidates = [
    [value, 'match-write-time'],
    [reference?.name, 'reference-current'],
    [reference?.tag, 'reference-tag'],
  ];
  for (const [candidate, source] of candidates) {
    const display = cleanText(candidate);
    if (display) return availableName(display, source);
  }
  return missingName();
}

function currentTeamName(teamId, rows, reference) {
  const current = cleanText(reference?.name);
  if (current) return availableName(current, 'reference-current');
  for (const row of rows) {
    const side = safeId(row.radiant_team_id) === teamId ? 'radiant' : 'dire';
    const era = cleanText(row[`${side}_team_name`]);
    if (era) return availableName(era, 'most-recent-match');
  }
  return availableName(`Team ${teamId}`, 'team-id-fallback');
}

function dateState(startTime) {
  const value = Number(startTime);
  if (!Number.isFinite(value)) {
    return Object.freeze({ status: 'missing', startTime: null, isoUtc: null, display: 'Date unavailable' });
  }
  const date = new Date(value * 1_000);
  return Object.freeze({
    status: 'available',
    startTime: value,
    isoUtc: date.toISOString(),
    display: DATE_FORMATTER.format(date),
  });
}

function matchForTeam(row, teamId, teamReferences, leagueReferences) {
  const radiantId = safeId(row.radiant_team_id);
  const side = radiantId === teamId ? 'radiant' : 'dire';
  const opponentSide = side === 'radiant' ? 'dire' : 'radiant';
  const opponentId = safeId(row[`${opponentSide}_team_id`]);
  const scoreAvailable = Number.isInteger(row.radiant_score) && Number.isInteger(row.dire_score);
  const resultAvailable = typeof row.radiant_win === 'boolean';
  const won = resultAvailable ? row.radiant_win === (side === 'radiant') : null;
  const leagueId = safeId(row.leagueid);
  const leagueReference = leagueId === null ? null : leagueReferences.get(leagueId);
  return Object.freeze({
    matchId: Number(row.match_id),
    side,
    date: dateState(row.start_time),
    opponent: Object.freeze({
      teamId: opponentId,
      name: eraTeamName(row[`${opponentSide}_team_name`], opponentId, teamReferences),
    }),
    score: Object.freeze({
      status: scoreAvailable ? 'available' : 'missing',
      team: scoreAvailable ? row[`${side}_score`] : null,
      opponent: scoreAvailable ? row[`${opponentSide}_score`] : null,
    }),
    result: Object.freeze({
      status: resultAvailable ? 'available' : 'missing',
      won,
      label: resultAvailable ? (won ? 'Won' : 'Lost') : 'Result unavailable',
    }),
    tournament: Object.freeze({
      leagueId,
      name: cleanText(leagueReference?.name)
        ?? cleanText(row.league_name)
        ?? 'Tournament unavailable',
    }),
  });
}

function titleStems(teams) {
  const byName = new Map();
  for (const team of teams) {
    const group = byName.get(team.name.display) ?? [];
    group.push(team);
    byName.set(team.name.display, group);
  }
  const stems = new Map();
  for (const [name, sameName] of byName) {
    if (sameName.length === 1) {
      stems.set(sameName[0].teamId, name);
      continue;
    }
    const byYear = new Map();
    for (const team of sameName) {
      const candidate = `${name} (${team.firstYear})`;
      const group = byYear.get(candidate) ?? [];
      group.push(team);
      byYear.set(candidate, group);
    }
    for (const [candidate, sameYear] of byYear) {
      for (const team of sameYear) {
        stems.set(team.teamId, sameYear.length === 1 ? candidate : `${name} (${team.teamId})`);
      }
    }
  }
  return stems;
}

function teamPage(team, pageNumber, pageSize, titleStem) {
  const offset = (pageNumber - 1) * pageSize;
  const suffix = pageNumber === 1 ? '' : ` — Page ${pageNumber}`;
  return Object.freeze({
    ...team,
    title: `${titleStem}${suffix} — DotaInfo`,
    pageNumber,
    pageCount: Math.ceil(team.matchCount / pageSize),
    matches: Object.freeze(team.matches.slice(offset, offset + pageSize)),
    previousHref: pageNumber === 1
      ? null
      : `/teams/${team.teamId}/${pageNumber === 2 ? '' : `${pageNumber - 1}/`}`,
    nextHref: offset + pageSize >= team.matchCount
      ? null
      : `/teams/${team.teamId}/${pageNumber + 1}/`,
  });
}

function indexGroup(name) {
  const initial = [...name.normalize('NFKD').toUpperCase()][0] ?? '#';
  return /^[A-Z]$/.test(initial)
    ? Object.freeze({ id: initial.toLowerCase(), label: initial, order: initial.charCodeAt(0) })
    : Object.freeze({ id: 'other', label: '0–9 and other', order: 1_000 });
}

export function createTeamCollection(matchRows, heroAppearances = [], referenceRows = {}, {
  pageSize = TEAM_PAGE_SIZE,
  topHeroLimit = 5,
} = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new TypeError('page size must be positive');
  if (!Number.isSafeInteger(topHeroLimit) || topHeroLimit <= 0) throw new TypeError('top hero limit must be positive');
  const teamReferences = indexRows(referenceRows.teams ?? [], 'team_id');
  const leagueReferences = indexRows(referenceRows.leagues ?? [], 'leagueid');
  const heroReferences = indexRows(referenceRows.heroes ?? [], 'id');
  const rowsByTeam = new Map();
  const seenMatchIds = new Set();
  for (const row of matchRows) {
    const matchId = safeId(row.match_id);
    if (matchId === null) throw new TypeError('team match has an invalid match_id');
    if (seenMatchIds.has(matchId)) continue;
    seenMatchIds.add(matchId);
    const teamIds = new Set([safeId(row.radiant_team_id), safeId(row.dire_team_id)]
      .filter((teamId) => teamId !== null));
    for (const teamId of teamIds) {
      const rows = rowsByTeam.get(teamId) ?? [];
      rows.push(row);
      rowsByTeam.set(teamId, rows);
    }
  }

  const heroesByTeam = new Map();
  for (const row of heroAppearances) {
    const teamId = safeId(row.team_id);
    if (teamId === null || !rowsByTeam.has(teamId)) continue;
    const heroId = safeId(row.hero_id);
    const reference = heroId === null ? null : heroReferences.get(heroId);
    const group = heroesByTeam.get(teamId) ?? [];
    group.push(Object.freeze({
      heroId,
      name: cleanText(reference?.localized_name)
        ?? cleanText(reference?.name)?.replace(/^npc_dota_hero_/, '').replaceAll('_', ' ')
        ?? 'Hero unavailable',
      appearances: count(row.appearances),
    }));
    heroesByTeam.set(teamId, group);
  }

  const teams = [];
  for (const [teamId, rows] of rowsByTeam) {
    rows.sort((left, right) => Number(right.start_time) - Number(left.start_time)
      || Number(right.match_id) - Number(left.match_id));
    const reference = teamReferences.get(teamId);
    const name = currentTeamName(teamId, rows, reference);
    const matches = Object.freeze(rows.map((row) => matchForTeam(
      row,
      teamId,
      teamReferences,
      leagueReferences,
    )));
    const decided = matches.filter((match) => match.result.status === 'available');
    const wins = decided.filter((match) => match.result.won).length;
    const losses = decided.length - wins;
    const startTimes = matches.map((match) => match.date.startTime).filter(Number.isFinite);
    const firstStartTime = startTimes.length > 0 ? Math.min(...startTimes) : null;
    const lastStartTime = startTimes.length > 0 ? Math.max(...startTimes) : null;
    const heroes = (heroesByTeam.get(teamId) ?? [])
      .sort((left, right) => right.appearances - left.appearances
        || left.name.localeCompare(right.name)
        || (left.heroId ?? Number.MAX_SAFE_INTEGER) - (right.heroId ?? Number.MAX_SAFE_INTEGER));
    teams.push({
      teamId,
      name,
      tag: cleanText(reference?.tag),
      logo: Object.freeze({
        status: cleanText(reference?.logo_url) ? 'available' : 'missing',
        url: cleanText(reference?.logo_url),
      }),
      matchCount: matches.length,
      matches,
      wins,
      losses,
      decidedMatches: decided.length,
      nullResultMatches: matches.length - decided.length,
      tournamentsPlayed: new Set(matches.map((match) => match.tournament.leagueId)
        .filter((leagueId) => leagueId !== null)).size,
      firstStartTime,
      lastStartTime,
      firstYear: firstStartTime === null ? 'year unavailable' : new Date(firstStartTime * 1_000).getUTCFullYear(),
      topHeroes: Object.freeze(heroes.slice(0, topHeroLimit)),
    });
  }

  teams.sort((left, right) => left.name.display.localeCompare(right.name.display)
    || left.teamId - right.teamId);
  const stems = titleStems(teams);
  const completed = Object.freeze(teams.map((team) => Object.freeze({
    ...team,
    titleStem: stems.get(team.teamId),
    pageCount: Math.ceil(team.matchCount / pageSize),
    indexGroup: indexGroup(team.name.display),
  })));
  const pages = Object.freeze(completed.flatMap((team) => Array.from(
    { length: team.pageCount },
    (_, index) => teamPage(team, index + 1, pageSize, team.titleStem),
  )));
  const titles = [TEAM_INDEX_TITLE, ...pages.map((page) => page.title)];
  if (new Set(titles).size !== titles.length) throw new Error('team page title collision');

  const groups = new Map();
  for (const team of completed) {
    const group = groups.get(team.indexGroup.id) ?? { ...team.indexGroup, teams: [] };
    group.teams.push(team);
    groups.set(team.indexGroup.id, group);
  }
  return Object.freeze({
    pageSize,
    matchCount: seenMatchIds.size,
    teams: completed,
    pages,
    groups: Object.freeze([...groups.values()]
      .sort((left, right) => left.order - right.order)
      .map((group) => Object.freeze({ ...group, teams: Object.freeze(group.teams) }))),
  });
}
