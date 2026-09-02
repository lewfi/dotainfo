import { defineConfig } from 'astro/config';
import path from 'node:path';

const fixtureOutDir = process.env.DOTAINFO_FIXTURE_OUT_DIR;

export default defineConfig({
  output: 'static',
  ...(fixtureOutDir ? { outDir: path.resolve(fixtureOutDir) } : {}),
});
