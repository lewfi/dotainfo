import assert from 'node:assert/strict';

import { createCatalog, readableShards } from '../src/data/catalog.mjs';
import { openDuckDB, queryRows, sourceUnionSql } from '../src/data/duckdb.mjs';
import { loadReferences } from '../src/data/references.mjs';

function usableText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function unusableForm(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (value === '') {
    return 'empty';
  }
  if (value === ' ') {
    return 'singleSpace';
  }
  if (value === '  ') {
    return 'doubleSpace';
  }
  return 'otherWhitespace';
}

function validDisplayName(name) {
  return name
    && (name.status === 'available' || name.status === 'missing')
    && typeof name.display === 'string'
    && name.display.length > 0
    && name.display === name.display.trim();
}

function validLogoState(logo) {
  return logo
    && (logo.status === 'available' || logo.status === 'missing')
    && (logo.status === 'available'
      ? typeof logo.url === 'string' && logo.url.length > 0
      : logo.url === null);
}

const catalog = await createCatalog();
const references = await loadReferences();
const matchShards = readableShards(catalog, 'matches');
const draftShards = readableShards(catalog, 'draft');
const database = await openDuckDB();

let matches;
let draftHeroes;
try {
  matches = await queryRows(
    database.connection,
    sourceUnionSql(matchShards, 'matches', [
      'match_id',
      'leagueid',
      'league_name',
      'league_tier',
      'radiant_team_id',
      'dire_team_id',
      'radiant_team_name',
      'dire_team_name',
    ]),
  );
  draftHeroes = await queryRows(
    database.connection,
    `SELECT DISTINCT hero_id FROM (\n${sourceUnionSql(draftShards, 'draft', ['hero_id'])}\n) `
      + 'AS draft_rows ORDER BY hero_id',
  );
} finally {
  database.close();
}

const matchUsedTeamIds = new Set();
const missingTeamIds = new Set();
const referenceTeamsWithoutLogo = new Set();
const resolvedTagFallbackTeamIds = new Set();
const matchLeagueIds = new Set();
const missingLeagueIds = new Set();
const missingDraftHeroIds = new Set();
const unusableMatchNameForms = {
  null: 0,
  empty: 0,
  singleSpace: 0,
  doubleSpace: 0,
  otherWhitespace: 0,
};
let nullTeamIdMatches = 0;
let nullTeamIdAppearances = 0;
let unusableMatchNameAppearances = 0;
let missingTeamAppearances = 0;
let referenceNoLogoAppearances = 0;
let resolvedTagFallbackAppearances = 0;
let resolvedMissingTeamNameAppearances = 0;
let invalidTeamDisplayStates = 0;
let invalidTeamLogoStates = 0;
let invalidResolvedDisplayNames = 0;

for (const match of matches) {
  if (match.radiant_team_id === null || match.dire_team_id === null) {
    nullTeamIdMatches += 1;
  }
  const league = references.resolveLeague({
    leagueId: match.leagueid,
    denormalizedName: match.league_name,
    leagueTier: match.league_tier,
  });
  matchLeagueIds.add(match.leagueid);
  if (!league.referenceFound) {
    missingLeagueIds.add(match.leagueid);
  }
  if (!validDisplayName(league.name) || !validDisplayName(league.tier)) {
    invalidResolvedDisplayNames += 1;
  }

  for (const side of ['radiant', 'dire']) {
    const teamId = match[`${side}_team_id`];
    const denormalizedName = match[`${side}_team_name`];
    const team = references.resolveTeam({ teamId, denormalizedName });
    if (teamId === null) {
      nullTeamIdAppearances += 1;
    } else {
      matchUsedTeamIds.add(teamId);
      if (!usableText(denormalizedName)) {
        unusableMatchNameAppearances += 1;
        unusableMatchNameForms[unusableForm(denormalizedName)] += 1;
      }
      if (!team.referenceFound) {
        missingTeamIds.add(teamId);
        missingTeamAppearances += 1;
      } else if (team.logo.status === 'missing') {
        referenceTeamsWithoutLogo.add(teamId);
        referenceNoLogoAppearances += 1;
      }
    }
    if (team.name.status === 'missing') {
      resolvedMissingTeamNameAppearances += 1;
    }
    if (team.name.source === 'reference-tag') {
      resolvedTagFallbackAppearances += 1;
      resolvedTagFallbackTeamIds.add(teamId);
    }
    if (!validDisplayName(team.name)) {
      invalidTeamDisplayStates += 1;
      invalidResolvedDisplayNames += 1;
    }
    if (!validLogoState(team.logo)) {
      invalidTeamLogoStates += 1;
    }
  }
}

for (const { hero_id: heroId } of draftHeroes) {
  const hero = references.resolveHero(heroId);
  if (!hero.referenceFound) {
    missingDraftHeroIds.add(heroId);
  }
  if (!validDisplayName(hero.name)) {
    invalidResolvedDisplayNames += 1;
  }
}

for (const playerId of references.ids('players')) {
  const player = references.resolvePlayer(playerId);
  if (!validDisplayName(player.name)) {
    invalidResolvedDisplayNames += 1;
  }
}

const observed = Object.freeze({
  matchShards: matchShards.length,
  draftShards: draftShards.length,
  matches: matches.length,
  teamSlots: matches.length * 2,
  nullTeamIdMatches,
  nullTeamIdAppearances,
  nonNullTeamIdUnusableMatchNameAppearances: unusableMatchNameAppearances,
  unusableMatchNameForms,
  matchUsedTeamIds: matchUsedTeamIds.size,
  missingReferenceTeamIds: missingTeamIds.size,
  missingReferenceTeamAppearances: missingTeamAppearances,
  referenceTeamIdsWithoutLogo: referenceTeamsWithoutLogo.size,
  referenceTeamWithoutLogoAppearances: referenceNoLogoAppearances,
  resolvedTagFallbackTeamIds: resolvedTagFallbackTeamIds.size,
  resolvedTagFallbackAppearances,
  resolvedMissingTeamNameAppearances,
  matchLeagueIds: matchLeagueIds.size,
  missingLeagueIds: [...missingLeagueIds].sort((left, right) => left - right),
  draftHeroIds: draftHeroes.length,
  missingDraftHeroIds: [...missingDraftHeroIds].sort((left, right) => left - right),
  referenceRows: references.counts,
});
const assertions = Object.freeze({
  everyTeamSlotHasDisplayState: invalidTeamDisplayStates === 0,
  everyTeamSlotHasLogoState: invalidTeamLogoStates === 0,
  everyLeagueResolves: missingLeagueIds.size === 0,
  everyDraftHeroResolves: missingDraftHeroIds.size === 0,
  everyResolvedDisplayNameIsTrimmedAndNonEmpty: invalidResolvedDisplayNames === 0,
});

console.log(`STEP12_OBSERVED=${JSON.stringify(observed)}`);
console.log(`STEP12_ASSERTIONS=${JSON.stringify(assertions)}`);
assert.ok(Object.values(assertions).every(Boolean), 'Step 12 reference assertions failed');
console.log('STEP12_STATUS=PASS');
