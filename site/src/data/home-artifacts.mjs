import { BUILD_CLOCK, buildDataPaths } from '../build-context.mjs';
import { createHomeFeedViews } from '../presentation/home-feed.mjs';
import { createCatalog } from './catalog.mjs';
import { DataReader } from './queries.mjs';
import { loadReferences } from './references.mjs';

export const HOME_FEED_LIMIT = 300;
export const ACTIVE_TOURNAMENT_DAYS = 14;

let defaultContextPromise;

function rowDayAssignments(home) {
  const assignments = new Map();
  for (const day of home.days) {
    for (const league of day.leagues) {
      for (const entry of league.entries) {
        for (const map of entry.maps) assignments.set(map.summary.matchId, day.key);
      }
    }
  }
  return assignments;
}

export async function createHomeBuildContext({
  dataRoot,
  referenceRoot,
  clock = BUILD_CLOCK,
} = {}) {
  const roots = buildDataPaths();
  const [catalog, references] = await Promise.all([
    createCatalog({ dataRoot: dataRoot ?? roots.dataRoot }),
    loadReferences({ referenceRoot: referenceRoot ?? roots.referenceRoot }),
  ]);
  const reader = await DataReader.create(catalog);
  try {
    const home = await createHomeFeedViews({ reader, references, clock, limit: HOME_FEED_LIMIT });
    const active = await reader.activeTournaments({ clock, days: ACTIVE_TOURNAMENT_DAYS });
    const assignments = rowDayAssignments(home);
    const players = await reader.homePlayers([...assignments.keys()]);
    const playersByDay = new Map([...new Set(assignments.values())].map((day) => [day, []]));
    for (const row of players) {
      const day = assignments.get(row.match_id);
      if (day) playersByDay.get(day).push(row);
    }
    const activeTournaments = Object.freeze(active.rows.map((row) => Object.freeze({
      leagueId: row.leagueid,
      league: references.resolveLeague({
        leagueId: row.leagueid,
        denormalizedName: row.league_name,
        leagueTier: row.league_tier,
      }),
      matchCount: row.matchCount,
      lastStartTime: row.start_time,
    })));
    const heroes = Object.freeze(references.ids('heroes').map((heroId) => {
      const hero = references.resolveHero(heroId);
      return Object.freeze({
        id: heroId,
        name: hero.name.display,
        icon: hero.icon.url,
      });
    }));
    return Object.freeze({
      home,
      activeTournaments,
      activeRange: Object.freeze({ startEpoch: active.startEpoch, endEpoch: active.endEpoch }),
      heroes,
      playerDays: Object.freeze([...playersByDay].map(([day, rows]) => Object.freeze({
        day,
        rows: Object.freeze(rows),
      }))),
    });
  } finally {
    reader.close();
  }
}

export function homeBuildContext() {
  defaultContextPromise ??= createHomeBuildContext();
  return defaultContextPromise;
}

export async function homePlayerDayArtifact(day) {
  const context = await homeBuildContext();
  const payload = context.playerDays.find((candidate) => candidate.day === day);
  if (!payload) throw new RangeError(`unknown home player day: ${day}`);
  return `${JSON.stringify(payload)}\n`;
}

export async function homeHeroArtifact() {
  const context = await homeBuildContext();
  return `${JSON.stringify({ heroes: context.heroes })}\n`;
}
