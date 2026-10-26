# Testing and release reliability

This document describes the layered checks for `astro-cloudflare-pages-headers`. Pull requests test the source and a packed consumer across the pinned Astro matrix. Release validation tests the versioned package tarball, checks hosted Workers and Pages behavior, and publishes that same tarball only after every gate passes.

The suite preserves the public API and the declared Astro 4–7 support range. The required PR feedback target is 10 minutes; release validation targets 30 minutes. Mutation, larger generated-input, concurrency, and dependency-drift work runs nightly.

## Commands

| Command                             | Purpose                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                         | Fast unit suite for normal local work                                                                                               |
| `pnpm run types`                    | Type-check package and consumer contracts                                                                                           |
| `pnpm run lint`                     | Lint production TypeScript                                                                                                          |
| `pnpm run test:coverage:check`      | Run unit/property coverage and enforce global and per-file floors                                                                   |
| `pnpm run test:property`            | Seeded generated-input and idempotency properties                                                                                   |
| `pnpm run test:release`             | Release-plugin, Cloudflare cleanup utility, and publication failure tests                                                           |
| `pnpm run test:compatibility`       | Run one pinned consumer row; set `FIXTURE_ASTRO_VERSION`, `FIXTURE_ADAPTER_VERSION`, and `FIXTURE_WRANGLER_VERSION` from the matrix |
| `pnpm run test:browser`             | Run Playwright against `PLAYWRIGHT_BASE_URL`; Chromium is the default project                                                       |
| `pnpm run test:mutation`            | Mutate the critical runtime and header-processing modules; minimum score 85%                                                        |
| `pnpm run test:mutation:nightly`    | Broader nightly mutation analysis                                                                                                   |
| `pnpm run test:concurrency`         | Run two isolated compatibility suites and verify cleanup/source immutability                                                        |
| `pnpm run test:dependency-drift`    | Resolve newer compatible Astro 7, adapter, and Wrangler versions in a disposable fixture and record exact resolutions               |
| `pnpm pack --pack-destination /tmp` | Build and pack a candidate for local packed-consumer checks                                                                         |

The shared compatibility rows live in [`fixtures/astro-consumer/compatibility-matrix.json`](../../../fixtures/astro-consumer/compatibility-matrix.json). CI, the local runner, and release checks read that manifest. Matrix lockfiles pin the Astro, Cloudflare adapter, Wrangler, and transitive dependency graph. When a candidate tarball is substituted, the runner refreshes only its local archive metadata and rejects any change to the pinned dependency resolutions.

## Test layers

Vitest includes every executable production TypeScript module under `src/`, whether or not a test imports it. The global floors are 95% statements, lines, and functions and 90% branches. Every runtime module also has floors of 90% statements, lines, and functions and 85% branches. `src/types.ts` is the only runtime coverage exclusion: it contains type declarations only and is exercised through consumer compilation. The generated package declarations are compiled under both Bundler and NodeNext resolution.

Property tests cover normalization idempotency, caller-input immutability, stable generated-file merging, placeholder substitution, and case-insensitive application-header precedence. Fixed seeds keep pull-request runs repeatable; `RELIABILITY_NIGHTLY=true` expands generated-input cases. Regression examples in the unit suite cover malformed generated config, filesystem errors, CSP rewriting, output paths, and runtime opt-out.

The compatibility suite installs the exact candidate tarball in a new temporary fixture per run. Each run owns separate ports, Wrangler state, logs, and a process group. Failed builds must match the intended diagnostic. Startup retries do not convert a failed required run into a pass. The two-run isolation check compares the fixture source before and after execution and verifies that owned leases and workspaces were removed.

Playwright checks that authorized inline scripts execute, authorized inline styles render, unauthorized scripts and styles are blocked, and CSP violations are observed. It inspects response headers, execution markers, computed styles, browser console output, and page exceptions. PRs use Chromium; release and nightly compatibility jobs use Chromium, Firefox, and WebKit. Retries are disabled. Use `pnpm run test:browser -- --repeat-each=5` for the five-run acceptance check against a running fixture.

The local HTTP and direct workerd suites exercise the built package over GET, HEAD, OPTIONS, cookies, redirects, error responses, missing routes, streaming, cancellation, WebSocket upgrades, header precedence, and runtime opt-out. Direct workerd remains necessary where adapter tooling intercepts requests before Astro.

## CI and publication

| Tier         | Required work                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request | Types, lint, coverage, property tests, release-plugin tests, build/pack checks, all eight compatibility rows, local HTTP tests, Chromium CSP enforcement                                                              |
| Release      | PR gates against the versioned candidate, three-browser checks, critical mutation score, dedicated Cloudflare Workers and Pages canaries, tarball checksum and integrity verification, clean published-consumer smoke |
| Nightly      | Larger generated-input suite, full mutation analysis, repeated and concurrent execution, dependency drift, Windows package/path checks, scoped stale-resource cleanup                                                 |

The release workflow is serialized and does not cancel after publication can begin. Semantic-release calculates the version and release channel, then creates one tarball. The custom release plugin verifies the candidate and downloaded evidence, records SHA-256 and npm SHA-512 integrity, runs canaries against that tarball, and publishes that exact file with lifecycle scripts disabled. It reads registry integrity back, installs the published version in a clean Astro consumer, and runs import, type, and build smoke checks. A post-publication failure is reported as failed verification; it never triggers an unpublish.

The `cloudflare-canary` GitHub environment is allowlisted to `dev` and `main`. It holds the Cloudflare account and dedicated Pages project as environment variables. The `CLOUDFLARE_API_TOKEN` environment secret must be configured before a release can pass preflight. Release validation fails closed if credentials, compatibility evidence, coverage evidence, canaries, or artifact checksums are missing.

## Cloudflare canary operations

Canaries use synthetic fixtures only. Worker names begin `astro-headers-canary-worker-`; temporary KV titles begin `astro-headers-canary-session-`; Pages preview branches begin `canary-`. Each run writes a resource record under `test-results/cloudflare/`, checks deployed HTTP/CSP behavior, and deletes only its own Worker, KV namespace, and Pages preview deployment in a finalizer. A cleanup failure fails the canary. For the fixture's `/docs/` base path, the Pages canary stages built pages under a physical `docs/` directory and places `_headers` at the deployment root, matching the deployed URL layout.

The nightly cleaner is scoped to the dedicated account/project and those exact prefixes. It deletes only resources with an encoded creation time at least 24 hours old. Unknown names or timestamps are left untouched. Its GitHub job skips when the dedicated API token or project variables are missing; release canaries still fail closed.

To configure the release environment, add a Cloudflare API token with the account permissions needed to deploy Workers, manage Workers KV, and deploy/delete previews in the dedicated Pages project. Store it as the `CLOUDFLARE_API_TOKEN` secret in the `cloudflare-canary` GitHub environment. Keep the account ID and Pages project name in that environment's variables. Do not put credentials in fixture files, workflow YAML, or logs. The Pages project is `astro-cloudflare-headers-canary`; it has no customer domain or application data.

Canary evidence includes the candidate version, account identifier, created resource names and IDs, deployed URL, generated headers, cleanup status, HTTP assertions, and browser reports. CI retains PR evidence for 14 days and release/nightly evidence for 30 days. Never delete a resource by a broad account-wide prefix: inspect the exact resource record and verify it belongs to this suite first.

## Maintenance

When adding a supported Astro, adapter, or Wrangler combination, update the shared matrix and its committed lockfile together. Keep required rows pinned. Dependency drift changes only the disposable nightly fixture and records resolved versions; it never edits supported pins.

When adding a behavior, add a named unit or property test and, where it crosses a deployment boundary, a packed-consumer or HTTP assertion. Keep the assertion tied to externally observable behavior. Add exclusions only with a short technical reason in `scripts/check-coverage.mjs`.

Review first-attempt pass rate, flakes, elapsed time, coverage, mutation score, and drift failures from retained reports. Fix flaky required checks instead of quarantining them. If PR or release timing misses its target, parallelize independent rows or reuse immutable fixture outputs without skipping a gate.

## Current implementation evidence

Measured coverage currently exceeds the configured floors: 96.65% statements/lines, 100% functions, and 90.01% branches; per-file floors pass. Astro 6 and Astro 7 Worker canaries and the Astro 7 Pages canary pass deployed HTTP/CSP and five-repeat Chromium checks, with per-run resource cleanup verified. Stryker instrumentation and baseline execution pass, but the 85% mutation score has not yet been measured. The remaining mutation, full matrix/browser, release rehearsal, timing, and publication gates are tracked in [`acceptance-evidence.md`](acceptance-evidence.md).
