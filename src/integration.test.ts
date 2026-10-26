import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import astroCloudflarePagesHeaders from "./integration.js";
import { countHeaderRules } from "./headers-file.js";
import type { AstroCloudflarePagesHeadersOptions } from "./types.js";

const hashSha256 = (value: string) =>
  `sha256-${createHash("sha256").update(value, "utf8").digest("base64")}`;

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fork() {
      return this;
    },
  };
}

describe("astro-cloudflare-pages-headers integration", () => {
  let root: string;
  let dist: string;
  let logger: ReturnType<typeof makeLogger>;
  let addMiddleware: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "astro-headers-"));
    dist = path.join(root, "dist");
    await fs.mkdir(dist, { recursive: true });
    logger = makeLogger();
    addMiddleware = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function build(
    options: AstroCloudflarePagesHeadersOptions = {},
    headers?: unknown,
    adapterName?: string,
    configOverrides: Record<string, unknown> = {},
    afterSetup?: (config: { server: { headers: unknown } }) => void,
    afterGenerated?: () => Promise<void> | void,
  ) {
    const integration = astroCloudflarePagesHeaders(options);
    const hooks = integration.hooks as unknown as Record<
      string,
      (input: unknown) => unknown
    >;
    const config = {
      root: pathToFileURL(`${root}${path.sep}`),
      outDir: pathToFileURL(`${dist}${path.sep}`),
      base: "/",
      server: { headers },
      integrations: [integration],
      adapter: adapterName ? { name: adapterName } : undefined,
      build: {
        client: pathToFileURL(`${path.join(dist, "client")}${path.sep}`),
        server: pathToFileURL(`${path.join(dist, "server")}${path.sep}`),
      },
    };
    const { build: buildOverrides, ...otherOverrides } = configOverrides;
    Object.assign(config, otherOverrides);
    if (typeof buildOverrides === "object" && buildOverrides !== null)
      Object.assign(config.build, buildOverrides);
    const updateConfig = vi.fn((next) => Object.assign(config, next));
    await hooks["astro:config:setup"]({
      config,
      logger,
      updateConfig,
      addMiddleware,
      command: "build",
      isRestart: false,
      addRenderer: vi.fn(),
    });
    afterSetup?.(config);
    await hooks["astro:config:done"]({
      config,
      logger,
      setAdapter: vi.fn(),
      injectTypes: vi.fn(),
      buildOutput: adapterName ? "server" : "static",
    });
    await hooks["astro:build:generated"]({
      dir: pathToFileURL(`${dist}${path.sep}`),
      logger,
    });
    await afterGenerated?.();
    await hooks["astro:build:done"]({
      dir: pathToFileURL(`${dist}${path.sep}`),
      logger,
      pages: [],
      assets: new Map(),
    });
    return { integration, hooks, config, updateConfig };
  }

  it("writes flat headers with an absolute output path", async () => {
    await build({}, { "X-Test": "value" });
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toBe(
      "/*\n# BEGIN astro-cloudflare-pages-headers\n  X-Test: value\n# END astro-cloudflare-pages-headers\n",
    );
  });

  it("uses omitted nested legacy server headers as the fallback source", async () => {
    await build({}, { "/legacy/*": { "X-Legacy": "kept" } });
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain(
      "/legacy/*\n# BEGIN astro-cloudflare-pages-headers\n  X-Legacy: kept",
    );
  });

  it("merges the source public _headers when the deployable asset directory is nested", async () => {
    const publicDir = path.join(root, "public");
    await fs.mkdir(publicDir);
    await fs.writeFile(
      path.join(publicDir, "_headers"),
      "/*\n  X-Public: preserve\n",
    );
    await build(
      { headers: { "X-Generated": "configured" } },
      undefined,
      undefined,
      { publicDir },
    );
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("X-Public: preserve");
    expect(output).toContain("X-Generated: configured");
  });

  it("uses final setup headers, preserves inputs, and clears removed rules after a restart", async () => {
    const initial = { "*": { "X-Initial": "before" } };
    const first = await build({}, initial);
    expect(initial).toEqual({ "*": { "X-Initial": "before" } });
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain(
      "X-Initial: before",
    );

    const late = { "/after/*": { "X-Late": "after-setup" } };
    const second = await build(
      { assetsDirectory: "dist" },
      initial,
      "@astrojs/cloudflare",
      {},
      (config) => {
        config.server.headers = late;
      },
    );
    const runtimePlugin = (
      second.config as unknown as {
        vite: {
          plugins: Array<{ config(): { define: Record<string, string> } }>;
        };
      }
    ).vite.plugins[0];
    expect(
      JSON.parse(
        runtimePlugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__,
      ),
    ).toEqual({
      enabled: true,
      routes: { "/after/*": { "X-Late": "after-setup" } },
    });
    const changed = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(changed).toContain("X-Late: after-setup");
    expect(changed).not.toContain("X-Initial: before");
    expect(late).toEqual({ "/after/*": { "X-Late": "after-setup" } });

    second.config.server.headers = { "/restart/*": { "X-Restart": "new" } };
    await second.hooks["astro:config:done"]({
      config: second.config,
      logger,
      setAdapter: vi.fn(),
      injectTypes: vi.fn(),
      buildOutput: "static",
    });
    await second.hooks["astro:build:done"]({
      dir: pathToFileURL(`${dist}${path.sep}`),
      logger,
      pages: [],
      assets: new Map(),
    });
    const restarted = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(
      JSON.parse(
        runtimePlugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__,
      ),
    ).toEqual({
      enabled: true,
      routes: { "/restart/*": { "X-Restart": "new" } },
    });
    expect(restarted).toContain("X-Restart: new");
    expect(restarted).not.toContain("X-Late: after-setup");
    expect(restarted).not.toContain("X-Initial: before");

    second.config.server.headers = {};
    await second.hooks["astro:config:done"]({
      config: second.config,
      logger,
      setAdapter: vi.fn(),
      injectTypes: vi.fn(),
      buildOutput: "static",
    });
    await second.hooks["astro:build:done"]({
      dir: pathToFileURL(`${dist}${path.sep}`),
      logger,
      pages: [],
      assets: new Map(),
    });
    await expect(fs.access(path.join(dist, "_headers"))).rejects.toThrow();
    expect(
      JSON.parse(
        runtimePlugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__,
      ),
    ).toEqual({ enabled: true, routes: {} });
    expect(first.integration.name).toBe("astroCloudflarePagesHeaders");
  });

  it("preserves user rules and replaces its generated section on repeated builds", async () => {
    await fs.writeFile(
      path.join(dist, "_headers"),
      "# manual\n/*\n  X-Manual: keep\n\n",
    );
    await build({ headers: { "X-First": "one" } });
    await build({ headers: { "X-Second": "two" } });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("X-Manual: keep");
    expect(output).not.toContain("X-First: one");
    expect(output).toContain("X-Second: two");
    expect(output.match(/\/\*/g)).toHaveLength(1);
  });

  it("accepts nested rules, always normalizes universal routes, and does not mutate the caller", async () => {
    const headers = {
      "*": { "X-Test": "wildcard" },
      "/*": { "x-test": "explicit" },
    };
    await build({ headers });
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain(
      "x-test: explicit",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('explicit "/*" values win'),
    );
    expect(headers["*"]["X-Test"]).toBe("wildcard");
  });

  it("lets an explicit empty options object override legacy Astro server headers", async () => {
    await fs.writeFile(path.join(dist, "_headers"), "# manual stays\n");
    await build({ headers: {} }, { "X-Legacy": "no" });
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toBe(
      "# manual stays\n",
    );
  });

  it.each([
    [{ "/path": { "X-Test": 1 } }, "must have a string value"],
    [{ "/path": { "X-Test": null } }, "must have a string value"],
    [{ "/path?query": { "X-Test": "no" } }, "query strings"],
    [{ "/path#fragment": { "X-Test": "no" } }, "fragments"],
    [{ "/:id/:id": { "X-Test": "no" } }, "repeats a named placeholder"],
    [{ "https://user@example.com/*": { "X-Test": "no" } }, "credentials"],
    [{ "http://example.com/*": { "X-Test": "no" } }, "must use HTTPS"],
  ] as const)(
    "rejects malformed configuration %#",
    async (headers, message) => {
      await expect(
        build({
          headers: headers as AstroCloudflarePagesHeadersOptions["headers"],
        }),
      ).rejects.toThrow(message);
    },
  );

  it("selects automatic, explicit, and disabled runtime behavior", async () => {
    const automatic = await build(
      { headers: { "X-Test": "one" }, assetsDirectory: "dist" },
      undefined,
      "@astrojs/cloudflare",
    );
    expect(addMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({ order: "pre" }),
    );
    expect(automatic.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        vite: expect.objectContaining({ plugins: expect.any(Array) }),
      }),
    );
    const plugin = (
      automatic.config as unknown as {
        vite: {
          plugins: Array<{ config(): { define: Record<string, string> } }>;
        };
      }
    ).vite.plugins[0];
    expect(
      JSON.parse(
        plugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__,
      ),
    ).toMatchObject({ enabled: true });

    addMiddleware.mockClear();
    const inactive = await build({
      headers: { "X-Test": "one" },
      assetsDirectory: "dist",
    });
    expect(addMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({ order: "pre" }),
    );
    const inactivePlugin = (
      inactive.config as unknown as {
        vite: {
          plugins: Array<{ config(): { define: Record<string, string> } }>;
        };
      }
    ).vite.plugins[0];
    expect(
      JSON.parse(
        inactivePlugin.config().define
          .__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__,
      ),
    ).toMatchObject({ enabled: false });

    const explicit = await build({
      headers: { "X-Test": "one" },
      runtime: true,
      assetsDirectory: "dist",
    });
    const explicitPlugin = (
      explicit.config as unknown as {
        vite: {
          plugins: Array<{ config(): { define: Record<string, string> } }>;
        };
      }
    ).vite.plugins[0];
    expect(
      JSON.parse(
        explicitPlugin.config().define
          .__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__,
      ),
    ).toMatchObject({ enabled: true });

    addMiddleware.mockClear();
    await build(
      { headers: { "X-Test": "one" }, runtime: false, assetsDirectory: "dist" },
      undefined,
      "@astrojs/cloudflare",
    );
    expect(addMiddleware).not.toHaveBeenCalled();
  });

  it("preserves wildcard CSP and emits an exact removal/replacement for a generated page", async () => {
    const inline = "console.log('page')";
    await fs.writeFile(
      path.join(dist, "index.html"),
      `<script>${inline}</script>`,
    );
    const headers = {
      "Content-Security-Policy": "default-src 'self'; script-src 'self'",
    };
    await build({ csp: { autoHashes: true }, headers });
    expect(headers).toEqual({
      "Content-Security-Policy": "default-src 'self'; script-src 'self'",
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(
      "/*\n# BEGIN astro-cloudflare-pages-headers\n  Content-Security-Policy: default-src 'self'; script-src 'self'",
    );
    expect(output).toContain(
      "/\n# BEGIN astro-cloudflare-pages-headers\n  ! content-security-policy\n  Content-Security-Policy: default-src 'self'; script-src 'self' '",
    );
    expect(output).toContain(hashSha256(inline));
  });

  it("reports read, write, CSP scan, and generated-config parse failures with paths", async () => {
    const headersPath = path.join(dist, "_headers");
    await fs.mkdir(headersPath);
    await expect(build({ headers: { "X-Test": "yes" } })).rejects.toThrow(
      `Could not read existing _headers file at ${headersPath}`,
    );
    await fs.rm(headersPath, { recursive: true });

    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValue(new Error("injected write failure"));
    try {
      await expect(build({ headers: { "X-Test": "yes" } })).rejects.toThrow(
        `Could not write finalized _headers file at ${headersPath}`,
      );
    } finally {
      rename.mockRestore();
    }

    await fs.rm(dist, { recursive: true, force: true });
    await expect(
      build({
        headers: { "Content-Security-Policy": "default-src 'self'" },
        csp: { autoHashes: true },
      }),
    ).rejects.toThrow(`Could not scan generated HTML directory ${dist}`);
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, "wrangler.jsonc"), "{ broken");
    await expect(
      build(
        { headers: { "X-Test": "yes" }, assetsDirectory: "dist" },
        undefined,
        "@astrojs/cloudflare",
      ),
    ).rejects.toThrow(
      `Could not parse generated Wrangler configuration at ${path.join(dist, "wrangler.jsonc")}`,
    );
  });

  it("collects SRI, inline, external-script, quoted, unquoted, and entity-escaped CSP content", async () => {
    const integrity = "sha256-" + "A".repeat(43) + "=";
    await fs.writeFile(
      path.join(dist, "index.html"),
      '<style integrity="' +
        integrity +
        '">unhashed-style-content</style><script integrity="' +
        integrity +
        '">unhashed-script-content</script><script src="/external.js" integrity="' +
        integrity +
        '">external-script-content</script><script> </script><div style=""></div><div style=padding:2px></div>' +
        "<div style=" +
        String.fromCharCode(39) +
        "color: &quot;red&quot;" +
        String.fromCharCode(39) +
        "></div>",
    );
    await build({
      headers: {
        "Content-Security-Policy":
          "default-src 'self'; upgrade-insecure-requests; script-src 'none'; SCRIPT-SRC 'unsafe-inline'; style-src 'none'; style-src-elem 'none'; style-src-attr 'none'",
      },
      csp: { autoHashes: true },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("'" + integrity + "'");
    expect(output).toContain("upgrade-insecure-requests");
    expect(output).toContain("style-src-attr 'unsafe-hashes'");
    expect(output).not.toContain("unhashed-style-content");
    expect(output).not.toContain("unhashed-script-content");
    expect(output).not.toContain("external-script-content");
    expect(output).not.toContain("'none' '" + integrity + "'");
    expect(output).toContain(hashSha256("padding:2px"));
    expect(output).toContain(hashSha256('color: "red"'));
  });

  it("uses the documented CSP header-length fallback for invalid limits", async () => {
    for (const maxHeaderLineLength of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
    ]) {
      await build({
        headers: { "X-Limit": "x".repeat(1970) },
        csp: { maxHeaderLineLength },
      });
      await fs.rm(path.join(dist, "_headers"), { force: true });
    }
  });

  it("leaves a hash-bearing CSP unchanged when it has no applicable source directive", async () => {
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<script>no-source-directive()</script>",
    );
    await build({
      headers: { "Content-Security-Policy": "img-src 'self'" },
      csp: { autoHashes: true },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("Content-Security-Policy: img-src 'self'");
    expect(output).not.toContain("no-source-directive");
    expect(output).not.toContain("sha256-");
  });

  it("keeps a hash-free page policy and leaves unrestricted CSP categories unrestricted", async () => {
    await fs.writeFile(path.join(dist, "index.html"), "<main>plain</main>");
    await build({
      csp: { autoHashes: true },
      headers: { "Content-Security-Policy": "frame-ancestors 'none'" },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("Content-Security-Policy: frame-ancestors 'none'");
    expect(output).not.toContain("script-src");
    expect(output).not.toContain("style-src");
  });

  it("preserves exact route fields and their prior effective order when expanding CSP", async () => {
    await fs.mkdir(path.join(dist, "about"), { recursive: true });
    await fs.writeFile(
      path.join(dist, "_headers"),
      "/*\n  X-Manual: preserved\n",
    );
    await fs.writeFile(
      path.join(dist, "about", "index.html"),
      "<script>go()</script>",
    );
    await build({
      headers: {
        "/about/": {
          "X-Order": "exact",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'",
        },
        "/*": { "X-Order": "general" },
      },
      csp: { autoHashes: true },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("  ! X-Order\n  X-Order: exact, general");
    expect(output).toContain("  ! X-Manual\n  X-Manual: preserved");
    expect(output.indexOf("/*")).toBeLessThan(output.indexOf("/about/"));
  });

  it("rejects output line overflow and validates paths before writing", async () => {
    await expect(
      build({ headers: { "/test": { "X-Long-Header": "x".repeat(2100) } } }),
    ).rejects.toThrow("2,000 characters");
    await expect(
      build({ headers: { "bad route": { "X-Test": "value" } } }),
    ).rejects.toThrow("must begin");
  });

  it("detaches a full asset Cache-Control override from an overlapping wildcard", async () => {
    await build(
      {
        headers: {
          "/*": { "Cache-Control": "public, max-age=60" },
          "/_astro/*": { "Cache-Control": "public, max-age=300" },
        },
        assetsDirectory: "dist",
      },
      undefined,
      "@astrojs/cloudflare",
    );
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("! Cache-Control");
    expect(output).toContain("Cache-Control: public, max-age=300");
  });

  it("rejects a narrow cache rule that collides with adapter asset caching", async () => {
    await expect(
      build(
        {
          headers: {
            "/_astro/*.css": { "Cache-Control": "public, max-age=300" },
          },
          assetsDirectory: "dist",
        },
        undefined,
        "@astrojs/cloudflare",
      ),
    ).rejects.toThrow("overlaps only part of the generated asset directory");
  });

  it("rejects a conflicting preserved asset cache policy", async () => {
    await fs.writeFile(
      path.join(dist, "_headers"),
      "/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n",
    );
    await expect(
      build(
        {
          headers: { "/*": { "Cache-Control": "public, max-age=60" } },
          assetsDirectory: "dist",
        },
        undefined,
        "@astrojs/cloudflare",
      ),
    ).rejects.toThrow("preserved _headers Cache-Control rule conflicts");
  });

  it("maps CSP pages through base and resolved Cloudflare HTML handling", async () => {
    await fs.mkdir(path.join(dist, "about"), { recursive: true });
    await fs.writeFile(
      path.join(dist, "about", "index.html"),
      "<script>about()</script>",
    );
    await fs.writeFile(
      path.join(dist, "wrangler.jsonc"),
      JSON.stringify({
        assets: { directory: ".", html_handling: "drop-trailing-slash" },
      }),
    );
    await build(
      {
        headers: {
          "/*": {
            "Content-Security-Policy": "default-src 'self'; script-src 'self'",
          },
        },
        csp: { autoHashes: true },
      },
      undefined,
      "@astrojs/cloudflare",
      { base: "/docs/", build: { format: "directory" } },
    );
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(
      "/docs/about\n# BEGIN astro-cloudflare-pages-headers",
    );
    expect(output).toContain(hashSha256("about()"));
    expect(output).not.toContain("/about/\n# BEGIN");
  });

  it("keeps a no-hash 404 fallback on its original wildcard CSP and rejects host-qualified expansion", async () => {
    await fs.writeFile(path.join(dist, "404.html"), "<main>not found</main>");
    await fs.writeFile(
      path.join(dist, "wrangler.json"),
      JSON.stringify({
        assets: { directory: ".", not_found_handling: "404-page" },
      }),
    );
    await build(
      {
        headers: { "Content-Security-Policy": "default-src 'none'" },
        csp: { autoHashes: true },
      },
      undefined,
      "@astrojs/cloudflare",
    );
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(
      "/*\n# BEGIN astro-cloudflare-pages-headers\n  Content-Security-Policy: default-src 'none'",
    );
    expect(output).not.toContain("! content-security-policy");

    await fs.rm(path.join(dist, "_headers"));
    await fs.rm(path.join(dist, "404.html"));
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<script>host-route()</script>",
    );
    await expect(
      build(
        {
          headers: {
            "https://:site.example/*": {
              "Content-Security-Policy":
                "default-src 'self'; script-src 'self'",
            },
          },
          csp: { autoHashes: true },
        },
        undefined,
        "@astrojs/cloudflare",
      ),
    ).rejects.toThrow("host-qualified headers also match");
    await expect(fs.access(path.join(dist, "_headers"))).rejects.toThrow();
  });

  it("rejects route CSP expansion when preserved manual policy also matches HTML", async () => {
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<script>inline()</script>",
    );
    await fs.writeFile(
      path.join(dist, "_headers"),
      "/*\n  Content-Security-Policy: default-src 'none'\n",
    );
    await expect(
      build({
        headers: {
          "/*": {
            "Content-Security-Policy": "default-src 'self'; script-src 'self'",
          },
        },
        csp: { autoHashes: true },
      }),
    ).rejects.toThrow("preserved _headers CSP policy");
  });
  it("rejects unresolved global CSP conflicts before writing provisional output", async () => {
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<script>global-conflict()</script>",
    );
    const preserved = "/*\n  Content-Security-Policy: default-src 'none'\n";
    await fs.writeFile(path.join(dist, "_headers"), preserved);
    await expect(
      build({
        headers: {
          "Content-Security-Policy": "default-src 'self'; script-src 'self'",
        },
        csp: { autoHashes: true, mode: "global" },
      }),
    ).rejects.toThrow("preserved _headers CSP policy");
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toBe(
      preserved,
    );
  });

  it("keeps the wildcard CSP when no generated HTML needs route overrides", async () => {
    await build({
      headers: { "Content-Security-Policy": "default-src 'none'" },
      csp: { autoHashes: true },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(
      "/*\n# BEGIN astro-cloudflare-pages-headers\n  Content-Security-Policy: default-src 'none'",
    );
    expect(output).not.toContain("! content-security-policy");
  });

  it.each([
    ["404-page", "404/index.html"],
    ["single-page-application", "index.html"],
  ])(
    "rejects route hashes for %s fallback HTML",
    async (notFoundHandling, htmlPath) => {
      const file = path.join(dist, htmlPath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "<script>fallback()</script>");
      await fs.writeFile(
        path.join(dist, "wrangler.json"),
        JSON.stringify({
          assets: { directory: ".", not_found_handling: notFoundHandling },
        }),
      );
      await expect(
        build(
          {
            headers: {
              "/*": {
                "Content-Security-Policy":
                  "default-src 'self'; script-src 'self'",
              },
            },
            csp: { autoHashes: true },
          },
          undefined,
          "@astrojs/cloudflare",
        ),
      ).rejects.toThrow("cannot cover");
    },
  );

  it("rejects per-route CSP expansion for Pages 404 and redirect-based SPA fallbacks", async () => {
    await fs.writeFile(
      path.join(dist, "404.html"),
      "<script>not-found()</script>",
    );
    await expect(
      build({
        headers: {
          "Content-Security-Policy": "default-src 'self'; script-src 'self'",
        },
        csp: { autoHashes: true },
      }),
    ).rejects.toThrow("404 fallback served for arbitrary paths");
    await fs.rm(path.join(dist, "404.html"));
    await fs.writeFile(path.join(dist, "index.html"), "<script>spa()</script>");
    await fs.writeFile(path.join(dist, "_redirects"), "/* /index.html 200\n");
    await expect(
      build({
        headers: {
          "Content-Security-Policy": "default-src 'self'; script-src 'self'",
        },
        csp: { autoHashes: true },
      }),
    ).rejects.toThrow("SPA fallback served at arbitrary paths");
  });

  it("moves a matching exact CSP rule onto the served drop-trailing-slash path", async () => {
    await fs.mkdir(path.join(dist, "about"), { recursive: true });
    await fs.writeFile(
      path.join(dist, "about", "index.html"),
      "<script>about-drop()</script>",
    );
    await fs.writeFile(
      path.join(dist, "wrangler.jsonc"),
      JSON.stringify({
        assets: { directory: ".", html_handling: "drop-trailing-slash" },
      }),
    );
    await build(
      {
        headers: {
          "/docs/about/": { "X-Order": "exact" },
          "/*": {
            "X-Order": "general",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'",
          },
        },
        csp: { autoHashes: true },
      },
      undefined,
      "@astrojs/cloudflare",
      { base: "/docs/", build: { format: "directory" } },
    );
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(
      "/docs/about\n# BEGIN astro-cloudflare-pages-headers",
    );
    expect(output).not.toContain(
      "/docs/about/\n# BEGIN astro-cloudflare-pages-headers",
    );
    expect(output).toContain("X-Order: exact, general");
    expect(output).toContain(hashSha256("about-drop()"));
  });

  it.each([
    ["auto-trailing-slash", "/docs/about/"],
    ["force-trailing-slash", "/docs/about/"],
    ["drop-trailing-slash", "/docs/about"],
    ["none", "/docs/about/index.html"],
  ])(
    "maps directory CSP routes with html_handling=%s",
    async (htmlHandling, expectedRoute) => {
      await fs.mkdir(path.join(dist, "about"), { recursive: true });
      await fs.writeFile(
        path.join(dist, "about", "index.html"),
        "<script>about-mode()</script>",
      );
      await fs.writeFile(
        path.join(dist, "wrangler.jsonc"),
        JSON.stringify({
          assets: { directory: ".", html_handling: htmlHandling },
        }),
      );
      await build(
        {
          headers: {
            "/*": {
              "Content-Security-Policy":
                "default-src 'self'; script-src 'self'",
            },
          },
          csp: { autoHashes: true },
        },
        undefined,
        "@astrojs/cloudflare",
        { base: "/docs/", build: { format: "directory" } },
      );
      const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
      expect(output).toContain(
        expectedRoute + "\n# BEGIN astro-cloudflare-pages-headers",
      );
      expect(output).toContain(hashSha256("about-mode()"));
    },
  );

  it("patches every matching CSP policy without changing its source lists", async () => {
    const inlineScript = "cdn-page()";
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<script>" + inlineScript + "</script>",
    );
    await build({
      headers: {
        "Content-Security-Policy":
          "default-src https://cdn.example; script-src 'self', default-src 'none'; script-src https://scripts.example",
      },
      csp: { autoHashes: true },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    const hash = "'" + hashSha256(inlineScript) + "'";
    expect(output.split(hash).length - 1).toBe(2);
    expect(output).toContain("script-src 'self' " + hash);
    expect(output).toContain("script-src https://scripts.example " + hash);
    expect(output).toContain("default-src https://cdn.example");
    expect(output).toContain("default-src 'none'");
  });

  it("matches CSP directive names without regard to case", async () => {
    const script = "mixedCaseScript()";
    const style = "body { color: purple; }";
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<style>" + style + "</style><script>" + script + "</script>",
    );
    await build({
      headers: {
        "Content-Security-Policy":
          "DEFAULT-SRC 'none'; SCRIPT-SRC 'self'; STYLE-SRC https://styles.example",
      },
      csp: { autoHashes: true },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("DEFAULT-SRC 'none'");
    expect(output).toContain("SCRIPT-SRC 'self' '" + hashSha256(script) + "'");
    expect(output).toContain(
      "STYLE-SRC https://styles.example '" + hashSha256(style) + "'",
    );
    expect(output).not.toMatch(/(?:^|; )script-src(?: |;)/);
    expect(output).not.toMatch(/(?:^|; )style-src(?: |;)/);
  });

  it("inherits directive fallbacks, hashes enabled categories, and strips unsafe-inline only as configured", async () => {
    const script = "script-category()";
    const style = "body { color: red; }";
    const attribute = "color: blue";
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<style>" +
        style +
        '</style><div style="' +
        attribute +
        '"></div><script>' +
        script +
        "</script>",
    );
    await build({
      headers: {
        "Content-Security-Policy":
          "default-src https://default.example; script-src https://scripts.example 'unsafe-inline'; script-src-elem https://script-elements.example 'unsafe-inline'; style-src https://styles.example 'unsafe-inline'; style-src-elem https://style-elements.example 'unsafe-inline'",
      },
      csp: { autoHashes: true },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    const exactStart = output.indexOf(
      "/\n# BEGIN astro-cloudflare-pages-headers",
      output.indexOf("/*"),
    );
    const exactBlock = output.slice(exactStart);
    expect(exactBlock).toContain(
      "script-src https://scripts.example '" + hashSha256(script) + "'",
    );
    expect(exactBlock).toContain(
      "script-src-elem https://script-elements.example '" +
        hashSha256(script) +
        "'",
    );
    expect(exactBlock).toContain(
      "style-src https://styles.example '" + hashSha256(style) + "'",
    );
    expect(exactBlock).toContain(
      "style-src-elem https://style-elements.example '" +
        hashSha256(style) +
        "'",
    );
    expect(exactBlock).toContain(
      "style-src-attr https://styles.example '" +
        hashSha256(style) +
        "' 'unsafe-hashes' '" +
        hashSha256(attribute) +
        "'",
    );
    expect(exactBlock).not.toContain("'unsafe-inline'");
    expect(exactBlock).not.toContain("'self'");
    expect(exactBlock).toContain("default-src https://default.example");
  });

  it("leaves disabled hash categories untouched and lets global mode cover a hash-bearing fallback", async () => {
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<script>fallback-global()</script>",
    );
    await fs.writeFile(path.join(dist, "_redirects"), "/* /index.html 200\n");
    await build({
      headers: {
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      },
      csp: {
        autoHashes: true,
        mode: "global",
        hashInlineScripts: false,
        hashStyleElements: false,
        hashStyleAttributes: false,
      },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(
      "Content-Security-Policy: default-src 'self'; script-src 'self'",
    );
    expect(output).not.toContain("sha256-");
    expect(logger.warn.mock.calls.flat().join("\n")).toContain(
      "no hash categories are enabled",
    );
  });

  it("keeps unsafe-inline when explicitly configured not to strip it", async () => {
    const inlineScript = "unsafe-inline-kept()";
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<script>" + inlineScript + "</script>",
    );
    await build({
      headers: {
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline'",
      },
      csp: { autoHashes: true, stripUnsafeInline: false },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("'unsafe-inline'");
    expect(output).toContain(hashSha256(inlineScript));
  });

  it("does not change CSP when auto-hashing is disabled", async () => {
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<script>disabled-auto-hash()</script>",
    );
    await build({
      headers: {
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      },
      csp: { autoHashes: false },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(
      "Content-Security-Policy: default-src 'self'; script-src 'self'",
    );
    expect(output).not.toContain("sha256-");
    expect(output).not.toContain("! content-security-policy");
  });

  it("adds the union of route hashes to a global policy used by an SPA fallback", async () => {
    await fs.mkdir(path.join(dist, "about"), { recursive: true });
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<script>global-index()</script>",
    );
    await fs.writeFile(
      path.join(dist, "about", "index.html"),
      "<script>global-about()</script>",
    );
    await fs.writeFile(path.join(dist, "_redirects"), "/* /index.html 200\n");
    await build({
      headers: {
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      },
      csp: { autoHashes: true, mode: "global" },
    });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(hashSha256("global-index()"));
    expect(output).toContain(hashSha256("global-about()"));
    expect(output).not.toContain("! content-security-policy");
  });

  it("warns once when Astro native CSP and an integration policy have two owners", async () => {
    await build(
      { headers: { "Content-Security-Policy": "default-src 'self'" } },
      undefined,
      undefined,
      { security: { csp: true } },
    );
    const warnings = logger.warn.mock.calls
      .flat()
      .filter((message) => String(message).includes("Astro native CSP"));
    expect(warnings).toHaveLength(1);
  });

  it("accepts the exact Cloudflare rule and line limits and rejects the next unit", async () => {
    const exactlyHundred = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `/route-${index}`,
        { "X-Test": "ok" },
      ]),
    );
    await build({ headers: exactlyHundred });
    expect(
      countHeaderRules(await fs.readFile(path.join(dist, "_headers"), "utf8")),
    ).toBe(100);
    await fs.rm(path.join(dist, "_headers"), { force: true });

    const exactlyTwoThousand = "x".repeat(1990);
    await build({ headers: { "X-Test": exactlyTwoThousand } });
    const line = (await fs.readFile(path.join(dist, "_headers"), "utf8"))
      .split("\n")
      .find((value) => value.includes("X-Test:"));
    expect(line?.length).toBe(2000);
  });
  it("recounts adapter-added rules after the generated phase", async () => {
    const exactlyHundred = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `/route-${index}`,
        { "X-Test": "ok" },
      ]),
    );
    let generatedRuleCount = 0;
    await expect(
      build(
        { headers: exactlyHundred, assetsDirectory: "dist" },
        undefined,
        "@astrojs/cloudflare",
        {},
        undefined,
        async () => {
          generatedRuleCount = countHeaderRules(
            await fs.readFile(path.join(dist, "_headers"), "utf8"),
          );
          await fs.appendFile(
            path.join(dist, "_headers"),
            "/_adapter-added\n  X-Adapter-Cache: immutable\n",
          );
        },
      ),
    ).rejects.toThrow("101 rules");
    expect(generatedRuleCount).toBe(100);
  });

  it("counts exact routes added by CSP expansion against Cloudflare's rule cap", async () => {
    await fs.writeFile(
      path.join(dist, "index.html"),
      "<script>limit-route()</script>",
    );
    const routes: Record<string, Record<string, string>> = {
      "/*": {
        "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      },
    };
    for (let index = 0; index < 99; index += 1)
      routes[`/other-${index}`] = { "X-Test": "ok" };
    await expect(
      build({ headers: routes, csp: { autoHashes: true } }),
    ).rejects.toThrow("101 rules");
  });

  it("rejects Cloudflare limit overflow by default and warns only when requested", async () => {
    const oneHundredOne = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `/route-${index}`,
        { "X-Test": "ok" },
      ]),
    );
    await expect(build({ headers: oneHundredOne })).rejects.toThrow(
      "101 rules",
    );
    await expect(
      build({ headers: { "X-Test": "x".repeat(1991) } }),
    ).rejects.toThrow("2001 characters");
    await build({
      headers: { "X-Test": "x".repeat(1991) },
      csp: { overflow: "warn" },
    });
    expect(logger.warn.mock.calls.flat().join("\n")).toContain(
      "2001 characters",
    );
  });

  it("enforces custom and Cloudflare hard line limits after merging preserved rules", async () => {
    await expect(
      build({
        headers: { "X-Test": "x".repeat(991) },
        csp: { maxHeaderLineLength: 1000 },
      }),
    ).rejects.toThrow("Max allowed is 1,000 characters");
    await expect(
      build({
        headers: { "X-Test": "x".repeat(1991) },
        csp: { maxHeaderLineLength: 5000 },
      }),
    ).rejects.toThrow("2,000 characters");
    const preserved = Array.from(
      { length: 100 },
      (_, index) => `/manual-${index}\n  X-Manual: ${index}\n`,
    ).join("");
    await fs.writeFile(path.join(dist, "_headers"), preserved);
    await expect(build({ headers: { "X-Generated": "yes" } })).rejects.toThrow(
      "101 rules",
    );
  });

  it("updates one same-path generated rule and keeps distinct manual values", async () => {
    await fs.writeFile(
      path.join(dist, "_headers"),
      "/*\n  X-Manual: keep\n  X-Configured: old\n\n",
    );
    await build({ headers: { "X-Configured": "new" } });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output.match(/\/\*/g)).toHaveLength(1);
    expect(output).toContain("X-Manual: keep");
    expect(output).toContain("X-Configured: new");
    expect(output).toContain("X-Configured: old");
  });
  it("preserves the first duplicate directive and deduplicates sources and hashes", async () => {
    const script = "duplicate()";
    const hash = `'${hashSha256(script)}'`;
    await fs.writeFile(path.join(dist, "index.html"), `<script>${script}</script><script>${script}</script>`);
    await build({ headers: { "Content-Security-Policy": `; SCRIPT-SRC 'self' 'self' ${hash}; script-src https://ignored.example; upgrade-insecure-requests;;;` }, csp: { autoHashes: true, mode: "global" } });
    const value = (await fs.readFile(path.join(dist, "_headers"), "utf8")).split("\n").find(line => line.includes("Content-Security-Policy:"));
    // Existing hash means no policy expansion is necessary. Test the changed path
    // separately with a second script, retaining first-directive browser semantics.
    expect(value).toContain(hash);
    await fs.writeFile(path.join(dist, "index.html"), `<script>${script}</script><script>second()</script>`);
    await build({ headers: { "Content-Security-Policy": `; SCRIPT-SRC 'self' 'self' ${hash}; script-src https://ignored.example; upgrade-insecure-requests;;;` }, csp: { autoHashes: true, mode: "global" } });
    const second = (await fs.readFile(path.join(dist, "_headers"), "utf8")).split("\n").find(line => line.includes("Content-Security-Policy:"));
    expect(second).toBe(`  Content-Security-Policy: SCRIPT-SRC 'self' ${hash} '${hashSha256("second()") }'; upgrade-insecure-requests;`);
  });

  it.each(["hashStyleElements", "hashStyleAttributes", "hashInlineScripts"] as const)("hashes only the independently enabled %s category", async (category) => {
    await fs.writeFile(path.join(dist, "index.html"), '<style media="screen">body { color: red; }</style><div style="color: blue"></div><script type="module">console.log("hello world")</script>');
    await build({ headers: { "Content-Security-Policy": "default-src 'none'" }, csp: { autoHashes: true, mode: "global", hashStyleElements: false, hashStyleAttributes: false, hashInlineScripts: false, [category]: true } });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    for (const [name, value] of [["hashStyleElements", "body { color: red; }"], ["hashStyleAttributes", "color: blue"], ["hashInlineScripts", 'console.log("hello world")']]) {
      expect(output.includes(hashSha256(value))).toBe(name === category);
    }
  });

  it("unions style and attribute hashes across pages in stable sorted order", async () => {
    await fs.mkdir(path.join(dist, "nested"));
    const styles = ["body { color: red; }", "p { color: blue; }"];
    const attrs = ["padding: 1px", "margin: 2px"];
    await fs.writeFile(path.join(dist, "index.html"), `<style>${styles[0]}</style><div style="${attrs[0]}"></div>`);
    await fs.writeFile(path.join(dist, "nested", "other.html"), `<style>${styles[1]}</style><div style="${attrs[1]}"></div><style>${styles[0]}</style>`);
    await build({ headers: { "Content-Security-Policy": "style-src 'none'; style-src-elem 'none'; style-src-attr 'none'" }, csp: { autoHashes: true, mode: "global" } });
    const hashes = (values: string[]) => values.map(hashSha256).sort().map(hash => `'${hash}'`).join(" ");
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain(`Content-Security-Policy: style-src ${hashes(styles)}; style-src-elem ${hashes(styles)}; style-src-attr 'unsafe-hashes' ${hashes(attrs)};`);
  });

  it.each([
    ["&quot;&#34;&#x22;", '\"\"\"'],
    ["&apos;&#39;&#x27;", "'''"],
    ["&lt;&gt;&amp;", "<>&"],
    ["&QUOT;&#X22;&APOS;&#X27;&LT;&GT;&AMP;", '\"\"\'\'<>&'],
  ])("hashes raw and browser-decoded style attributes %s", async (encoded, decoded) => {
    await fs.writeFile(path.join(dist, "index.html"), `<div style = "content:${encoded}"></div>`);
    await build({ headers: { "Content-Security-Policy": "style-src 'none'" }, csp: { autoHashes: true, mode: "global" } });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(hashSha256(`content:${encoded}`));
    expect(output).toContain(hashSha256(`content:${decoded}`));
  });

  it("uses valid SRI and excludes external scripts even with spaced attributes", async () => {
    const integrity = "sha256-" + "b".repeat(43) + "=";
    await fs.writeFile(path.join(dist, "index.html"), `<style media="screen" integrity = '${integrity}'>style-body</style><script type="module" integrity = "${integrity}">script-body</script><script src = "/asset.js">external-body</script><script src="/other.js">other-external-body</script><script> \n </script><style></style>`);
    await build({ headers: { "Content-Security-Policy": "default-src 'none'" }, csp: { autoHashes: true, mode: "global" } });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(`style-src '${integrity}'`);
    expect(output).toContain(`script-src '${integrity}'`);
    for (const value of ["style-body", "script-body", "external-body", "other-external-body", " \n ", ""]) expect(output).not.toContain(hashSha256(value));
  });

  it("leaves HTML unchanged by default and reports no spurious configuration warnings", async () => {
    const html = "<style>p{color:red}</style><script>default()</script>";
    await fs.writeFile(path.join(dist, "index.html"), html);
    await build({ headers: { "Content-Security-Policy": "default-src 'self'" } });
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).not.toContain("sha256-");
    expect(await fs.readFile(path.join(dist, "index.html"), "utf8")).toBe(html);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reapplies named and wildcard captures while respecting preserved removals", async () => {
    await fs.mkdir(path.join(dist, "articles", "hello"), { recursive: true });
    await fs.writeFile(path.join(dist, "articles", "hello", "index.html"), "<script>article()</script>");
    await fs.writeFile(path.join(dist, "_headers"), "/*\n  X-Removed: gone\n/articles/:slug\n  ! X-Removed\n  X-Manual: :slug\n/unmatched/*\n  X-Unrelated: no\n");
    await build({ headers: { "/*": { "Content-Security-Policy": "default-src 'self'" }, "/articles/:slug": { "X-Named": ":slug :missing" }, "/articles/*": { "X-Wildcard": ":splat" } }, csp: { autoHashes: true } });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    const exact = output.slice(output.indexOf("/articles/hello/\n"));
    expect(exact).toContain("X-Named: hello :missing");
    expect(exact).toContain("X-Wildcard: hello");
    expect(exact).toContain("X-Manual: hello");
    expect(exact).not.toContain("X-Removed:");
    expect(exact).not.toContain("X-Unrelated:");
  });

  it("rejects matching preserved host rules but ignores unrelated host and CSP rules", async () => {
    await fs.writeFile(path.join(dist, "index.html"), "<script>root()</script>");
    await fs.writeFile(path.join(dist, "_headers"), "https://example.com/*\n  X-Host: yes\n");
    await expect(build({ headers: { "Content-Security-Policy": "default-src 'self'" }, csp: { autoHashes: true } })).rejects.toThrow("preserved host-qualified headers also match");
    await fs.writeFile(path.join(dist, "_headers"), "/other/*\n  Content-Security-Policy: default-src 'none'\nhttps://example.com/other/*\n  X-Host: yes\n");
    await build({ headers: { "/*": { "Content-Security-Policy": "default-src 'self'" }, "https://example.com/unrelated/*": { "X-Other": "yes" } }, csp: { autoHashes: true } });
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain(hashSha256("root()"));
  });

  it.each([
    ["auto-trailing-slash", "/docs/article"],
    ["force-trailing-slash", "/docs/article/"],
    ["drop-trailing-slash", "/docs/article"],
    ["none", "/docs/article.html"],
  ])("maps flat HTML through a base with %s", async (htmlHandling, route) => {
    await fs.writeFile(path.join(dist, "article.html"), "<script>flat()</script>");
    await fs.writeFile(path.join(dist, "wrangler.json"), JSON.stringify({ assets: { directory: ".", html_handling: htmlHandling } }));
    await build({ headers: { "Content-Security-Policy": "default-src 'self'" }, csp: { autoHashes: true } }, undefined, "@astrojs/cloudflare", { base: "/docs/" });
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain(`${route}\n# BEGIN`);
  });

  it("ignores ordinary redirects and non-HTML files when hashing", async () => {
    await fs.writeFile(path.join(dist, "index.html"), "<script>valid()</script>");
    await fs.writeFile(path.join(dist, "ignored.txt"), "<script>ignored()</script>");
    await fs.writeFile(path.join(dist, "_redirects"), "\n# comment\n/old /index.html 200\n/* /index.html 301\n/* https://example.com 200\n");
    await build({ headers: { "Content-Security-Policy": "default-src 'self'" }, csp: { autoHashes: true } });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain(hashSha256("valid()"));
    expect(output).not.toContain(hashSha256("ignored()"));
  });

  it("rejects conflicting full cache rules without an explicit asset resolution", async () => {
    await expect(build({ headers: { "/*": { "Cache-Control": "public, max-age=1" }, "/:folder/*": { "Cache-Control": "no-store" } }, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare")).rejects.toThrow("Overlapping configured Cache-Control rules produce conflicting values");
  });

  it("preserves other asset headers when reconciling cache rules at a custom base", async () => {
    await build({ headers: { "/*": { "Cache-Control": "no-store" }, "/docs/assets/*": { "cache-control": "public, max-age=3600", "X-Asset": "retained" } }, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare", { base: "/docs/", build: { assets: "/assets/" } });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("/docs/assets/*\n# BEGIN astro-cloudflare-pages-headers\n  X-Asset: retained\n  ! cache-control\n  cache-control: public, max-age=3600");
  });

  it("exposes disabled runtime config even for the Cloudflare adapter", async () => {
    const result = await build({ headers: { "X-Test": "yes" }, runtime: false, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare");
    const plugin = (result.config as unknown as { vite: { plugins: Array<{ config(): { define: Record<string, string> } }> } }).vite.plugins[0];
    expect(JSON.parse(plugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__)).toEqual({ enabled: false, routes: { "/*": { "X-Test": "yes" } } });
  });

  it("publishes a CSP report with unique counts across all categories and pages", async () => {
    await fs.mkdir(path.join(dist, "other"));
    const html = '<style>p{color:red}</style><p style="color:blue"></p><script>report()</script>';
    await fs.writeFile(path.join(dist, "index.html"), html);
    await fs.writeFile(path.join(dist, "other", "index.html"), html);
    await build({ headers: { "Content-Security-Policy": "default-src 'none'" }, csp: { autoHashes: true, mode: "global" } });
    expect(logger.info).toHaveBeenCalledWith("[astro-cloudflare-pages-headers] CSP auto-hash patch completed: 1 inline style hashes, 1 style attribute hashes, 1 inline script hashes, 1 updated CSP headers.");
  });

  it("does not scan HTML when auto-hashing has no configured CSP policy", async () => {
    const readDir = vi.spyOn(fs, "readdir").mockRejectedValue(new Error("HTML scan should not run"));
    try {
      await build({ headers: { "X-Test": "yes" }, csp: { autoHashes: true } });
      expect(readDir).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith("[astro-cloudflare-pages-headers] CSP auto-hash patch completed: 0 inline style hashes, 0 style attribute hashes, 0 inline script hashes, 0 updated CSP headers.");
    } finally { readDir.mockRestore(); }
  });

  it.each(["style", "attribute"])("guards fallback coverage when only %s hashes exist", async (category) => {
    const html = category === "style" ? "<style>p{color:red}</style>" : '<p style="color:red"></p>';
    await fs.writeFile(path.join(dist, "404.html"), html);
    await expect(build({ headers: { "Content-Security-Policy": "default-src 'none'" }, csp: { autoHashes: true } })).rejects.toThrow("404 fallback");
    await fs.rename(path.join(dist, "404.html"), path.join(dist, "index.html"));
    await fs.writeFile(path.join(dist, "_redirects"), "/*   /index.html   200\r\n");
    await expect(build({ headers: { "Content-Security-Policy": "default-src 'none'" }, csp: { autoHashes: true } })).rejects.toThrow("SPA fallback");
    await build({ headers: { "Content-Security-Policy": "default-src 'none'" }, csp: { autoHashes: true, mode: "global" } });
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain("sha256-");
  });

  it("permits a hash-free SPA fallback without inventing per-route overrides", async () => {
    await fs.writeFile(path.join(dist, "index.html"), "<p>No inline behavior</p>");
    await fs.writeFile(path.join(dist, "_redirects"), "/* /index.html 200\n");
    await build({ headers: { "Content-Security-Policy": "default-src 'none'" }, csp: { autoHashes: true } });
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).not.toContain("! content-security-policy");
  });

  it("maps a root page under base and unions files mapped to the same served route", async () => {
    await fs.mkdir(path.join(dist, "item"));
    await fs.writeFile(path.join(dist, "index.html"), "<script>baseRoot()</script>");
    await fs.writeFile(path.join(dist, "item.html"), "<style>a{color:red}</style>");
    await fs.writeFile(path.join(dist, "item", "index.html"), '<div style="color:blue"></div>');
    await fs.writeFile(path.join(dist, "wrangler.json"), JSON.stringify({ assets: { directory: ".", html_handling: "drop-trailing-slash" } }));
    await build({ headers: { "Content-Security-Policy": "default-src 'none'" }, csp: { autoHashes: true } }, undefined, "@astrojs/cloudflare", { base: "/docs/" });
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("/docs\n# BEGIN");
    const block = output.slice(output.indexOf("/docs/item\n# BEGIN"));
    expect(block).toContain(hashSha256("a{color:red}"));
    expect(block).toContain(hashSha256("color:blue"));
  });

  it("retains the cause and path when redirects or HTML cannot be read", async () => {
    const htmlPath = path.join(dist, "index.html");
    await fs.writeFile(htmlPath, "<script>read()</script>");
    const original = fs.readFile;
    for (const target of [path.join(dist, "_redirects"), htmlPath]) {
      const cause = Object.assign(new Error("access denied"), { code: "EACCES" });
      const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (String(args[0]) === target) throw cause;
        return original(...args);
      });
      try {
        await expect(build({ headers: { "Content-Security-Policy": "default-src 'self'" }, csp: { autoHashes: true } })).rejects.toMatchObject({ message: expect.stringContaining(target), cause });
      } finally { spy.mockRestore(); }
    }
  });

  it("removes temporary output after an atomic write fails", async () => {
    const spy = vi.spyOn(fs, "rename").mockRejectedValue(new Error("rename failed"));
    try { await expect(build({ headers: { "X-Test": "yes" } })).rejects.toThrow("Could not write finalized"); }
    finally { spy.mockRestore(); }
    expect((await fs.readdir(dist)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("checks final preserved line lengths and reports overflow warnings", async () => {
    await fs.writeFile(path.join(dist, "_headers"), `/manual\n  X-Preserved: ${"x".repeat(60)}\n`);
    await expect(build({ headers: {}, csp: { maxHeaderLineLength: 50 } })).rejects.toThrow("Header line length overflow");
    await build({ headers: {}, csp: { maxHeaderLineLength: 50, overflow: "warn" } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Cloudflare allows at most 2,000 characters per line"));
    expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain("X-Preserved:");
  });

  it("keeps valid matching cache policies and unrelated preserved headers without overrides", async () => {
    await fs.writeFile(path.join(dist, "_headers"), "/*\n  X-Preserved: unrelated\n/elsewhere/*\n  Cache-Control: private\n/_astro/*\n  Cache-Control: public, max-age=60\n");
    await build({ headers: { "/_astro/*": { "Cache-Control": "public, max-age=60", "X-Asset": "yes" }, "/other/*": { "Cache-Control": "private" } }, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare");
    const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
    expect(output).toContain("X-Preserved: unrelated");
    expect(output).not.toContain("! Cache-Control");
  });

  it("keeps an unrelated exact asset header from resolving conflicting cache policy", async () => {
    await expect(build({ headers: { "/*": { "Cache-Control": "public" }, "/:directory/*": { "Cache-Control": "private" }, "/_astro/*": { "X-Asset": "yes" } }, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare")).rejects.toThrow("Overlapping configured Cache-Control");
  });

  it("writes provisional headers to the rendered directory and final deployable directory", async () => {
    const assets = path.join(dist, "client");
    await fs.mkdir(assets);
    await fs.writeFile(path.join(dist, "wrangler.json"), JSON.stringify({ assets: { directory: "./client" } }));
    await fs.writeFile(path.join(assets, "_headers"), "/*\n  X-Client: preserved\n");
    let provisional = "";
    await build({ headers: { "X-Test": "generated" } }, undefined, "@astrojs/cloudflare", {}, undefined, async () => { provisional = await fs.readFile(path.join(dist, "_headers"), "utf8"); });
    expect(provisional).toContain("X-Test: generated");
    const final = await fs.readFile(path.join(assets, "_headers"), "utf8");
    expect(final).toContain("X-Test: generated");
    expect(final).toContain("X-Client: preserved");
    expect(logger.info).toHaveBeenCalledWith(`[astro-cloudflare-pages-headers] Wrote _headers during generated phase to ${assets}`);
    expect(logger.info).toHaveBeenCalledWith(`[astro-cloudflare-pages-headers] Wrote _headers during done phase to ${assets}`);
  });

  it("does not emit before configuration and warns when a configured build has no headers", async () => {
    const integration = astroCloudflarePagesHeaders();
    const hooks = integration.hooks as unknown as Record<string, (input: unknown) => Promise<void>>;
    await hooks["astro:build:generated"]({ dir: pathToFileURL(dist), logger });
    expect(await fs.readdir(dist)).toEqual([]);
    await build();
    expect(logger.warn).toHaveBeenCalledWith("[astro-cloudflare-pages-headers] No headers configuration found in Astro config. Skipping _headers generation.");
    expect(await fs.readdir(dist)).toEqual([]);
  });

  it("reports deprecated workers only when used", async () => {
    await build({ headers: { "X-Test": "yes" }, workers: true });
    expect(logger.warn).toHaveBeenCalledWith("[astro-cloudflare-pages-headers] The workers option is deprecated; wildcard routes are normalized automatically.");
  });

  it.each([null, {}, { csp: false }])("does not warn about native CSP without an enabled owner: %j", async (security) => {
    await build({ headers: { "Content-Security-Policy": "default-src 'self'" } }, undefined, undefined, { security });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("detects a native CSP conflict in one of several routes", async () => {
    await build({ headers: { "/unrelated": { "X-Test": "yes" }, "/*": { "Content-Security-Policy": "default-src 'self'" } } }, undefined, undefined, { security: { csp: true } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Astro native CSP"));
  });

});
