import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import path from 'node:path';

const fixtureOutDir = process.env.DOTAINFO_FIXTURE_OUT_DIR;

export default defineConfig({
  site: 'https://dotainfo.pages.dev',
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap({
    filter: (page) => {
      const pathname = new URL(page).pathname;
      return pathname !== '/404/' && pathname !== '/404.html';
    },
  })],
  ...(fixtureOutDir ? { outDir: path.resolve(fixtureOutDir) } : {}),
});
