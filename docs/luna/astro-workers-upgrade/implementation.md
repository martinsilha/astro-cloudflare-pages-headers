# Implementation guide

This is the behavior and compatibility contract for the upgrade. See [acceptance criteria](acceptance-criteria.md) and the [completion report](completion-report.md) for observed evidence and remaining gaps. Treat unchecked items as unfinished release work; requirements below still govern behavior even where the current implementation has not yet been fully exercised.

## 1. Compatibility and packaging

Keep the package name, default export, and existing exported option/type names. Declare the supported Astro peer range as `^4.0.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`.

The following fixture pairs were checked against published package metadata on 2026-09-29. Minimum-major fixtures prevent a latest-only test matrix from overstating support.

| Astro | Cloudflare adapter | Fixture role |
| --- | --- | --- |
| 4.0.0 | 8.1.0 | Astro 4 lower bound |
| 4.16.19 | 11.2.0 | Latest Astro 4 snapshot |
| 5.0.0 | 12.0.0 | Astro 5 lower bound |
| 5.18.2 | 12.6.13 | Latest Astro 5 snapshot |
| 6.0.0 | 13.0.0 | Astro 6 lower bound |
| 6.4.8 | 13.7.0 | Latest Astro 6 snapshot |
| 7.0.0 | 14.0.0 | Astro 7 lower bound |
| 7.3.5 | 14.3.3 | Latest Astro 7 snapshot |

At implementation time, verify registry metadata again and refresh latest-within-major rows to compatible stable versions. Retain lower-bound rows. Pin fixture dependencies and their required Wrangler versions in lockfiles. Do not install the newest adapter against every Astro version: for example, adapter 13.7 requires Astro `^6.3.0`, and 14.3.3 requires `^7.2.0`.

Use Node 24 for development and the main CI matrix, plus the older-Node consumer check specified in the acceptance document. Publish compiled ESM JavaScript and TypeScript declarations, with explicit `.js` internal imports, a `types` export condition, and separate runtime middleware output. Set a package engine floor compatible with Node 18.17.1. Do not import newer Node APIs into the library merely because the development toolchain uses Node 24. Astro 6–7 consumers still need their own Astro-required Node version, currently at least 22.12.0.

Replace the root site's `astro check && astro build` package-build script with a library compilation step. Add a prepack build and ensure release verification exercises the exact packed artifact. Exclude tests, fixtures, this handoff, and development-only files from the published package. Preserve existing public type exports; deprecate misleading legacy helper types in documentation instead of silently deleting them.

## 2. Public configuration and lifecycle

Extend the existing options type with:

```ts
headers?: AstroHeaders;
runtime?: "auto" | boolean; // default: "auto"
assetsDirectory?: string | URL; // optional explicit static asset output root
```

- `headers` accepts the existing flat string-header map or nested route-to-string-header map. If provided, it is the complete configuration source, including an explicitly empty object. Otherwise read final `config.server.headers` for backward compatibility. Do not merge the two sources implicitly.
- `runtime: "auto"` enables middleware for the official `@astrojs/cloudflare` adapter, including projects with mostly prerendered routes. `false` disables middleware while retaining file generation. `true` explicitly enables the portable Astro middleware with another adapter; official support and CI remain focused on Cloudflare.
- `assetsDirectory` is an escape hatch for custom build layouts. Resolve relative strings against `config.root`, preserve absolute paths, and convert file URLs with `fileURLToPath`. It affects generated files and does not rewrite Wrangler configuration. Reject a conflict with a known deployment asset directory.
- Keep `workers` accepted for source compatibility. Normalize the universal `*` route to `/*` for both Pages and Workers in 2.0; mark `workers` unnecessary/deprecated. When both keys exist, merge their headers case-insensitively with explicit `/*` values winning, retaining the existing warning.
- Retain the existing `csp` option names and defaults, including disabled auto-hashing by default, route mode, and the explicit overflow warning escape hatch.

Flat headers apply to `/*`. Treat configured paths as deployed URL paths, without automatically prepending `base` to user rules. `base` must be accounted for when mapping generated HTML to those paths.

Validate configuration with actionable errors: reject mixed flat/nested shapes, non-string header values, invalid header names, CR/LF injection, and invalid route syntax. Do not silently stringify objects or arrays. The legacy nested `server.headers` format remains accepted by this integration, but recommend `headers` for nested rules because Astro types `server.headers` as ordinary HTTP headers.

- During `astro:config:setup`, register the Vite configuration bridge and middleware unless `runtime` is false. Use a string middleware entrypoint for Astro 4 compatibility.
- During `astro:config:done`, capture final headers and resolve auto activation. Expose an immutable normalized copy through a private Vite virtual module. Auto mode becomes a no-op without a Cloudflare adapter; headers set by another integration during setup are visible regardless of integration order.
- On configuration restarts, replace the old rules rather than accumulating them.

Return a properly typed `AstroIntegration`; remove the double `unknown` assertion. Avoid removed APIs such as `astro:build:done.routes` and assumptions about one Vite major. Keep filesystem access and Node hashing in build-time modules; the middleware dependency graph must contain only runtime-safe code.

## 3. Static assets and output layout

Keep two distinct locations: the rendered HTML directory supplied as `astro:build:done.dir`, and the static asset root Cloudflare deploys. The current `getBuildDir` incorrectly prefixes the working directory onto external absolute file URLs; replace this behavior with normal URL/path conversion.

Use this destination resolution order:

1. Read any generated Wrangler deployment configuration at the adapter's build output and resolve `assets.directory` relative to that configuration. This is authoritative when present. Do not mistake the project's source Wrangler file for the generated deployment configuration.
2. Honor an explicit `assetsDirectory` when no deployment path is available; if both exist, require agreement.
3. Without either, use the known adapter layout: official Cloudflare adapters 8–12 deploy from resolved `config.outDir`; adapters 13–14 deploy from the original client output directory before their `config:done` base-path mutation. Capture that original URL during setup, after the adapter's setup when it precedes this integration.
4. Without the Cloudflare adapter, use the build hook's `dir`. If an unknown adapter generation or ambiguous Cloudflare layout prevents a reliable choice, fail with guidance to supply `assetsDirectory`; do not guess from folder existence.

Resolve installed adapter metadata from the consuming project's root. Do not infer adapter generation from Astro's major. Never strip `base` blindly: adapter 13.0 and later 13.x releases differ. Generated deployment configuration takes priority over an earlier directory snapshot if another integration changed the final layout.

Read existing `_headers` files at both the rendered directory and asset root before writing. Parse existing rules with their order and removal semantics intact; preserve public/manual rules and adapter-added rules. Merge distinct content deterministically and coalesce shared paths into one block without losing effective values. Do not duplicate identical copied files or append duplicate path blocks: Cloudflare replaces duplicate path entries rather than combining them. Track owned additions with delimited markers at the block or field level so repeated builds replace them while retaining unowned input. Fail with a diagnostic if a merge cannot preserve unowned semantics. Only remove a nested copy after preserving its contents and confirming its relocation is owned by the supported adapter flow.

Astro exposes Cloudflare through `config.adapter`; do not treat it as a positional item in the user's `config.integrations` list or attempt to reorder it. Write headers to the resolved asset directory during `astro:build:generated` and reconcile them against the final deployment directory during `astro:build:done`. When Astro or the adapter relocates a nested base directory between those hooks, read both locations and preserve the completed rules so relocation cannot restore stale content. Check the final Worker assets root and keep `_headers` out of the server bundle.

The generated Wrangler `assets.directory` is authoritative when available. Use the known adapter layout only for legacy generations that do not emit deployment metadata, and fail when a custom layout cannot be determined. Verify adapter 13.0 and 13.7 with a nonroot base because their output relocation differs. The `astro:build:done` pass must retain adapter-added rules, including immutable caching. A global or full asset-pattern `Cache-Control` rule must be visible early enough for the current adapter to skip its automatic immutable rule.

Do not identify an adapter-generated rule merely by its text: a manual rule can be identical and there is no provenance marker. Preserve all unowned cache directives. For a narrower overlapping asset rule, or any preserved manual cache policy that conflicts with the requested effective value, fail with a targeted diagnostic and guidance to use a full asset-pattern rule or reconcile the manual policy. Never silently delete the unowned rule or claim that later file order overrides it; Cloudflare combines matching values. The cache-collision acceptance tests must prove the resulting HTTP value, not just file contents.

Validate the complete emitted file, including preserved and generated rules, against Cloudflare's 100-rule and 2,000-character-per-line limits. Account for known later adapter additions when it runs after this integration. Keep `csp.maxHeaderLineLength` as a potentially stricter limit; it cannot raise Cloudflare's limit. Default to build failure on overflow; the existing explicit `csp.overflow: "warn"` may log and continue, clearly stating that Cloudflare can reject the output. Missing configuration produces no generated section and leaves existing files intact.

Fail the build on malformed configuration, unresolved output layout, required filesystem failures, or CSP scan failures. Validate known configuration errors before provisional generation; errors found later must stop finalization and must not report provisional files as deployable output. Include the affected path/route in diagnostics. Do not retain the current log-and-succeed behavior for failed output.

## 4. Runtime headers

Use injected Astro middleware with `order: "pre"`, applying headers after `await next()` so normal page, endpoint, and downstream middleware responses are covered. The runtime bridge contains the original normalized rules, never static CSP-expanded rules.

Support Cloudflare's documented path and HTTPS-host route forms: exact paths, one splat, named placeholders, and placeholder substitution in header values. Ignore query strings when matching. Host-qualified rules must start with HTTPS and omit a port, but matching ignores the incoming request's scheme and port, as Cloudflare does. Match header names case-insensitively. Evaluate rules in declaration order and combine repeated matching configured values as Cloudflare does. Reject invalid patterns at configuration time rather than interpreting them differently between static and runtime output.

Resolve matching configured headers first, then fill only headers absent from the application's response. Existing response headers win, including CSP with nonces, cache policy, and cookies. This is intentional runtime precedence: application code can specialize a response. Preserve status, status text, body stream, and distinct `Set-Cookie` headers. Do not buffer, hash, decode, or rewrite response bodies. Leave WebSocket upgrade responses unchanged. Do not synthesize responses for exceptions that Astro itself has not converted into a response.

Apply the same rules to GET, HEAD, and OPTIONS responses that pass through Astro. This adds headers; it does not create an OPTIONS endpoint or CORS policy. Cover Astro-handled redirects, errors, and not-found responses. Platform redirects, Worker code that bypasses Astro, and assets served directly by Cloudflare remain outside middleware coverage; static assets use `_headers`.

## 5. CSP preservation

Keep auto-hashing a build-time feature for generated HTML. Runtime pages retain their configured CSP or their application-produced CSP; build-time hashes do not make dynamic inline content safe automatically.

For route mode:

1. Scan actual generated HTML and map it to served paths using `base`, `build.format`, and the deployment's HTML handling. Read resolved/generated Workers `assets.html_handling`; use its `auto-trailing-slash` default when absent. Handle explicit force/drop trailing-slash and `none` modes even when they differ from Astro's trailingSlash setting. For Pages, use its served-URL behavior. Cover equivalent HTML URLs that the platform serves without redirecting. Do not scan Worker bundles as HTML.
2. Preserve original CSP rules, including wildcard fallbacks. Compute every matching configured policy for a generated page, including pages with no inline hashes. Preserve the intersection when multiple CSP policies match: patch each independently, then serialize their combined value.
3. Emit exact route overrides after the general rules. Use an internal removal instruction followed by the replacement policy:

   ```text
   /docs/about/
     ! Content-Security-Policy
     Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-...';
   ```

4. Consolidate an existing exact path block rather than emitting duplicate path blocks. When moving it after general rules would change repeated non-CSP values, reconstruct each affected field's original effective value with an internal removal-and-replacement pair as well. For example, preserve `exact, general` rather than changing it to `general, exact`. Reject a transformation whose unowned/manual semantics cannot be resolved. This removes the unpatched CSP for that page while retaining fallback protection for other URLs and non-HTML assets.
5. If route mode cannot safely resolve a host-dependent policy or a conflicting preserved manual CSP rule, fail finalization with guidance to use global mode or explicit path rules. Do not silently remove or broaden the original policy. Global mode must also reject conflicts it cannot preserve safely.

For SPA fallback HTML and custom 404 HTML served at arbitrary request paths, exact file-route overrides are insufficient. Route auto-hashing must fail with guidance to use global mode when such fallback HTML contains enabled inline hash categories; do not claim an exact `/404/` or `/` rule covers every fallback request. A fallback with no hashes to inject retains the original policy.

Removal metadata is an internal serialization detail, not a new public deletion API. Cloudflare's current Workers and Pages implementations process removals before additions within a matching rule; prove this with actual local serving tests.

Retain global mode, which adds the union of built HTML hashes to each configured policy. In either mode, inherit existing CSP directive fallback sources when adding hashes; do not invent `'self'` when `default-src` or another applicable fallback says otherwise. If a category has neither an explicit directive nor a restricting fallback, leave it absent and unrestricted; auto-hashing must not turn a frame-ancestors-only policy into a new script/style restriction. Retain hash-category controls, deduplication, deterministic output, and the existing explicit unsafe-inline behavior. Do not mutate the user's configuration.

Preserve Astro's native CSP output. Astro 6–7 can emit a CSP meta element, so absence of a response header does not mean absence of policy. When native CSP and integration-owned CSP are both configured, warn once about intersecting policies and recommend one script/style policy owner. Do not automatically merge, remove, or rewrite native CSP or its meta element. Do not emit a CSP merely because native CSP is enabled.

## 6. Work sequence and release preparation

| Step | Deliverable | Exit evidence |
| --- | --- | --- |
| 1 | Record the baseline, preserve unrelated work, and create independent fixture projects. | G1; pinned compatibility matrix. |
| 2 | Compile and pack the library as ESM with declarations and runtime entrypoint. | P1–P4. |
| 3 | Implement typed options, immutable rules, final configuration capture, early header generation, existing-file preservation, and output resolution. | C1–C6, S1–S5. |
| 4 | Add runtime middleware and route matching. | R1–R7. |
| 5 | Repair CSP generation and failure handling. | S6–S8, H1–H8. |
| 6 | Run real build/HTTP fixtures and wire checks into CI and release gating. | M1–M5. |
| 7 | Update user-facing README, migration guide, and 2.0 release notes. | D1–D3; all remaining acceptance rows verified. |

Run cheap type/lint/unit checks before the build matrix and Workers tests. CI must run noninteractive tests, cover pull requests to both release branches, and gate publishing on the package and compatibility jobs. Increase existing three-minute job timeouts to accommodate real builds. Use the existing semantic-release process and a documented breaking-change release; do not manually publish as part of implementation validation.

User documentation must lead with Workers examples using the integration-owned `headers` option, explain static versus runtime precedence, retain Pages examples for supported combinations, and document runtime opt-out, `workers` deprecation, compiled package exports, CSP limits, native CSP interaction, and new build-failure behavior.

## Sources and verification notes

The technical research snapshot is dated 2026-09-29. Recheck mutable documentation and registry versions when implementation begins. The agreed behavior above is the contract; links below substantiate platform constraints rather than overriding it silently.

- [Astro integration API](https://docs.astro.build/en/reference/integrations-reference/): lifecycle hooks, `addMiddleware`, and the Astro 5 addition of URL middleware entrypoints.
- [Astro Cloudflare adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/): static headers, Workers runtime, and removal of Pages support in adapter 13.
- [Astro 6 upgrade guide](https://docs.astro.build/en/guides/upgrade-to/v6/): Node requirement and integration/build changes.
- [Astro native CSP configuration](https://docs.astro.build/en/reference/configuration-reference/#securitycsp): native policy generation and options.
- [Cloudflare HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/): actual served paths and redirects for each HTML handling mode.
- [Cloudflare Workers static headers](https://developers.cloudflare.com/workers/static-assets/headers/): static-only scope, matching, combination, removal syntax, and limits.
- [Workers header implementation](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-shared/asset-worker/src/utils/headers.ts), [Pages asset handler](https://github.com/cloudflare/workers-sdk/blob/main/packages/pages-shared/asset-server/handler.ts), and [Workers header tests](https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-shared/asset-worker/tests/handler.test.ts): ordered removal and replacement behavior. These source links are mutable; record tested package versions with acceptance evidence.
- Published metadata: [Astro 7.3.5](https://registry.npmjs.org/astro/7.3.5) and [Cloudflare adapter 14.3.3](https://registry.npmjs.org/@astrojs/cloudflare/14.3.3).
- Published adapter sources: [12.6.13](https://registry.npmjs.org/@astrojs/cloudflare/-/cloudflare-12.6.13.tgz), [13.0.0](https://registry.npmjs.org/@astrojs/cloudflare/-/cloudflare-13.0.0.tgz), [13.7.0](https://registry.npmjs.org/@astrojs/cloudflare/-/cloudflare-13.7.0.tgz), and [14.3.3](https://registry.npmjs.org/@astrojs/cloudflare/-/cloudflare-14.3.3.tgz). Inspect `dist/index.js` and, where present, `dist/utils/headers.js` for layout and generated cache rules.
