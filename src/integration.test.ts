import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import astroCloudflarePagesHeaders from "./integration.js";
import { countHeaderRules } from "./headers-file.js";
import type { AstroCloudflarePagesHeadersOptions } from "./types.js";

const hashSha256 = (value: string) => `sha256-${createHash("sha256").update(value, "utf8").digest("base64")}`;

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fork() { return this; } };
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
		const hooks = integration.hooks as unknown as Record<string, (input: unknown) => unknown>;
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
		if (typeof buildOverrides === "object" && buildOverrides !== null) Object.assign(config.build, buildOverrides);
		const updateConfig = vi.fn((next) => Object.assign(config, next));
		await hooks["astro:config:setup"]({ config, logger, updateConfig, addMiddleware, command: "build", isRestart: false, addRenderer: vi.fn() });
		afterSetup?.(config);
		await hooks["astro:config:done"]({ config, logger, setAdapter: vi.fn(), injectTypes: vi.fn(), buildOutput: adapterName ? "server" : "static" });
		await hooks["astro:build:generated"]({ dir: pathToFileURL(`${dist}${path.sep}`), logger });
		await afterGenerated?.();
		await hooks["astro:build:done"]({ dir: pathToFileURL(`${dist}${path.sep}`), logger, pages: [], assets: new Map() });
		return { integration, hooks, config, updateConfig };
	}

	it("writes flat headers with an absolute output path", async () => {
		await build({}, { "X-Test": "value" });
		expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toBe("/*\n# BEGIN astro-cloudflare-pages-headers\n  X-Test: value\n# END astro-cloudflare-pages-headers\n");
	});

	it("uses omitted nested legacy server headers as the fallback source", async () => {
		await build({}, { "/legacy/*": { "X-Legacy": "kept" } });
		expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain("/legacy/*\n# BEGIN astro-cloudflare-pages-headers\n  X-Legacy: kept");
	});

	it("merges the source public _headers when the deployable asset directory is nested", async () => {
		const publicDir = path.join(root, "public");
		await fs.mkdir(publicDir);
		await fs.writeFile(path.join(publicDir, "_headers"), "/*\n  X-Public: preserve\n");
		await build({ headers: { "X-Generated": "configured" } }, undefined, undefined, { publicDir });
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("X-Public: preserve");
		expect(output).toContain("X-Generated: configured");
	});

	it("uses final setup headers, preserves inputs, and clears removed rules after a restart", async () => {
		const initial = { "*": { "X-Initial": "before" } };
		const first = await build({}, initial);
		expect(initial).toEqual({ "*": { "X-Initial": "before" } });
		expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain("X-Initial: before");

		const late = { "/after/*": { "X-Late": "after-setup" } };
		const second = await build({ assetsDirectory: "dist" }, initial, "@astrojs/cloudflare", {}, (config) => { config.server.headers = late; });
		const runtimePlugin = (second.config as unknown as { vite: { plugins: Array<{ config(): { define: Record<string, string> } }> } }).vite.plugins[0];
		expect(JSON.parse(runtimePlugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__)).toEqual({ enabled: true, routes: { "/after/*": { "X-Late": "after-setup" } } });
		const changed = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(changed).toContain("X-Late: after-setup");
		expect(changed).not.toContain("X-Initial: before");
		expect(late).toEqual({ "/after/*": { "X-Late": "after-setup" } });

		second.config.server.headers = { "/restart/*": { "X-Restart": "new" } };
		await second.hooks["astro:config:done"]({ config: second.config, logger, setAdapter: vi.fn(), injectTypes: vi.fn(), buildOutput: "static" });
		await second.hooks["astro:build:done"]({ dir: pathToFileURL(`${dist}${path.sep}`), logger, pages: [], assets: new Map() });
		const restarted = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(JSON.parse(runtimePlugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__)).toEqual({ enabled: true, routes: { "/restart/*": { "X-Restart": "new" } } });
		expect(restarted).toContain("X-Restart: new");
		expect(restarted).not.toContain("X-Late: after-setup");
		expect(restarted).not.toContain("X-Initial: before");

		second.config.server.headers = {};
		await second.hooks["astro:config:done"]({ config: second.config, logger, setAdapter: vi.fn(), injectTypes: vi.fn(), buildOutput: "static" });
		await second.hooks["astro:build:done"]({ dir: pathToFileURL(`${dist}${path.sep}`), logger, pages: [], assets: new Map() });
		await expect(fs.access(path.join(dist, "_headers"))).rejects.toThrow();
		expect(JSON.parse(runtimePlugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__)).toEqual({ enabled: true, routes: {} });
		expect(first.integration.name).toBe("astroCloudflarePagesHeaders");
	});

	it("preserves user rules and replaces its generated section on repeated builds", async () => {
		await fs.writeFile(path.join(dist, "_headers"), "# manual\n/*\n  X-Manual: keep\n\n");
		await build({ headers: { "X-First": "one" } });
		await build({ headers: { "X-Second": "two" } });
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("X-Manual: keep");
		expect(output).not.toContain("X-First: one");
		expect(output).toContain("X-Second: two");
		expect(output.match(/\/\*/g)).toHaveLength(1);
	});

	it("accepts nested rules, always normalizes universal routes, and does not mutate the caller", async () => {
		const headers = { "*": { "X-Test": "wildcard" }, "/*": { "x-test": "explicit" } };
		await build({ headers });
		expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toContain("x-test: explicit");
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('explicit "/*" values win'));
		expect(headers["*"]["X-Test"]).toBe("wildcard");
	});

	it("lets an explicit empty options object override legacy Astro server headers", async () => {
		await fs.writeFile(path.join(dist, "_headers"), "# manual stays\n");
		await build({ headers: {} }, { "X-Legacy": "no" });
		expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toBe("# manual stays\n");
	});

	it.each([
		[{ "/path": { "X-Test": 1 } }, "must have a string value"],
		[{ "/path": { "X-Test": null } }, "must have a string value"],
		[{ "/path?query": { "X-Test": "no" } }, "query strings"],
		[{ "/path#fragment": { "X-Test": "no" } }, "fragments"],
		[{ "/:id/:id": { "X-Test": "no" } }, "repeats a named placeholder"],
		[{ "https://user@example.com/*": { "X-Test": "no" } }, "credentials"],
		[{ "http://example.com/*": { "X-Test": "no" } }, "must use HTTPS"],
	] as const)("rejects malformed configuration %#", async (headers, message) => {
		await expect(build({ headers: headers as AstroCloudflarePagesHeadersOptions["headers"] })).rejects.toThrow(message);
	});

	it("selects automatic, explicit, and disabled runtime behavior", async () => {
		const automatic = await build({ headers: { "X-Test": "one" }, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare");
		expect(addMiddleware).toHaveBeenCalledWith(expect.objectContaining({ order: "pre" }));
		expect(automatic.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ vite: expect.objectContaining({ plugins: expect.any(Array) }) }));
		const plugin = (automatic.config as unknown as { vite: { plugins: Array<{ config(): { define: Record<string, string> } }> } }).vite.plugins[0];
		expect(JSON.parse(plugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__)).toMatchObject({ enabled: true });

		addMiddleware.mockClear();
		const inactive = await build({ headers: { "X-Test": "one" }, assetsDirectory: "dist" });
		expect(addMiddleware).toHaveBeenCalledWith(expect.objectContaining({ order: "pre" }));
		const inactivePlugin = (inactive.config as unknown as { vite: { plugins: Array<{ config(): { define: Record<string, string> } }> } }).vite.plugins[0];
		expect(JSON.parse(inactivePlugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__)).toMatchObject({ enabled: false });

		const explicit = await build({ headers: { "X-Test": "one" }, runtime: true, assetsDirectory: "dist" });
		const explicitPlugin = (explicit.config as unknown as { vite: { plugins: Array<{ config(): { define: Record<string, string> } }> } }).vite.plugins[0];
		expect(JSON.parse(explicitPlugin.config().define.__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__)).toMatchObject({ enabled: true });

		addMiddleware.mockClear();
		await build({ headers: { "X-Test": "one" }, runtime: false, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare");
		expect(addMiddleware).not.toHaveBeenCalled();
	});

	it("preserves wildcard CSP and emits an exact removal/replacement for a generated page", async () => {
		const inline = "console.log('page')";
		await fs.writeFile(path.join(dist, "index.html"), `<script>${inline}</script>`);
		const headers = { "Content-Security-Policy": "default-src 'self'; script-src 'self'" };
		await build({ csp: { autoHashes: true }, headers });
		expect(headers).toEqual({ "Content-Security-Policy": "default-src 'self'; script-src 'self'" });
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("/*\n# BEGIN astro-cloudflare-pages-headers\n  Content-Security-Policy: default-src 'self'; script-src 'self'");
		expect(output).toContain("/\n# BEGIN astro-cloudflare-pages-headers\n  ! content-security-policy\n  Content-Security-Policy: default-src 'self'; script-src 'self' '");
		expect(output).toContain(hashSha256(inline));
	});

	it("reports read, write, CSP scan, and generated-config parse failures with paths", async () => {
		const headersPath = path.join(dist, "_headers");
		await fs.mkdir(headersPath);
		await expect(build({ headers: { "X-Test": "yes" } })).rejects.toThrow(`Could not read existing _headers file at ${headersPath}`);
		await fs.rm(headersPath, { recursive: true });

		const rename = vi.spyOn(fs, "rename").mockRejectedValue(new Error("injected write failure"));
		try {
			await expect(build({ headers: { "X-Test": "yes" } })).rejects.toThrow(`Could not write finalized _headers file at ${headersPath}`);
		} finally {
			rename.mockRestore();
		}

		await fs.rm(dist, { recursive: true, force: true });
		await expect(build({ headers: { "Content-Security-Policy": "default-src 'self'" }, csp: { autoHashes: true } })).rejects.toThrow(`Could not scan generated HTML directory ${dist}`);
		await fs.mkdir(dist, { recursive: true });
		await fs.writeFile(path.join(dist, "wrangler.jsonc"), "{ broken");
		await expect(build({ headers: { "X-Test": "yes" }, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare"))
			.rejects.toThrow(`Could not parse generated Wrangler configuration at ${path.join(dist, "wrangler.jsonc")}`);
	});

	it("keeps a hash-free page policy and leaves unrestricted CSP categories unrestricted", async () => {
		await fs.writeFile(path.join(dist, "index.html"), "<main>plain</main>");
		await build({ csp: { autoHashes: true }, headers: { "Content-Security-Policy": "frame-ancestors 'none'" } });
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("Content-Security-Policy: frame-ancestors 'none'");
		expect(output).not.toContain("script-src");
		expect(output).not.toContain("style-src");
	});

	it("preserves exact route fields and their prior effective order when expanding CSP", async () => {
		await fs.mkdir(path.join(dist, "about"), { recursive: true });
		await fs.writeFile(path.join(dist, "_headers"), "/*\n  X-Manual: preserved\n");
		await fs.writeFile(path.join(dist, "about", "index.html"), "<script>go()</script>");
		await build({
			headers: {
				"/about/": { "X-Order": "exact", "Content-Security-Policy": "default-src 'self'; script-src 'self'" },
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
		await expect(build({ headers: { "/test": { "X-Long-Header": "x".repeat(2100) } } })).rejects.toThrow("2,000 characters");
		await expect(build({ headers: { "bad route": { "X-Test": "value" } } })).rejects.toThrow("must begin");
	});

	it("detaches a full asset Cache-Control override from an overlapping wildcard", async () => {
		await build({ headers: {
			"/*": { "Cache-Control": "public, max-age=60" },
			"/_astro/*": { "Cache-Control": "public, max-age=300" },
		}, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare");
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("! Cache-Control");
		expect(output).toContain("Cache-Control: public, max-age=300");
	});

	it("rejects a narrow cache rule that collides with adapter asset caching", async () => {
		await expect(build({ headers: { "/_astro/*.css": { "Cache-Control": "public, max-age=300" } }, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare"))
			.rejects.toThrow("overlaps only part of the generated asset directory");
	});

	it("rejects a conflicting preserved asset cache policy", async () => {
		await fs.writeFile(path.join(dist, "_headers"), "/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n");
		await expect(build({ headers: { "/*": { "Cache-Control": "public, max-age=60" } }, assetsDirectory: "dist" }, undefined, "@astrojs/cloudflare"))
			.rejects.toThrow("preserved _headers Cache-Control rule conflicts");
	});


	it("maps CSP pages through base and resolved Cloudflare HTML handling", async () => {
		await fs.mkdir(path.join(dist, "about"), { recursive: true });
		await fs.writeFile(path.join(dist, "about", "index.html"), "<script>about()</script>");
		await fs.writeFile(path.join(dist, "wrangler.jsonc"), JSON.stringify({ assets: { directory: ".", html_handling: "drop-trailing-slash" } }));
		await build(
			{ headers: { "/*": { "Content-Security-Policy": "default-src 'self'; script-src 'self'" } }, csp: { autoHashes: true } },
			undefined,
			"@astrojs/cloudflare",
			{ base: "/docs/", build: { format: "directory" } },
		);
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("/docs/about\n# BEGIN astro-cloudflare-pages-headers");
		expect(output).toContain(hashSha256("about()"));
		expect(output).not.toContain("/about/\n# BEGIN");
	});

	it("keeps a no-hash 404 fallback on its original wildcard CSP and rejects host-qualified expansion", async () => {
		await fs.writeFile(path.join(dist, "404.html"), "<main>not found</main>");
		await fs.writeFile(path.join(dist, "wrangler.json"), JSON.stringify({ assets: { directory: ".", not_found_handling: "404-page" } }));
		await build({ headers: { "Content-Security-Policy": "default-src 'none'" }, csp: { autoHashes: true } }, undefined, "@astrojs/cloudflare");
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("/*\n# BEGIN astro-cloudflare-pages-headers\n  Content-Security-Policy: default-src 'none'");
		expect(output).not.toContain("! content-security-policy");

		await fs.rm(path.join(dist, "_headers"));
		await fs.rm(path.join(dist, "404.html"));
		await fs.writeFile(path.join(dist, "index.html"), "<script>host-route()</script>");
		await expect(build({
			headers: { "https://:site.example/*": { "Content-Security-Policy": "default-src 'self'; script-src 'self'" } },
			csp: { autoHashes: true },
		}, undefined, "@astrojs/cloudflare")).rejects.toThrow("host-qualified headers also match");
		await expect(fs.access(path.join(dist, "_headers"))).rejects.toThrow();
	});

	it("rejects route CSP expansion when preserved manual policy also matches HTML", async () => {
		await fs.writeFile(path.join(dist, "index.html"), "<script>inline()</script>");
		await fs.writeFile(path.join(dist, "_headers"), "/*\n  Content-Security-Policy: default-src 'none'\n");
		await expect(build({ headers: { "/*": { "Content-Security-Policy": "default-src 'self'; script-src 'self'" } }, csp: { autoHashes: true } }))
			.rejects.toThrow("preserved _headers CSP policy");
	});
	it("rejects unresolved global CSP conflicts before writing provisional output", async () => {
		await fs.writeFile(path.join(dist, "index.html"), "<script>global-conflict()</script>");
		const preserved = "/*\n  Content-Security-Policy: default-src 'none'\n";
		await fs.writeFile(path.join(dist, "_headers"), preserved);
		await expect(build({
			headers: { "Content-Security-Policy": "default-src 'self'; script-src 'self'" },
			csp: { autoHashes: true, mode: "global" },
		})).rejects.toThrow("preserved _headers CSP policy");
		expect(await fs.readFile(path.join(dist, "_headers"), "utf8")).toBe(preserved);
	});

	it("keeps the wildcard CSP when no generated HTML needs route overrides", async () => {
		await build({ headers: { "Content-Security-Policy": "default-src 'none'" }, csp: { autoHashes: true } });
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("/*\n# BEGIN astro-cloudflare-pages-headers\n  Content-Security-Policy: default-src 'none'");
		expect(output).not.toContain("! content-security-policy");
	});

	it.each([
		["404-page", "404/index.html"],
		["single-page-application", "index.html"],
	])("rejects route hashes for %s fallback HTML", async (notFoundHandling, htmlPath) => {
		const file = path.join(dist, htmlPath);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "<script>fallback()</script>");
		await fs.writeFile(path.join(dist, "wrangler.json"), JSON.stringify({ assets: { directory: ".", not_found_handling: notFoundHandling } }));
		await expect(build({ headers: { "/*": { "Content-Security-Policy": "default-src 'self'; script-src 'self'" } }, csp: { autoHashes: true } }, undefined, "@astrojs/cloudflare"))
			.rejects.toThrow("cannot cover");
	});

	it("rejects per-route CSP expansion for Pages 404 and redirect-based SPA fallbacks", async () => {
		await fs.writeFile(path.join(dist, "404.html"), "<script>not-found()</script>");
		await expect(build({ headers: { "Content-Security-Policy": "default-src 'self'; script-src 'self'" }, csp: { autoHashes: true } }))
			.rejects.toThrow("404 fallback served for arbitrary paths");
		await fs.rm(path.join(dist, "404.html"));
		await fs.writeFile(path.join(dist, "index.html"), "<script>spa()</script>");
		await fs.writeFile(path.join(dist, "_redirects"), "/* /index.html 200\n");
		await expect(build({ headers: { "Content-Security-Policy": "default-src 'self'; script-src 'self'" }, csp: { autoHashes: true } }))
			.rejects.toThrow("SPA fallback served at arbitrary paths");
	});


	it("moves a matching exact CSP rule onto the served drop-trailing-slash path", async () => {
		await fs.mkdir(path.join(dist, "about"), { recursive: true });
		await fs.writeFile(path.join(dist, "about", "index.html"), "<script>about-drop()</script>");
		await fs.writeFile(path.join(dist, "wrangler.jsonc"), JSON.stringify({ assets: { directory: ".", html_handling: "drop-trailing-slash" } }));
		await build({
			headers: {
				"/docs/about/": { "X-Order": "exact" },
				"/*": { "X-Order": "general", "Content-Security-Policy": "default-src 'self'; script-src 'self'" },
			},
			csp: { autoHashes: true },
		}, undefined, "@astrojs/cloudflare", { base: "/docs/", build: { format: "directory" } });
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("/docs/about\n# BEGIN astro-cloudflare-pages-headers");
		expect(output).not.toContain("/docs/about/\n# BEGIN astro-cloudflare-pages-headers");
		expect(output).toContain("X-Order: exact, general");
		expect(output).toContain(hashSha256("about-drop()"));
	});

	it.each([
		["auto-trailing-slash", "/docs/about/"],
		["force-trailing-slash", "/docs/about/"],
		["drop-trailing-slash", "/docs/about"],
		["none", "/docs/about/index.html"],
	])("maps directory CSP routes with html_handling=%s", async (htmlHandling, expectedRoute) => {
		await fs.mkdir(path.join(dist, "about"), { recursive: true });
		await fs.writeFile(path.join(dist, "about", "index.html"), "<script>about-mode()</script>");
		await fs.writeFile(path.join(dist, "wrangler.jsonc"), JSON.stringify({ assets: { directory: ".", html_handling: htmlHandling } }));
		await build(
			{ headers: { "/*": { "Content-Security-Policy": "default-src 'self'; script-src 'self'" } }, csp: { autoHashes: true } },
			undefined,
			"@astrojs/cloudflare",
			{ base: "/docs/", build: { format: "directory" } },
		);
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain(expectedRoute + "\n# BEGIN astro-cloudflare-pages-headers");
		expect(output).toContain(hashSha256("about-mode()"));
	});

	it("patches every matching CSP policy without changing its source lists", async () => {
		const inlineScript = "cdn-page()";
		await fs.writeFile(path.join(dist, "index.html"), "<script>" + inlineScript + "</script>");
		await build({
			headers: {
				"Content-Security-Policy": "default-src https://cdn.example; script-src 'self', default-src 'none'; script-src https://scripts.example",
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
		await fs.writeFile(path.join(dist, "index.html"), "<style>" + style + "</style><script>" + script + "</script>");
		await build({
			headers: {
			"Content-Security-Policy": "DEFAULT-SRC 'none'; SCRIPT-SRC 'self'; STYLE-SRC https://styles.example",
		},
			csp: { autoHashes: true },
		});
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("DEFAULT-SRC 'none'");
		expect(output).toContain("SCRIPT-SRC 'self' '" + hashSha256(script) + "'");
		expect(output).toContain("STYLE-SRC https://styles.example '" + hashSha256(style) + "'");
		expect(output).not.toMatch(/(?:^|; )script-src(?: |;)/);
		expect(output).not.toMatch(/(?:^|; )style-src(?: |;)/);
	});

	it("inherits directive fallbacks, hashes enabled categories, and strips unsafe-inline only as configured", async () => {
		const script = "script-category()";
		const style = "body { color: red; }";
		const attribute = "color: blue";
		await fs.writeFile(path.join(dist, "index.html"), '<style>' + style + '</style><div style="' + attribute + '"></div><script>' + script + '</script>');
		await build({
			headers: {
				"Content-Security-Policy": "default-src https://default.example; script-src https://scripts.example 'unsafe-inline'; script-src-elem https://script-elements.example 'unsafe-inline'; style-src https://styles.example 'unsafe-inline'; style-src-elem https://style-elements.example 'unsafe-inline'",
			},
			csp: { autoHashes: true },
		});
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		const exactStart = output.indexOf("/\n# BEGIN astro-cloudflare-pages-headers", output.indexOf("/*"));
		const exactBlock = output.slice(exactStart);
		expect(exactBlock).toContain("script-src https://scripts.example '" + hashSha256(script) + "'");
		expect(exactBlock).toContain("script-src-elem https://script-elements.example '" + hashSha256(script) + "'");
		expect(exactBlock).toContain("style-src https://styles.example '" + hashSha256(style) + "'");
		expect(exactBlock).toContain("style-src-elem https://style-elements.example '" + hashSha256(style) + "'");
		expect(exactBlock).toContain("style-src-attr https://styles.example '" + hashSha256(style) + "' 'unsafe-hashes' '" + hashSha256(attribute) + "'");
		expect(exactBlock).not.toContain("'unsafe-inline'");
		expect(exactBlock).not.toContain("'self'");
		expect(exactBlock).toContain("default-src https://default.example");
	});

	it("leaves disabled hash categories untouched and lets global mode cover a hash-bearing fallback", async () => {
		await fs.writeFile(path.join(dist, "index.html"), "<script>fallback-global()</script>");
		await fs.writeFile(path.join(dist, "_redirects"), "/* /index.html 200\n");
		await build({
			headers: { "Content-Security-Policy": "default-src 'self'; script-src 'self'" },
			csp: { autoHashes: true, mode: "global", hashInlineScripts: false, hashStyleElements: false, hashStyleAttributes: false },
		});
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("Content-Security-Policy: default-src 'self'; script-src 'self'");
		expect(output).not.toContain("sha256-");
		expect(logger.warn.mock.calls.flat().join("\n")).toContain("no hash categories are enabled");
	});


	it("keeps unsafe-inline when explicitly configured not to strip it", async () => {
		const inlineScript = "unsafe-inline-kept()";
		await fs.writeFile(path.join(dist, "index.html"), "<script>" + inlineScript + "</script>");
		await build({
			headers: { "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'" },
			csp: { autoHashes: true, stripUnsafeInline: false },
		});
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("'unsafe-inline'");
		expect(output).toContain(hashSha256(inlineScript));
	});

	it("does not change CSP when auto-hashing is disabled", async () => {
		await fs.writeFile(path.join(dist, "index.html"), "<script>disabled-auto-hash()</script>");
		await build({ headers: { "Content-Security-Policy": "default-src 'self'; script-src 'self'" }, csp: { autoHashes: false } });
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output).toContain("Content-Security-Policy: default-src 'self'; script-src 'self'");
		expect(output).not.toContain("sha256-");
		expect(output).not.toContain("! content-security-policy");
	});

	it("adds the union of route hashes to a global policy used by an SPA fallback", async () => {
		await fs.mkdir(path.join(dist, "about"), { recursive: true });
		await fs.writeFile(path.join(dist, "index.html"), "<script>global-index()</script>");
		await fs.writeFile(path.join(dist, "about", "index.html"), "<script>global-about()</script>");
		await fs.writeFile(path.join(dist, "_redirects"), "/* /index.html 200\n");
		await build({
			headers: { "Content-Security-Policy": "default-src 'self'; script-src 'self'" },
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
		const warnings = logger.warn.mock.calls.flat().filter((message) => String(message).includes("Astro native CSP"));
		expect(warnings).toHaveLength(1);
	});

	it("accepts the exact Cloudflare rule and line limits and rejects the next unit", async () => {
		const exactlyHundred = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`/route-${index}`, { "X-Test": "ok" }]));
		await build({ headers: exactlyHundred });
		expect(countHeaderRules(await fs.readFile(path.join(dist, "_headers"), "utf8"))).toBe(100);
		await fs.rm(path.join(dist, "_headers"), { force: true });

		const exactlyTwoThousand = "x".repeat(1990);
		await build({ headers: { "X-Test": exactlyTwoThousand } });
		const line = (await fs.readFile(path.join(dist, "_headers"), "utf8")).split("\n").find((value) => value.includes("X-Test:"));
		expect(line?.length).toBe(2000);
	});
	it("recounts adapter-added rules after the generated phase", async () => {
		const exactlyHundred = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`/route-${index}`, { "X-Test": "ok" }]));
		let generatedRuleCount = 0;
		await expect(build(
			{ headers: exactlyHundred, assetsDirectory: "dist" },
			undefined,
			"@astrojs/cloudflare",
			{},
			undefined,
			async () => {
				generatedRuleCount = countHeaderRules(await fs.readFile(path.join(dist, "_headers"), "utf8"));
				await fs.appendFile(path.join(dist, "_headers"), "/_adapter-added\n  X-Adapter-Cache: immutable\n");
			},
		)).rejects.toThrow("101 rules");
		expect(generatedRuleCount).toBe(100);
	});

	it("counts exact routes added by CSP expansion against Cloudflare's rule cap", async () => {
		await fs.writeFile(path.join(dist, "index.html"), "<script>limit-route()</script>");
		const routes: Record<string, Record<string, string>> = {
			"/*": { "Content-Security-Policy": "default-src 'self'; script-src 'self'" },
		};
		for (let index = 0; index < 99; index += 1) routes[`/other-${index}`] = { "X-Test": "ok" };
		await expect(build({ headers: routes, csp: { autoHashes: true } })).rejects.toThrow("101 rules");
	});

	it("rejects Cloudflare limit overflow by default and warns only when requested", async () => {
		const oneHundredOne = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`/route-${index}`, { "X-Test": "ok" }]));
		await expect(build({ headers: oneHundredOne })).rejects.toThrow("101 rules");
		await expect(build({ headers: { "X-Test": "x".repeat(1991) } })).rejects.toThrow("2001 characters");
		await build({ headers: { "X-Test": "x".repeat(1991) }, csp: { overflow: "warn" } });
		expect(logger.warn.mock.calls.flat().join("\n")).toContain("2001 characters");
	});

	it("enforces custom and Cloudflare hard line limits after merging preserved rules", async () => {
		await expect(build({ headers: { "X-Test": "x".repeat(991) }, csp: { maxHeaderLineLength: 1000 } })).rejects.toThrow("Max allowed is 1,000 characters");
		await expect(build({ headers: { "X-Test": "x".repeat(1991) }, csp: { maxHeaderLineLength: 5000 } })).rejects.toThrow("2,000 characters");
		const preserved = Array.from({ length: 100 }, (_, index) => `/manual-${index}\n  X-Manual: ${index}\n`).join("");
		await fs.writeFile(path.join(dist, "_headers"), preserved);
		await expect(build({ headers: { "X-Generated": "yes" } })).rejects.toThrow("101 rules");
	});

	it("updates one same-path generated rule and keeps distinct manual values", async () => {
		await fs.writeFile(path.join(dist, "_headers"), "/*\n  X-Manual: keep\n  X-Configured: old\n\n");
		await build({ headers: { "X-Configured": "new" } });
		const output = await fs.readFile(path.join(dist, "_headers"), "utf8");
		expect(output.match(/\/\*/g)).toHaveLength(1);
		expect(output).toContain("X-Manual: keep");
		expect(output).toContain("X-Configured: new");
		expect(output).toContain("X-Configured: old");
	});
});
