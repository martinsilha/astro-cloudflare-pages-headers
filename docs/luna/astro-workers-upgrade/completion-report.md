# Implementation and verification report

Updated 2026-09-30 for `astro-cloudflare-pages-headers`. The implementation and local compatibility suite are complete for the declared stable Astro 4–7 range. Local evidence now closes the remaining cache-collision, host-limit, pure-SSR CSP, and unresolved-policy criteria; GitHub Actions readback is the final acceptance gate.

## Delivered

The package builds compiled ESM and declaration files, preserves the default integration export, and exposes a separate middleware entrypoint. The integration validates and normalizes route headers, preserves existing `_headers` content, resolves generated Cloudflare asset paths, applies missing headers to Astro responses, and keeps application-set response values. It includes pinned Astro/adapter fixtures, local Workers and Pages smoke scripts, CI compatibility/release gating, a README, migration guide, and release notes.

The working-tree package version is `1.7.7-dev.1`; `2.0.0` appears only in draft migration/release documentation. No package was published. The compatibility claim is stable Astro 4–7 with the tested official Cloudflare adapter pairs in the table below; it does not claim support for future Astro majors, prereleases, every adapter version, or third-party SSR adapters.

## Local validation

| Evidence | Result |
| --- | --- |
| `pnpm run types` | Passed. |
| `pnpm run lint` | Passed. |
| `pnpm run test:unit` | Passed; 4 test files, 82 tests. |
| `pnpm run build:lib` | Passed. |
| Packed package checks | Passed: compiled ESM and declarations, native Node ESM import without a TS loader, no tests/fixtures/docs in the tarball, and no Node filesystem/path/hash imports in the runtime bundle. |
| Packed consumer matrix | Passed for all eight exact rows below. Every row exercised the adapter build and static Pages build with default and custom output layouts; Astro 6/7 also exercised static output with the Cloudflare adapter. |
| Local host tests | Latest Astro 6/7 passed Worker preview/dev; Astro 4/5 legacy fixtures passed Wrangler Pages serving. Latest Astro 7 also passed Pages CSP serving, cache-override HTTP cases, and route/global/native CSP Worker cases. |
| GitHub CI | Pending a pull-request run for these changes; prior repository runs do not cover this work. |

The compatibility runner command is `pnpm run test:compatibility` with `FIXTURE_ASTRO_VERSION`, `FIXTURE_ADAPTER_VERSION`, and `FIXTURE_WRANGLER_VERSION` set to a row below and `FIXTURE_PACKAGE_TARBALL` pointing at the packed artifact. Frozen per-row lockfiles pin the installed pair.

| Node | Astro | `@astrojs/cloudflare` | Wrangler | Additional local evidence |
| --- | --- | --- | --- | --- |
| 18.20.8 | 4.0.0 | 8.1.0 | 3.114.17 | Packed consumer type-check; hybrid adapter build; static Pages build. |
| 18.20.8 | 4.16.19 | 11.2.0 | 3.114.17 | Same builds; local Pages HTTP. |
| 24.14.0 | 5.0.0 | 12.0.0 | 4.59.2 | Packed consumer type-check; server adapter build with prerendered pages; static Pages build. |
| 24.14.0 | 5.18.2 | 12.6.13 | 4.59.2 | Same builds; local Pages HTTP. |
| 24.14.0 | 6.0.0 | 13.0.0 | 4.144.0 | Adapter 13.0 relocation and nonroot custom output. |
| 24.14.0 | 6.4.8 | 13.7.0 | 4.144.0 | Local workerd middleware; Worker preview/dev HTTP; adapter static output. |
| 24.14.0 | 7.0.0 | 14.0.0 | 4.144.0 | Packed consumer type-check; adapter and Pages builds. |
| 24.14.0 | 7.3.5 | 14.3.3 | 4.144.0 | Local workerd; Worker preview/dev; Pages CSP HTTP; cache collision/override and `runtime: false` cases; route/global/native CSP variants and alternate HTML handling. |

The fixtures use a nonroot `/docs/` base and custom output paths containing spaces. Server fixtures exercise on-demand API responses alongside prerendered pages. Astro 4 uses hybrid output, Astro 5 uses server output with explicit prerendered pages, and Astro 6/7 cover server and static-with-adapter output. Adapter output checks confirm `_headers` at the deployable asset root and absent from the server bundle.

The packed middleware was served in local `workerd` for GET, HEAD, Astro-handled OPTIONS, and a WebSocket upgrade. It preserved app CSP/cache/body fields, returned configured headers on GET/HEAD/OPTIONS, kept HEAD and OPTIONS bodyless, and passed the WebSocket upgrade through unchanged. In the separate Astro 6/7 adapter preview/dev host, Wrangler itself handled OPTIONS preflight before Astro; those HTTP runs therefore do not establish app OPTIONS behavior. The direct workerd smoke test supplies that evidence.

Latest Astro 7 checks also ran route-mode CSP over Worker and Pages HTTP, global-mode CSP over Worker HTTP, both-owner and native-only CSP behavior, all four Cloudflare `html_handling` modes (`auto`, `force-trailing-slash`, `drop-trailing-slash`, and `none`) with directory builds, and a file-format build with the default handling mode. CSP assertions covered two distinct inline pages, a hash-free page, multiple policies, case-insensitive mixed-case directive names over Worker and Pages HTTP, exact/wildcard header ordering in route mode, unmatched URLs, static assets, and a dynamic response without static page hashes. Global mode leaves exact and wildcard `_headers` rules separate, so the host determines their effective non-CSP header order; route mode emits the resolved exact-route order.

Astro 7 cache checks verified the adapter's immutable policy, a manual immutable rule, a full-pattern override over HTTP, and rejection of a narrower conflicting rule. `runtime: false` disabled response middleware while retaining static headers. Local HTTP coverage also exercised application-header precedence, status/body integrity, a redirect, error and not-found responses, cookies, streaming, and static assets.

The final cache and host-limit checks closed S5–S6. A second Astro integration wrote an immutable cache rule into the Worker client output after the package's generated phase; the final merge preserved one copy, and local preview returned the immutable value. Separately, the Astro 7.3.5 adapter injected its cache rule after an exactly 100-rule generated file; the final `astro:build:done` phase rejected the resulting 101-rule output. Unit coverage also checks exactly 100 rules, a 2,000-character line, stricter configured limits, and the post-generation boundary. Current Cloudflare documentation still specifies 100 `_headers` rules and 2,000 characters per line ([Workers headers](https://developers.cloudflare.com/workers/static-assets/headers/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).

CSP failure checks closed H6: route-mode SPA and 404 fallback expansion rejects with actionable guidance; an unresolved preserved-policy conflict in global mode fails before changing the existing `_headers`; and an early host-qualified conflict fails without writing provisional output. The report distinguishes these unit checks from real builds and local Workers/Pages serving. No production deployment or npm publication was performed. A pure-SSR Astro 7 Worker preview returned the configured route CSP without any hashes from the empty static build, while the mixed-rendering fixture independently proved that runtime CSP remains separate from page-specific static hashes. The pure-SSR build emitted no prerendered HTML and passed both deployable-output and preview HTTP checks.

## Acceptance item still open

The linked [acceptance checklist](acceptance-criteria.md) leaves only **M5** open: obtain GitHub Actions readback for this change. Local unit, package, build, workerd, Pages, and Worker results do not substitute for that run. The new compatibility workflow is configured for pull requests to both `main` and `dev`, and the release workflow depends on its matrix.

The user-owned untracked `demo/` directory was left untouched. No production Cloudflare resources, deployment, or npm publication were involved.
