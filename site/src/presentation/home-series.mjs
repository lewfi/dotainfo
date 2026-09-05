import { createMatchSummary } from './match-summary.mjs';

function winnerTeamId(row) {
  if (row.radiant_win === true) return row.radiant_team_id ?? null;
  if (row.radiant_win === false) return row.dire_team_id ?? null;
  return null;
}

function sideForTeam(row, teamId) {
  if (teamId === null) return null;
  if (row.radiant_team_id === teamId) return 'radiant';
  if (row.dire_team_id === teamId) return 'dire';
  return null;
}

export function createHomeSeriesEntry(group, references) {
  if (!group || !Array.isArray(group.rows) || group.rows.length === 0) {
    throw new TypeError('home series entry requires a non-empty group');
  }
  const maps = group.rows.map((row, index) => Object.freeze({
    number: index + 1,
    row,
    summary: createMatchSummary(row, references),
    winnerTeamId: winnerTeamId(row),
  }));
  const first = maps[0];
  const latest = maps.at(-1);
  const teamOneId = first.row.radiant_team_id ?? null;
  const teamTwoId = first.row.dire_team_id ?? null;
  const distinctTeamIds = teamOneId !== null && teamTwoId !== null && teamOneId !== teamTwoId;
  let teamOneWins = 0;
  let teamTwoWins = 0;
  let unknownMaps = 0;
  for (const map of maps) {
    if (!distinctTeamIds || map.winnerTeamId === null) unknownMaps += 1;
    else if (map.winnerTeamId === teamOneId) teamOneWins += 1;
    else if (map.winnerTeamId === teamTwoId) teamTwoWins += 1;
    else unknownMaps += 1;
  }
  const sidesSwapped = distinctTeamIds && maps.some((map) => (
    sideForTeam(map.row, teamOneId) === 'dire' && sideForTeam(map.row, teamTwoId) === 'radiant'
  ));

  return Object.freeze({
    id: group.id,
    kind: group.kind,
    seriesId: group.seriesId,
    seriesType: group.seriesType,
    leagueTier: group.leagueTier,
    teamPair: group.teamPair,
    maps: Object.freeze(maps),
    mapCount: maps.length,
    primaryMatchId: latest.summary.matchId,
    latest: latest.summary,
    teams: Object.freeze({
      one: first.summary.teams.radiant,
      two: first.summary.teams.dire,
    }),
    seriesScore: group.kind === 'series' ? Object.freeze({
      teamOneWins,
      teamTwoWins,
      unknownMaps,
    }) : null,
    sidesSwapped,
  });
}
