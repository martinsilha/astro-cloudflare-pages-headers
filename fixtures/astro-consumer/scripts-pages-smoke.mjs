import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.dirname(fileURLToPath(import.meta.url));
const major = Number(process.env.FIXTURE_ASTRO_MAJOR);
const output = path.join(root, `output ${major}-pages`);
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const statePath = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-pages-headers-'));
const staticRoot = path.join(statePath, 'assets');
const baseRoot = path.join(staticRoot, 'docs');
await fs.mkdir(baseRoot, { recursive: true });
for (const entry of await fs.readdir(output)) {
  const source = path.join(output, entry);
  const destination = ['_headers', '_redirects', '.assetsignore'].includes(entry)
    ? path.join(staticRoot, entry)
    : path.join(baseRoot, entry);
  await fs.cp(source, destination, { recursive: true });
}
await fs.rm(path.join(root, '.wrangler'), { recursive: true, force: true });
const portServer = net.createServer();
await new Promise((resolve, reject) => {
  portServer.once('error', reject);
  portServer.listen(0, '127.0.0.1', resolve);
});
const port = portServer.address().port;
await new Promise((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [wrangler, 'pages', 'dev', staticRoot, '--ip', '127.0.0.1', '--port', String(port), '--compatibility-date', '2026-09-29', '--persist-to', statePath], {
  cwd: statePath,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-8000); });
server.stderr.on('data', (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-8000); });

try {
  let page;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const rootHtmlPath = process.env.FIXTURE_HTML_HANDLING === 'none' ? '/docs/index.html' : process.env.FIXTURE_HTML_HANDLING === 'drop-trailing-slash' ? '/docs' : '/docs/';
      page = await fetch(`${origin}${rootHtmlPath}`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if (page.status === 200) break;
    } catch {}
    if (server.exitCode !== null) throw new Error(`Wrangler Pages exited before serving the fixture (code ${server.exitCode}).\n${serverOutput}`);
    await delay(500);
  }
  if (!page || page.status !== 200) throw new Error(`Wrangler Pages did not serve /docs/ on ${origin}.\n${serverOutput}`);
  if (page.headers.get('x-fixture-header') !== `astro-${major}` || page.headers.get('x-shared-header') !== 'manual, configured') throw new Error('The generated and manual _headers rules were not merged by Wrangler Pages.');
  const html = await page.text();
  if (!html.includes('Static route')) throw new Error('The Pages response did not contain the built static route.');
  const stylesheet = html.match(/href="([^"]+\.css)"/)?.[1];
  if (!stylesheet) throw new Error('The Pages response did not reference a generated stylesheet.');
  const asset = await fetch(new URL(stylesheet, origin), { signal: AbortSignal.timeout(10000) });
  if (asset.status !== 200 || asset.headers.get('x-fixture-header') !== `astro-${major}` || asset.headers.get('x-shared-header') !== 'manual, configured') {
    throw new Error('The generated _headers rule did not apply to a static asset.');
  }
  await asset.arrayBuffer();
  if (process.env.FIXTURE_CSP_MODE === 'route' || process.env.FIXTURE_CSP_MODE === 'global') {
    const { assertCspResponses } = await import('./scripts-csp-assertions.mjs');
    await assertCspResponses(origin, process.env.FIXTURE_CSP_MODE);
  }
  console.log(`Wrangler Pages HTTP acceptance passed for Astro ${major} at ${origin}.`);
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(5000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await fs.rm(statePath, { recursive: true, force: true });
}
