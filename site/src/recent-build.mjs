import { buildDataPaths } from './build-context.mjs';
import { createCatalog } from './data/catalog.mjs';
import { DataReader } from './data/queries.mjs';
import { loadReferences } from './data/references.mjs';

let contextPromise;

export async function recentBuildContext() {
  if (!contextPromise) {
    contextPromise = (async () => {
      const { dataRoot, referenceRoot } = buildDataPaths();
      const [catalog, references] = await Promise.all([
        createCatalog({ dataRoot }),
        loadReferences({ referenceRoot }),
      ]);
      return Object.freeze({
        reader: await DataReader.create(catalog),
        references,
      });
    })();
  }
  return contextPromise;
}

export async function recentMatchPaths(clock) {
  const { reader } = await recentBuildContext();
  const window = await reader.window({
    clock,
    days: 90,
    includeMatchIds: true,
  });
  return window.matchIds.map((matchId) => ({
    params: { id: String(matchId) },
    props: { matchId },
  }));
}
