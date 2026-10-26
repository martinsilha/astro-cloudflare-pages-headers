# astro-cloudflare-pages-headers

Astro integration for Cloudflare static assets and Workers responses. It writes Cloudflare `_headers` rules into the static asset output and, when the official Cloudflare adapter is present, applies the same configured headers to Astro-generated Worker responses.

## Support

The package declares stable Astro `^4`, `^5`, `^6`, and `^7` support. Use a Cloudflare adapter version whose own peer dependencies include your Astro version. Astro 4 and 5 projects can target Pages or Workers according to their adapter version. Astro 6 and 7 Cloudflare SSR deployments use Workers; their official adapters no longer target Pages. Static sites can still deploy their generated assets to Pages.

The repository compatibility workflow builds the minimum and latest tested Astro/adapter pairs. Versions outside Astro 4–7, prereleases, future majors, and third-party adapters are not claimed as supported.

## Install

```sh
pnpm add astro-cloudflare-pages-headers
```

Use an Astro version accepted by your chosen Cloudflare adapter. The integration is published as compiled ESM with TypeScript declarations and supports Node 18.17.1 or newer; Astro and adapter runtime requirements still apply to your application.

## Cloudflare Workers

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import astroCloudflarePagesHeaders from 'astro-cloudflare-pages-headers';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [
    astroCloudflarePagesHeaders({
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
    }),
  ],
});
```

For Astro 4 hybrid output, use `output: 'hybrid'` and the compatible adapter release. In auto mode (the default), the integration registers Astro middleware for the official Cloudflare adapter. Static assets receive `_headers`; Astro responses such as SSR pages and endpoints receive the configured headers at runtime. If the application already sets a header, its value wins. This lets route code keep a nonce-based CSP or a private cache policy.

Set `runtime: false` to disable response middleware while keeping static `_headers` generation, or `runtime: true` to enable the portable middleware with another Astro adapter. Middleware only sees responses handled by Astro. It does not run for direct static asset delivery, platform redirects, Worker code that bypasses Astro, or exceptions Astro has not converted to a response.

## Static assets and Pages

A static project does not need a Cloudflare adapter to generate `_headers`:

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import astroCloudflarePagesHeaders from 'astro-cloudflare-pages-headers';

export default defineConfig({
  output: 'static',
  integrations: [
    astroCloudflarePagesHeaders({
      headers: {
        '/assets/*': { 'Cache-Control': 'public, max-age=31536000, immutable' },
        '/*': { 'X-Content-Type-Options': 'nosniff' },
      },
    }),
  ],
});
```

Deploy the generated static output using Cloudflare Pages or as Workers static assets. With no explicit `headers` option, the integration reads Astro's final `server.headers` value for backward compatibility. When `headers` is present, it is the complete source; `headers: {}` intentionally disables inherited header rules. Flat string maps apply to `/*`; nested maps associate header values with Cloudflare route patterns. A universal `*` is normalized to `/*` automatically.

If a custom adapter layout prevents reliable detection of the deployed static asset root, set `assetsDirectory` to an absolute path, a path relative to the Astro project root, or a file URL. The value must agree with a deployment path the adapter explicitly generated.

## Route rules

Rules support Cloudflare exact paths, one `*` wildcard, named `:placeholder` segments, and HTTPS host-qualified patterns. Placeholders can be used in header values. Query strings do not affect path matching. Host-qualified patterns require HTTPS and no port. Header names match case-insensitively. Invalid routes, header names, non-string values, and CR/LF values fail configuration rather than being written into `_headers`.

```js
astroCloudflarePagesHeaders({
  headers: {
    '/*': { 'X-Content-Type-Options': 'nosniff' },
    '/users/:id': { 'X-User-Route': 'user-:id' },
  },
});
```

The legacy `workers` option remains accepted but is deprecated and no longer needed for wildcard normalization.

The integration preserves existing `_headers` rules and its own generated section can be replaced on later builds. It fails a build when the output layout cannot be resolved, required file operations fail, or Cloudflare's 100-rule/2,000-character limits are exceeded. `csp.overflow: 'warn'` is an explicit escape hatch; Cloudflare may reject such output.

## CSP hashes

CSP hash generation is disabled by default. `csp: { autoHashes: true }` scans generated HTML during build and patches configured response-header policies. Route mode keeps the general policy as a fallback and creates per-page replacements; global mode adds the union of built hashes to each configured policy. Runtime HTML is never buffered or hashed. Dynamic pages need an application-generated CSP that covers their actual content.

Astro's native CSP remains independent. If both native CSP and integration-owned `Content-Security-Policy` rules are configured, both policies apply and the integration warns; choose one owner for script/style policy. CSP changes are described in the [2.0 migration guide](docs/migrations/2.0.md).

## Package exports

The package root is a compiled ESM integration with declarations. The optional `astro-cloudflare-pages-headers/middleware` subpath exports the runtime middleware entrypoint. Import the package by its public name; importing repository TypeScript source is not supported.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run types
pnpm run lint
pnpm run test:unit
pnpm run build:lib
```

The [compatibility workflow](.github/workflows/compatibility.yml) tests packed consumer builds against the pinned Astro/adapter matrix and static output builds. See [2.0 release notes](docs/releases/2.0.0.md) for breaking changes.
