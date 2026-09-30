import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const wranglerConfig = path.join(root, 'fixture-wrangler.jsonc');
const htmlHandling = process.env.FIXTURE_HTML_HANDLING;
if (process.env.FIXTURE_WITH_ADAPTER === 'true' && htmlHandling) {
  if (!['auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none'].includes(htmlHandling)) throw new Error('Unsupported fixture html_handling value: ' + htmlHandling);
  await fs.writeFile(wranglerConfig, JSON.stringify({ assets: { html_handling: htmlHandling } }, null, 2) + '\n');
} else {
  await fs.rm(wranglerConfig, { force: true });
}

const publicHeaders = await fs.readFile(path.join(root, 'templates', 'public-headers.txt'), 'utf8');
const manualAssetCacheRules = process.env.FIXTURE_WITH_ADAPTER === 'true' && process.env.FIXTURE_CACHE_MODE === 'manual'
  ? '\n/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/docs/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n'
  : '';
await fs.writeFile(path.join(root, 'public', '_headers'), publicHeaders + manualAssetCacheRules);

const routeFiles = new Map([
  ['./src/pages/api.json.ts', `export const prerender = false;

export function GET() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'X-Fixture-App': 'response',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "script-src 'nonce-app'",
    },
  });
}

export function HEAD() { return new Response(null, { status: 200, headers: { Allow: 'GET, HEAD, OPTIONS' } }); }

export function OPTIONS() { return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, OPTIONS' } }); }
`],
  ['./src/pages/api-plain.ts', "export const prerender = false;\nexport function GET() { return new Response(JSON.stringify({ ok: true })); }\n"],
  ['./src/pages/api-error.ts', `export const prerender = false;
export function GET() { return new Response('application-error', { status: 500 }); }
`],
  ['./src/pages/api-cookies.ts', `export const prerender = false;
export function GET() {
  const headers = new Headers();
  headers.append('Set-Cookie', 'first=one; Path=/');
  headers.append('Set-Cookie', 'second=two; Path=/');
  return new Response('cookies', { headers });
}
`],
  ['./src/pages/api-redirect.ts', `export const prerender = false;
export function GET({ url }) { return Response.redirect(new URL('/docs/', url), 307); }
`],
  ['./src/pages/api-stream.ts', `export const prerender = false;
export function GET() {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('first'));
    setTimeout(() => { controller.enqueue(new TextEncoder().encode('second')); controller.close(); }, 120);
  } });
  return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
}
`],
]);

const pureSsr = process.env.FIXTURE_PURE_SSR === 'true';
for (const pageName of ['index.astro', 'about.astro', 'plain.astro']) {
  const filename = path.join(root, 'src', 'pages', pageName);
  const source = await fs.readFile(filename, 'utf8');
  if (!/^export const prerender = (?:true|false);/m.test(source)) throw new Error(`Missing prerender declaration in ${filename}`);
  const updated = source.replace(/^export const prerender = (?:true|false);/m, `export const prerender = ${!pureSsr};`);
  await fs.writeFile(filename, updated);
}

const isWorkerBuild = process.env.FIXTURE_WITH_ADAPTER === 'true' && process.env.FIXTURE_OUTPUT_MODE !== 'static';
for (const [filename, contents] of routeFiles) {
  const file = new URL(filename, import.meta.url);
  if (isWorkerBuild) await fs.writeFile(file, contents);
  else await fs.rm(file, { force: true });
}
