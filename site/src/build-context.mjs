import path from 'node:path';

export const BUILD_CLOCK = process.env.DOTAINFO_BUILD_CLOCK ?? new Date().toISOString();

export function buildDataPaths() {
  const dataRoot = path.resolve(process.cwd(), '../data');
  return Object.freeze({
    dataRoot,
    referenceRoot: path.join(dataRoot, 'reference'),
  });
}
