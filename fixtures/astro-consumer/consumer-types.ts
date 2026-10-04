import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import astroCloudflarePagesHeaders, {
  type AstroCloudflarePagesHeadersOptions,
  type AstroConfig as LegacyAstroConfig,
  type AstroHeaders,
  type AstroIntegrationLogger as LegacyAstroLogger,
} from "astro-cloudflare-pages-headers";

const options = {
  headers: {
    "/*": { "X-Content-Type-Options": "nosniff" },
    "/users/:id": { "X-User-Route": "user-:id" },
  },
  runtime: "auto",
  assetsDirectory: new URL("./assets/", import.meta.url),
  csp: { autoHashes: true, mode: "route", overflow: "error" },
  workers: true,
} satisfies AstroCloudflarePagesHeadersOptions;

const legacyPublicTypes: [
  LegacyAstroConfig["base"],
  LegacyAstroLogger["info"],
  AstroHeaders,
] = ["/", () => undefined, { "X-Legacy-Type": "accepted" }];
void legacyPublicTypes;

export default defineConfig({
  adapter: cloudflare(),
  integrations: [astroCloudflarePagesHeaders(options)],
});

import { onRequest as headersMiddleware } from "astro-cloudflare-pages-headers/middleware";
void headersMiddleware;

const invalidRuntime: AstroCloudflarePagesHeadersOptions = {
  // @ts-expect-error unsupported public option values must stay rejected
  runtime: "sometimes",
};
void invalidRuntime;

const invalidCspMode: AstroCloudflarePagesHeadersOptions = {
  csp: {
    // @ts-expect-error CSP mode only accepts the declared modes
    mode: "current",
  },
};
void invalidCspMode;

const invalidHeaderValue: AstroCloudflarePagesHeadersOptions = {
  headers: {
    "/*": {
      // @ts-expect-error Cloudflare header values are strings
      "X-Invalid": 42,
    },
  },
};
void invalidHeaderValue;
