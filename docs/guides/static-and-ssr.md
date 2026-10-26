# Static and SSR headers with v2

Use `astro-cloudflare-pages-headers` when you want to keep Astro's static asset headers and Astro-generated response headers in one configuration. You still choose which headers your application needs; the integration does not supply a security policy by default.

## Static site: Pages or Workers static assets

Install v2 in an existing Astro project:

```sh
pnpm add astro-cloudflare-pages-headers@^2
```

No Cloudflare adapter is required for a fully static build:

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import astroCloudflarePagesHeaders from 'astro-cloudflare-pages-headers';

export default defineConfig({
  output: 'static',
  integrations: [
    astroCloudflarePagesHeaders({
      headers: {
        '/*': {
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
        '/_astro/*': {
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      },
    }),
  ],
});
```

Build with `pnpm exec astro build`. With Astro's default output layout, inspect `dist/_headers`, then deploy `dist/` using your existing Pages or Workers static assets setup. The generated file contains the configured rules inside integration-owned markers. Existing manually maintained rules are preserved.

The long cache lifetime is scoped to Astro's default fingerprinted `/_astro/` assets. Do not copy it onto HTML, user-specific responses or files whose contents change without a URL change. If you customize `base` or `build.assets`, adjust the route to the actual public asset URL, for example `/docs/_astro/*` for `base: '/docs/'`.

## SSR: Astro responses on Cloudflare Workers

Use the official `@astrojs/cloudflare` adapter compatible with your Astro version. The example below is suitable for Astro 7 with adapter 14; follow the adapter's setup for Wrangler and deployment. Astro 6/7 Cloudflare SSR targets Workers, not Pages SSR.

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
        '/*': {
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      },
    }),
  ],
});
```

The integration writes static `_headers` rules and automatically registers Astro middleware for the official adapter. On responses that pass through Astro, it supplies a configured header only if that response does not already have it. No second middleware import is needed.

For an on-demand page, set response-specific policy in the page itself:

```astro
---
// src/pages/request.astro
export const prerender = false;
Astro.response.headers.set('Cache-Control', 'private, no-store');
---
<html lang="en">
  <head><title>Request example</title></head>
  <body><p>This page is rendered on demand.</p></body>
</html>
```

Or add this endpoint:

```ts
// src/pages/api/status.ts
export const prerender = false;

export function GET() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
```

After deploying through your normal process, inspect a GET response:

```sh
curl -sS -D - -o /dev/null https://YOUR-HOST/api/status
```

Expect `X-Content-Type-Options: nosniff` from the integration, but `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store` from the endpoint. The configured referrer policy does not overwrite the application's value. A GET to `/request` should have the configured defaults and the page's private cache policy. Check a real static asset URL separately: direct asset responses use Cloudflare's `_headers` handling, not Astro middleware. `astro dev` alone does not verify Cloudflare asset handling.

## Boundaries to check before adopting

- `runtime: false` keeps static generation but disables response middleware. `runtime: true` opts into portable Astro middleware with another adapter; it does not add Cloudflare asset hosting to that adapter.
- All matching configured route rules contribute values. Repeating a header across broad and narrow rules can combine its values; a more specific route is not a general override mechanism. Avoid overlapping `Cache-Control` rules with contradictory directives.
- Manual `_headers` content is preserved, but it is not imported as runtime configuration. Put shared defaults in the integration's `headers` option.
- Middleware covers Astro-handled responses. It cannot change platform redirects, direct asset delivery, custom Worker paths that bypass Astro, unconverted exceptions or WebSocket upgrade responses. It does not create CORS preflight endpoints.
- Keep application-specific cookies, authentication, cache decisions and nonce CSP in application code. A configured header is a default, not an enforced override of application policy.
- CSP auto-hashing is opt-in and scans build-generated HTML only. It cannot hash dynamic SSR content. Astro native CSP and response-header CSP both apply if enabled together; choose one owner for script/style policy and test the final response.

See the [migration walkthrough](../migrations/2.0.md) for existing projects and the [README](../../README.md#route-rules) for route syntax and output limits.
