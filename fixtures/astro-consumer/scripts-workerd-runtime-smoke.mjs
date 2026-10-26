import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.dirname(fileURLToPath(import.meta.url));
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-headers-workerd-'));
const configPath = path.join(root, '.wrangler-runtime-smoke.jsonc');
const port = Number(process.env.FIXTURE_WORKER_PORT ?? 45741);
const origin = `http://127.0.0.1:${port}`;
const define = JSON.stringify({
  enabled: true,
  routes: {
    '/*': { 'X-Worker-Runtime': 'workerd', 'Content-Security-Policy': "script-src 'self'" },
    '/api': { 'X-Worker-Route': 'api' },
  },
});
await fs.writeFile(configPath, JSON.stringify({
  name: 'astro-headers-workerd-runtime-smoke',
  main: './worker-runtime-smoke.mjs',
  compatibility_date: '2026-09-29',
  define: { __ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__: define },
}, null, 2));
const server = spawn(process.execPath, [wrangler, 'dev', '--config', configPath, '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state], {
  cwd: root,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-8000); });
server.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-8000); });

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${origin}/missing`, { signal: AbortSignal.timeout(1000) });
      ready = true;
      break;
    } catch {}
    if (server.exitCode !== null) throw new Error(`Wrangler workerd exited before serving the fixture (code ${server.exitCode}).\n${output}`);
    await delay(250);
  }
  if (!ready) throw new Error(`Wrangler workerd did not start at ${origin}.\n${output}`);

  const response = await fetch(`${origin}/api`);
  if (response.status !== 200 || response.headers.get('x-worker-runtime') !== 'workerd' || response.headers.get('x-worker-route') !== 'api') {
    throw new Error(`GET did not pass through middleware: status=${response.status}, headers=${JSON.stringify(Object.fromEntries(response.headers))}.`);
  }
  if (response.headers.get('content-security-policy') !== "script-src 'nonce-worker-app'" || response.headers.get('cache-control') !== 'private, no-store' || await response.text() !== '{"ok":true}') {
    throw new Error('Application CSP, private cache policy, or response body was changed.');
  }

  const head = await fetch(`${origin}/api`, { method: 'HEAD' });
  if (head.status !== 200 || head.headers.get('x-worker-runtime') !== 'workerd' || (await head.text()) !== '') {
    throw new Error('HEAD response did not retain its bodyless status while receiving middleware headers.');
  }

  const options = await new Promise((resolve, reject) => {
    const request = httpRequest(new URL('/api', origin), { method: 'OPTIONS' }, (response) => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    request.setTimeout(10000, () => request.destroy(new Error('OPTIONS request timed out.')));
    request.once('error', reject);
    request.end();
  });
  if (options.status !== 204 || options.headers.allow !== 'GET, HEAD, OPTIONS' || options.headers['x-worker-runtime'] !== 'workerd' || options.headers['x-worker-route'] !== 'api') {
    throw new Error(`Application OPTIONS route did not receive configured headers: ${JSON.stringify(options)}.`);
  }

  const websocket = await new Promise((resolve, reject) => {
    const request = httpRequest(new URL('/websocket', origin), {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
      },
    });
    request.setTimeout(10000, () => request.destroy(new Error('WebSocket upgrade timed out.')));
    request.once('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, headers: response.headers });
    });
    request.once('response', (response) => {
      response.resume();
      reject(new Error(`WebSocket request did not upgrade: ${response.statusCode}.`));
    });
    request.once('error', reject);
    request.end();
  });
  if (websocket.status !== 101 || websocket.headers['x-application-websocket'] !== 'preserved' || websocket.headers['x-worker-runtime']) {
    throw new Error(`WebSocket upgrade was changed by middleware: ${JSON.stringify(websocket)}.`);
  }

  console.log(`Packed middleware GET, HEAD, OPTIONS, and WebSocket checks passed in local workerd at ${origin}.`);
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(5000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await fs.rm(configPath, { force: true });
  await fs.rm(state, { recursive: true, force: true });
}
