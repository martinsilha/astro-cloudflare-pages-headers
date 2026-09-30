# Acceptance criteria

Check an item only when its full expected result has been observed. Current checked items reflect local evidence; unchecked items remain open even when implementation code exists. Record commands, resolved package versions, fixtures, and evidence in the linked [completion report](completion-report.md). An unavailable environment is an incomplete gate, not a passing check.

## Guardrails and package contract

- [x] **G1 — Focused changes.** Existing unrelated changes, including the untracked `demo/`, remain intact. Fixtures are independent of that directory. No live Cloudflare resources or npm releases are needed to validate the upgrade.
- [x] **P1 — Published artifact.** Packing the package produces compiled ESM and declarations. A clean consumer imports its default export using native Node without a TypeScript loader. Tests and development fixtures are absent from the tarball.
- [x] **P2 — Public types.** Existing named type imports and default integration usage still type-check. The new options type-check in real consumer configs on every matrix row. No double `unknown` assertion masks integration incompatibilities.
- [x] **P3 — Version claims.** Peers admit stable Astro 4–7 and exclude Astro 3, Astro 8, and prereleases. Each matrix pair satisfies its actual adapter peer dependencies. The packed library works in an Astro 4 consumer on Node 18.20.8 without raising its engine floor to Node 22.
- [x] **P4 — Build and release.** Library build and prepack produce the same importable artifact. Release verification builds, packs, and tests before semantic-release can publish. Source-only export assumptions are removed from examples and package metadata.

## Configuration

- [x] **C1 — Input sources.** Flat and nested `headers` options generate expected rules. Omitted `headers` reads final `server.headers`. Explicit `headers` wins completely, and `{}` disables inherited rules. Missing rules preserve existing `_headers` content without adding an empty generated block.
- [x] **C2 — Lifecycle and immutability.** Another integration can set headers during setup before or after this integration; static output and runtime see its final values. The original objects remain unchanged after wildcard normalization, CSP processing, repeated builds, and dev configuration restarts. Removed rules do not linger after a restart.
- [x] **C3 — Wildcards and validation.** `*` becomes `/*` for both targets. An explicit `/*` value wins case-insensitively when both exist, with a warning. Mixed shapes, invalid names, non-string values, CR/LF input, and malformed patterns fail with a useful configuration error.
- [x] **C4 — Runtime selection.** Auto mode enables runtime with the official Cloudflare adapter and is inactive without it. `false` disables runtime but preserves static output. `true` activates the middleware explicitly. Static-with-adapter projects retain coverage for their on-demand routes.
- [x] **C5 — Matching parity.** Exact paths, splats, named placeholders, host-qualified rules, and value substitutions have the documented Cloudflare results. Query strings do not alter matches; host-qualified rules ignore the incoming scheme and port, while invalid rule schemes/ports are rejected. Overlapping configured values combine in order, with case-insensitive header names. Host placeholders stop at dots and slashes. Invalid patterns fail before deployment.
- [x] **C6 — Custom output override.** Relative, absolute, and file-URL `assetsDirectory` values resolve correctly. A known generated deployment path that disagrees with the override causes an actionable build error. No source Wrangler configuration is modified.

## Static generation

- [x] **S1 — Real paths.** Builds in directories outside `process.cwd()`, including paths with spaces, produce `_headers` in the correct absolute location. Tests no longer encode the old `file:///buildDir` rebasing bug.
- [x] **S2 — Adapter layouts.** Every matrix pair builds with default paths and with `base: "/docs/"` plus a custom `outDir`. Modern adapter fixtures also exercise custom `build.client`. The final deployable asset root contains the effective `_headers`; the server bundle directory does not receive it by mistake.
- [x] **S3 — Adapter lifecycle.** Treat Cloudflare as Astro’s configured `adapter`, not as an entry to reorder within `config.integrations`. For Astro 6 with adapter 13.0 and 13.7, verify nonroot-base/custom-output builds at both `astro:build:generated` and final `astro:build:done` locations. The deployable asset root must contain one completed `_headers` file with manual, configured, and adapter-added cache rules; the server bundle must not contain it. Adapter relocation must not restore stale content.
- [x] **S4 — Existing files.** Manual `public/_headers`, copied nested headers, generated sections, and adapter-added rules survive merging. Two identical copies do not double header values; a manual and generated rule sharing a path produce one effective block that retains both sets of headers. A second build does not duplicate generated rules. Unrelated files are unchanged.
- [x] **S5 — Cache collision.** Default cache: a hashed asset keeps the adapter's immutable cache policy when no configured override applies. Full-pattern override: explicit `Cache-Control` on `/*` and on the complete asset pattern suppresses automatic immutable injection and produces the intended configured effective value. Narrow conflict: a narrower conflicting asset rule fails with guidance rather than silently deleting existing content. Manual preservation: rules identical to the adapter template, whether from `public/_headers` or another integration, remain intact. Verify successful cases via local HTTP.
- [x] **S6 — Host limits.** Exactly 100 rules and a line of exactly 2,000 characters are accepted when valid. A 101st rule or 2,001-character line fails by default. Counts include preserved rules, generated CSP rules, removals/serialization where applicable, and known later adapter additions. A custom stricter line limit is enforced; a larger option does not raise the host limit.
- [x] **S7 — Errors and explicit warning mode.** A failed file read/write, required CSP scan, or layout resolution rejects the build with a useful diagnostic. Explicit overflow warning mode logs the violated host limit and continues; it does not claim valid deployment output.
- [x] **S8 — Pages continuity.** A static build without an adapter serves generated headers through local Pages tooling. Astro 4/5 legacy Cloudflare builds retain valid output. Documentation does not claim Pages SSR support from Astro 6/7 adapters.

## Runtime responses

- [x] **R1 — Served response coverage.** Local Workers requests demonstrate configured headers on an SSR page, JSON endpoint, Astro-handled redirect, application error response, and not-found response. Verify a prerendered page and an asset separately through the static asset path.
- [x] **R2 — Response precedence.** Application CSP, a nonce-bearing CSP, and `Cache-Control: private, no-store` remain byte-for-byte unchanged when the integration config contains conflicting values. Missing configured headers are added. Header-name casing does not change precedence.
- [x] **R3 — Response integrity.** Status, status text where the runtime preserves it, separate cookies, and response body remain intact. A streaming endpoint delivers its first chunk before later chunks are produced. Middleware never consumes the stream to calculate hashes.
- [x] **R4 — Methods and upgrades.** GET, HEAD, and an implemented OPTIONS route receive expected headers; HEAD and bodyless statuses remain bodyless. WebSocket upgrades pass through unchanged. No synthetic OPTIONS route is introduced.
- [x] **R5 — Runtime isolation.** The middleware bundle contains no build-time filesystem, path, or Node hashing dependency. Packed-package Workers fixtures execute in workerd rather than relying only on mocked Node responses.
- [x] **R6 — Opt-out evidence.** With `runtime: false`, an SSR response does not acquire integration headers while static assets still do. With auto mode and Cloudflare, the same SSR fixture does acquire them.
- [x] **R7 — Development and preview.** Current Astro 6/7 Cloudflare development and preview commands run successfully with the integration. Exercise on-demand responses in each. Generated static `_headers` behavior is proved after build in local serving; documentation does not promise build-time hashes for unbuilt development HTML.

## CSP

- [x] **H1 — Fallback survives.** Original wildcard CSP still applies to an unmatched URL, a non-HTML asset, and a build with no generated HTML. No route-mode pass silently removes protection.
- [x] **H2 — Per-page replacement.** Two HTML pages with different inline content receive their own hashes. A third page with no inline content retains its original policy. Removal followed by replacement prevents the old wildcard policy from blocking the permitted inline content. Prove effective headers in local Workers and Pages serving.
- [x] **H3 — Multiple policies and exact rules.** Two matching configured policies remain independently enforced after patching. Existing exact-route non-CSP headers retain their effective values, including the `exact, general` order when an exact rule originally preceded a matching wildcard. Final output has no accidental duplicate path blocks or unpatched duplicate CSP.
- [x] **H4 — Paths and rendering.** CSP hashes correspond to the HTML actually served under nonroot `base`, directory/file build formats, and resolved host HTML handling. Include a directory build with `drop-trailing-slash` and a build with `html_handling: "none"`, as well as default and forced-slash modes. Equivalent URLs served without redirects receive the same intended policy. Mixed prerendered/SSR and pure SSR projects keep their runtime CSP independent of static expansion.
- [x] **H5 — Directive semantics.** Existing `default-src`, `script-src`, `style-src`, and element/attribute fallbacks retain their intended sources. Adding a hash does not invent `'self'` or drop an existing CDN source. A category without a directive or restricting fallback remains unrestricted, including a frame-ancestors-only policy. Hash-category toggles, deduplication, and explicit unsafe-inline behavior work. Directive names match case-insensitively. Auto-hashing disabled leaves CSP values unchanged.
- [x] **H6 — Unsupported ambiguity.** Host-dependent route-mode CSP or preserved manual policy conflicts that cannot be safely resolved fail the build with actionable guidance, without reporting a successful finalized artifact. Configuration errors detectable before early generation fail before that write. SPA fallback and custom 404 HTML with enabled inline hashes are rejected in route mode with guidance to use global mode; a no-hash fallback preserves the baseline. Global mode also preserves policies and fails on unresolved conflicts rather than silently weakening them.
- [x] **H7 — Native Astro CSP.** Native CSP without an integration CSP does not gain a second policy from this package. Configuring both owners emits one warning. Native meta elements, native response policies, and dynamic nonces are preserved.
- [x] **H8 — Runtime boundary.** Runtime uses original rules, does not inherit unrelated static page hashes, and does not buffer dynamic HTML. A global-mode fixture contains the union of built hashes; a route-mode fixture contains the page-specific result. Both obey host limits and deterministic serialization.

## Matrix and CI evidence

- [x] **M1 — All supported rows.** Run packed-package static builds without an adapter and real adapter builds for all eight minimum/latest pairs in the implementation guide. Record exact Node, Astro, adapter, Wrangler, and package versions. A mock hook invocation is insufficient.
- [x] **M2 — Rendering variants.** Each matrix pair exercises an on-demand page and a prerendered page using the rendering configuration valid for that version. Include Astro 4 hybrid, Astro 5 server with explicit prerendering, and Astro 6/7 both static-with-adapter and server output. Exercise nonroot base/custom output for every pair as required by S2.
- [x] **M3 — Local host evidence.** Run the HTTP suite on the latest Astro 6 and 7 Workers fixtures and a legacy Astro 4/5 Pages fixture using local serving. Probe CSP removal/replacement, cache collision, runtime precedence, streaming, and static headers. Requests must use the deployed asset layout rather than an arbitrary temporary `_headers` parser.
- [x] **M4 — Automation.** CI runs types, lint, noninteractive unit tests, package smoke tests, and the compatibility matrix for pull requests to `main` and `dev`. Publishing depends on those gates. Timeouts allow real builds; failures do not get marked successful through skipped jobs or optional error handling.
- [ ] **M5 — Evidence distinctions.** The implementation report separates unit tests, real builds, local workerd/Pages HTTP tests, and CI results. It explicitly states that production deployment and npm publication were not performed as part of acceptance. All required gates pass before claiming completion.

## User documentation

- [x] **D1 — Supported use cases.** README examples show current Workers setup, static-only Pages setup, integration-owned flat/nested headers, and the exact Astro/adapter support boundary. Examples are exercised by a fixture or consumer config check.
- [x] **D2 — Migration guide.** The 2.0 guide covers automatic runtime activation and opt-out, application-response precedence, universal wildcard normalization, deprecated `workers`, compiled exports, header validation, preserved files, failure behavior, and CSP/native-CSP boundaries.
- [x] **D3 — Release readiness.** Release notes identify the changed defaults as breaking changes and list verified compatibility. No statement claims untested future Astro versions, all adapter versions, runtime body hashing, or production verification.

## Suggested validation order

1. Type check, lint, and focused noninteractive unit tests.
2. Library compilation, tarball inspection, native import, and consumer type checks.
3. Minimum/latest Astro build matrix using the packed artifact.
4. Local Workers and Pages HTTP acceptance suites.
5. CI readback and user documentation verification.

Add stable repository scripts for the new suites during implementation, then record the exact runnable commands in the completion report. Avoid introducing tests for this handoff's wording; tests should verify package behavior and consumer outcomes.
