import { defineConfig } from 'astro/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cloudflare from '@astrojs/cloudflare';
import astroCloudflarePagesHeaders from 'astro-cloudflare-pages-headers';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const astroMajor = Number(process.env.FIXTURE_ASTRO_MAJOR);
const withAdapter = process.env.FIXTURE_WITH_ADAPTER !== 'false';
const variant = withAdapter ? 'workers' : 'pages';
const cacheMode = process.env.FIXTURE_CACHE_MODE ?? 'default';
const layoutMode = process.env.FIXTURE_LAYOUT ?? 'custom';
const outputMode = process.env.FIXTURE_OUTPUT_MODE ?? 'server';
const cspMode = process.env.FIXTURE_CSP_MODE;
const policy = cspMode === 'native-only' ? undefined : cspMode ? "default-src 'self'; script-src 'self'; style-src 'self', default-src 'none'; script-src https://scripts.example; style-src https://styles.example" : "default-src 'self'; script-src 'self'";
const configuredPolicy = process.env.FIXTURE_CSP_MIXED_CASE === 'true' && policy
  ? policy.replace(/\b(default-src|script-src(?:-elem)?|style-src(?:-elem|-attr)?)(?=\s)/gi, (name) => name.toUpperCase())
  : policy;
const globalHeaders = { 'X-Fixture-Header': 'astro-' + astroMajor, 'X-Shared-Header': 'configured', ...(configuredPolicy ? { 'Content-Security-Policy': configuredPolicy } : {}) };
let headers = globalHeaders;
if (cspMode && cspMode !== 'native-only') {
  headers = {
    '/docs/about/': { 'X-Csp-Order': 'exact' },
    '/docs/about/index.html': { 'X-Csp-Order': 'exact' },
    '/*': { ...globalHeaders, 'X-Csp-Order': 'general' },
  };
}
if (cacheMode === 'broad') headers = { ...globalHeaders, 'Cache-Control': 'public, max-age=60' };
if (cacheMode === 'full') headers = {
  '/*': { ...globalHeaders, 'Cache-Control': 'public, max-age=60' },
  '/docs/_astro/*': { 'Cache-Control': 'public, max-age=300' },
};
if (cacheMode === 'narrow') headers = { '/*': { ...globalHeaders }, '/docs/_astro/*.css': { 'Cache-Control': 'public, max-age=300' } };
if (withAdapter) {
  if (Object.values(headers).some((value) => typeof value === 'string')) headers = { '/*': headers };
  headers['/docs/api-cookies'] = { 'Set-Cookie': 'integration=must-not-replace; Path=/' };
}
const outputDirectory = layoutMode === 'default' ? './dist/' : `./output ${astroMajor}-${variant}/`;
const customBuildPaths = layoutMode === 'custom' && astroMajor >= 6;
const extraLimitRules = Number(process.env.FIXTURE_LIMIT_RULES ?? 0);
if (withAdapter && Number.isInteger(extraLimitRules) && extraLimitRules > 0) {
  for (let index = 0; index < extraLimitRules; index += 1) {
    headers[`/fixture-limit-${index}`] = { 'X-Limit-Probe': 'ok' };
  }
}
let fixtureCacheDirectory;
const fixtureCacheIntegration = {
  name: 'fixture-cache-rule-from-another-integration',
  hooks: {
    'astro:config:setup': ({ config }) => {
      const client = config.build.client;
      if (client instanceof URL) fixtureCacheDirectory = client.protocol === 'file:' ? fileURLToPath(client) : undefined;
      else if (typeof client === 'string') fixtureCacheDirectory = client.startsWith('file:') ? fileURLToPath(new URL(client)) : path.resolve(fixtureRoot, client);
    },
    'astro:build:done': async () => {
      if (cacheMode !== 'integration' || !fixtureCacheDirectory) return;
      await fs.mkdir(fixtureCacheDirectory, { recursive: true });
      const filename = path.join(fixtureCacheDirectory, '_headers');
      let prior = '';
      try {
        prior = await fs.readFile(filename, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.writeFile(filename, `${prior}${prior && !prior.endsWith('\n') ? '\n' : ''}# Added by another fixture integration\n/docs/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n`);
    },
  },
};

export default defineConfig({
  adapter: withAdapter ? cloudflare(process.env.FIXTURE_HTML_HANDLING ? { configPath: './fixture-wrangler.jsonc' } : {}) : undefined,
  output: withAdapter ? (outputMode === 'static' ? 'static' : (astroMajor === 4 ? 'hybrid' : 'server')) : 'static',
  base: layoutMode === 'default' ? '/' : '/docs/',
  outDir: outputDirectory,
  build: {
    ...(layoutMode === 'custom' ? { format: process.env.FIXTURE_BUILD_FORMAT ?? 'directory' } : {}),
    inlineStylesheets: 'never',
    ...(customBuildPaths ? { client: `./client ${astroMajor}/`, server: `./server ${astroMajor}/` } : {}),
  },
  integrations: [
    fixtureCacheIntegration,
    astroCloudflarePagesHeaders({
      headers,
      runtime: process.env.FIXTURE_RUNTIME === 'false' ? false : 'auto',
      ...(cspMode && cspMode !== 'native-only' ? { csp: { autoHashes: process.env.FIXTURE_CSP_AUTO_HASHES !== 'false', mode: cspMode === 'global' ? 'global' : 'route' } } : {}),
    }),
  ],
  ...(process.env.FIXTURE_NATIVE_CSP === 'true' ? { security: { csp: true } } : {}),
});
