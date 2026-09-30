import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const rows = [
  ['4.0.0', '8.1.0', '3.114.17'],
  ['4.16.19', '11.2.0', '3.114.17'],
  ['5.0.0', '12.0.0', '4.59.2'],
  ['5.18.2', '12.6.13', '4.59.2'],
  ['6.0.0', '13.0.0', '4.144.0'],
  ['6.4.8', '13.7.0', '4.144.0'],
  ['7.0.0', '14.0.0', '4.144.0'],
  ['7.3.5', '14.3.3', '4.144.0'],
];

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed for Astro ${env.FIXTURE_ASTRO_VERSION}.`);
}

const lockDirectory = path.join(root, 'locks');
await fs.mkdir(lockDirectory, { recursive: true });
for (const [astro, adapter, wrangler] of rows) {
  const env = { ...process.env, FIXTURE_ASTRO_VERSION: astro, FIXTURE_ADAPTER_VERSION: adapter, FIXTURE_WRANGLER_VERSION: wrangler };
  run('node', ['scripts-prepare-fixture.mjs'], env);
  run('pnpm', ['install', '--lockfile-only', '--no-frozen-lockfile'], env);
  await fs.copyFile(path.join(root, 'pnpm-lock.yaml'), path.join(lockDirectory, `astro-${astro}.yaml`));
  console.log(`Updated lockfile for Astro ${astro}, adapter ${adapter}, Wrangler ${wrangler}.`);
}
