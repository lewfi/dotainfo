function numericState(value) {
  return Number.isFinite(value)
    ? Object.freeze({ status: 'available', value })
    : Object.freeze({ status: 'missing', value: null });
}

function textState(value, missingDisplay) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  return cleaned
    ? Object.freeze({ status: 'available', value: cleaned, display: cleaned })
    : Object.freeze({ status: 'missing', value: null, display: missingDisplay });
}

function resultState(radiantWin) {
  if (radiantWin === true || radiantWin === false) {
    return Object.freeze({
      status: 'available',
      winner: radiantWin ? 'radiant' : 'dire',
    });
  }
  return Object.freeze({ status: 'missing', winner: null });
}

function scoreState(radiantScore, direScore) {
  const radiant = numericState(radiantScore);
  const dire = numericState(direScore);
  return Object.freeze({
    status: radiant.status === 'available' && dire.status === 'available'
      ? 'available'
      : 'missing',
    radiant: radiant.value,
    dire: dire.value,
  });
}

function dateState(startTime) {
  if (!Number.isSafeInteger(startTime)) {
    return Object.freeze({ status: 'missing', epochSeconds: null, isoUtc: null });
  }
  const date = new Date(startTime * 1000);
  if (!Number.isFinite(date.getTime())) {
    return Object.freeze({ status: 'missing', epochSeconds: null, isoUtc: null });
  }
  return Object.freeze({
    status: 'available',
    epochSeconds: startTime,
    isoUtc: date.toISOString(),
  });
}

export function createMatchSummary(match, references) {
  if (!match || typeof match !== 'object') {
    throw new TypeError('match summary requires a match row');
  }
  if (!references || typeof references.resolveTeam !== 'function') {
    throw new TypeError('match summary requires a reference resolver');
  }

  return Object.freeze({
    matchId: match.match_id,
    teams: Object.freeze({
      radiant: references.resolveTeam({
        teamId: match.radiant_team_id,
        denormalizedName: match.radiant_team_name,
      }),
      dire: references.resolveTeam({
        teamId: match.dire_team_id,
        denormalizedName: match.dire_team_name,
      }),
    }),
    result: resultState(match.radiant_win),
    score: scoreState(match.radiant_score, match.dire_score),
    league: references.resolveLeague({
      leagueId: match.leagueid,
      denormalizedName: match.league_name,
      leagueTier: match.league_tier,
    }),
    duration: numericState(match.duration),
    patch: textState(match.patch, 'Patch unavailable'),
    date: dateState(match.start_time),
  });
}
