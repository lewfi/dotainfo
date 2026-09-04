import { heroCollection } from './heroes.mjs';
import { teamCollection } from './teams.mjs';
import { tournamentCollection } from './tournaments.mjs';
import { createSearchIndex } from '../presentation/search.mjs';

let defaultIndexPromise;

export function searchIndex() {
  defaultIndexPromise ??= Promise.all([
    teamCollection(),
    tournamentCollection(),
    heroCollection(),
  ]).then(([teams, tournaments, heroes]) => createSearchIndex({
    teams: teams.teams,
    tournaments: tournaments.tournaments,
    heroes: heroes.heroes,
  }));
  return defaultIndexPromise;
}
