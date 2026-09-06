import { heroCollection } from './heroes.mjs';
import { teamCollection } from './teams.mjs';
import { tournamentCollection } from './tournaments.mjs';
import { BUILD_CLOCK } from '../build-context.mjs';
import { createSearchIndex } from '../presentation/search.mjs';
import { recentMatchPaths } from '../recent-build.mjs';

let defaultIndexPromise;

export function searchIndex() {
  defaultIndexPromise ??= Promise.all([
    teamCollection(),
    tournamentCollection(),
    heroCollection(),
    recentMatchPaths(BUILD_CLOCK),
  ]).then(([teams, tournaments, heroes, matchPaths]) => createSearchIndex({
    teams: teams.teams,
    tournaments: tournaments.tournaments,
    heroes: heroes.heroes,
    matches: matchPaths.map(({ props }) => ({ matchId: props.matchId })),
  }));
  return defaultIndexPromise;
}
