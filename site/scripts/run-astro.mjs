import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.ASTRO_TELEMETRY_DISABLED = '1';

const astroCli = fileURLToPath(new URL('../node_modules/astro/bin/astro.mjs', import.meta.url));
const child = spawn(process.execPath, [astroCli, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(`Unable to start Astro: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});
