import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import astroCloudflarePagesHeaders, {
  type AstroCloudflarePagesHeadersOptions,
  type AstroConfig as LegacyAstroConfig,
  type AstroHeaders,
  type AstroIntegrationLogger as LegacyAstroLogger,
} from 'astro-cloudflare-pages-headers';

const options = {
  headers: {
    '/*': { 'X-Content-Type-Options': 'nosniff' },
    '/users/:id': { 'X-User-Route': 'user-:id' },
  },
  runtime: 'auto',
  assetsDirectory: new URL('./assets/', import.meta.url),
  csp: { autoHashes: true, mode: 'route', overflow: 'error' },
  workers: true,
} satisfies AstroCloudflarePagesHeadersOptions;

const legacyPublicTypes: [LegacyAstroConfig['base'], LegacyAstroLogger['info'], AstroHeaders] = [
  '/',
  () => undefined,
  { 'X-Legacy-Type': 'accepted' },
];
void legacyPublicTypes;

export default defineConfig({
  adapter: cloudflare(),
  integrations: [astroCloudflarePagesHeaders(options)],
});
