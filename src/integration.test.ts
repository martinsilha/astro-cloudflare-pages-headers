/* eslint-disable */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import astroCloudflarePagesHeaders from "./integration";
import type { AstroCloudflarePagesHeadersOptions } from "./types";

describe("astro-cloudflarePagesHeaders integration", () => {
	let integration = astroCloudflarePagesHeaders();
	let hooks: any;
	let logger: any;
	let writeFileSpy: any;

	const hashSha256 = (value: string): string =>
		`sha256-${createHash("sha256").update(value, "utf8").digest("base64")}`;

	const parseGeneratedHeaders = (content: string): Record<string, Record<string, string>> => {
		const parsed: Record<string, Record<string, string>> = {};
		let currentRoute: string | undefined;

		for (const line of content.split("\n")) {
			if (!line.trim()) {
				continue;
			}

			if (!line.startsWith("  ")) {
				currentRoute = line.trim();
				parsed[currentRoute] = {};
				continue;
			}

			if (!currentRoute) {
				continue;
			}

			const delimiterIndex = line.indexOf(":");
			if (delimiterIndex < 0) {
				continue;
			}

			const headerName = line.slice(2, delimiterIndex).trim();
			const headerValue = line.slice(delimiterIndex + 1).trim();
			parsed[currentRoute][headerName] = headerValue;
		}

		return parsed;
	};

	const createLogger = () => {
		const nextLogger: any = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			options: { dest: "console", level: "info" },
			label: "test",
			fork: () => nextLogger,
		};
		return nextLogger;
	};

	const configureHeaders = (headers: Record<string, string> | Record<string, Record<string, string>>) => {
		const config = ({
			server: { headers },
			integrations: [],
			trailingSlash: "ignore",
			redirects: {},
			build: {},
		} as any) as any;

		hooks["astro:config:setup"]({
			config,
			logger,
			command: "build",
			isRestart: false,
			updateConfig: (cfg: any) => cfg,
			addRenderer: () => {},
		});
	};

	const runBuildDone = async (buildDir = "buildDir") => {
		await hooks["astro:build:done"]({
			pages: [],
			routes: [],
			assets: new Map(),
			dir: new URL(buildDir, "file:///"),
			logger,
		});
	};

	const createDirent = (name: string, kind: "file" | "directory"): Dirent =>
		({
			name,
			isFile: () => kind === "file",
			isDirectory: () => kind === "directory",
			isBlockDevice: () => false,
			isCharacterDevice: () => false,
			isSymbolicLink: () => false,
			isFIFO: () => false,
			isSocket: () => false,
		}) as Dirent;

	const setIntegration = (options?: AstroCloudflarePagesHeadersOptions) => {
		integration = astroCloudflarePagesHeaders(options);
		hooks = integration.hooks;
	};

	beforeEach(() => {
		logger = createLogger();
		setIntegration();
		writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("should log a warning and skip writing file if no headers config is provided", async () => {
		await runBuildDone();

		expect(logger.warn).toHaveBeenCalledWith(
			"[astro-cloudflare-pages-headers] No headers configuration found in Astro config. Skipping _headers generation.",
		);
		expect(writeFileSpy).not.toHaveBeenCalled();
	});

	it("should generate _headers file with flat headers", async () => {
		configureHeaders({ "X-Test": "value" });

		await runBuildDone();

		const expectedContent = "/*\n  X-Test: value\n";
		const expectedFilePath = path.resolve("buildDir", "_headers");

		expect(writeFileSpy).toHaveBeenCalledWith(expectedFilePath, expectedContent, "utf-8");
		expect(logger.info).toHaveBeenCalledWith(
			`[astro-cloudflare-pages-headers] Successfully created _headers at ${expectedFilePath}`,
		);
	});

	it("should generate _headers file with nested headers", async () => {
		configureHeaders({ "/test": { "X-Test": "value" } });

		await runBuildDone();

		const expectedContent = "/test\n  X-Test: value\n";
		const expectedFilePath = path.resolve("buildDir", "_headers");

		expect(writeFileSpy).toHaveBeenCalledWith(expectedFilePath, expectedContent, "utf-8");
		expect(logger.info).toHaveBeenCalledWith(
			`[astro-cloudflare-pages-headers] Successfully created _headers at ${expectedFilePath}`,
		);
	});

	it("should remap universal '*' route to '/*' when workers mode is enabled", async () => {
		setIntegration({ workers: true });
		configureHeaders({ "*": { "X-Test": "value" } });

		await runBuildDone();

		const expectedContent = "/*\n  X-Test: value\n";
		const expectedFilePath = path.resolve("buildDir", "_headers");

		expect(writeFileSpy).toHaveBeenCalledWith(expectedFilePath, expectedContent, "utf-8");
	});

	it("should not patch CSP when auto-hashes are disabled", async () => {
		const readdirSpy = vi.spyOn(fs, "readdir");
		const readFileSpy = vi.spyOn(fs, "readFile");

		configureHeaders({
			"Content-Security-Policy":
				"default-src 'self'; style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
		});

		await runBuildDone();

		const writtenHeaders = writeFileSpy.mock.calls[0][1] as string;
		expect(writtenHeaders).toContain("style-src 'self' 'unsafe-inline'");
		expect(writtenHeaders).toContain("style-src-attr 'unsafe-inline'");
		expect(writtenHeaders).toContain("script-src 'self' 'unsafe-inline'");
		expect(readdirSpy).not.toHaveBeenCalled();
		expect(readFileSpy).not.toHaveBeenCalled();
	});

	it("should patch inline hashes when csp.autoHashes is enabled", async () => {
		setIntegration({
			csp: {
				autoHashes: true,
				hashInlineScripts: true,
			},
		});

		const styleContent = "body{color:red}";
		const styleAttributeValue = "color:red";
		const scriptContent = "console.log('hi')";
		const html = `<style>${styleContent}</style><div style="${styleAttributeValue}"></div><script>${scriptContent}</script>`;
		const buildDirPath = path.resolve("buildDir");
		const htmlPath = path.resolve(buildDirPath, "index.html");

		vi.spyOn(fs, "readdir").mockImplementation(async (directoryPath) => {
			if (path.resolve(String(directoryPath)) === buildDirPath) {
				return [createDirent("index.html", "file")] as any;
			}
			return [] as any;
		});

		vi.spyOn(fs, "readFile").mockImplementation(async (filePath) => {
			if (path.resolve(String(filePath)) === htmlPath) {
				return html as any;
			}
			return "" as any;
		});

		configureHeaders({
			"/test": {
				"Content-Security-Policy":
					"default-src 'self'; style-src 'self' 'unsafe-inline'; style-src-attr 'none'; script-src 'self' 'unsafe-inline'",
			},
		});

		await runBuildDone();

		const styleHash = hashSha256(styleContent);
		const styleAttrHash = hashSha256(styleAttributeValue);
		const scriptHash = hashSha256(scriptContent);
		const writtenHeaders = writeFileSpy.mock.calls[0][1] as string;

		expect(writtenHeaders).toContain(`style-src 'self' '${styleHash}'`);
		expect(writtenHeaders).toContain(`style-src-attr 'unsafe-hashes' '${styleAttrHash}'`);
		expect(writtenHeaders).toContain(`script-src 'self' '${scriptHash}'`);
		expect(writtenHeaders).not.toContain("style-src-attr 'none'");
		expect(writtenHeaders).not.toContain("'unsafe-inline'");
		expect(
			logger.info.mock.calls.some((call: [string]) =>
				call[0].includes("CSP auto-hash patch completed: 1 inline style hashes, 1 style attribute hashes, 1 inline script hashes, 1 updated CSP headers."),
			),
		).toBe(true);
	});

	it("should patch CSP hashes per HTML route when csp.mode is route", async () => {
		setIntegration({
			csp: {
				autoHashes: true,
				hashInlineScripts: true,
				mode: "route",
			},
		});

		const rootStyleContent = "body{color:red}";
		const rootScriptContent = "console.log('root')";
		const aboutStyleContent = "body{color:blue}";
		const aboutScriptContent = "console.log('about')";
		const rootHtml = `<style>${rootStyleContent}</style><script>${rootScriptContent}</script>`;
		const aboutHtml = `<style>${aboutStyleContent}</style><script>${aboutScriptContent}</script>`;
		const buildDirPath = path.resolve("buildDir");
		const aboutDirPath = path.resolve(buildDirPath, "about");
		const rootHtmlPath = path.resolve(buildDirPath, "index.html");
		const aboutHtmlPath = path.resolve(aboutDirPath, "index.html");

		vi.spyOn(fs, "readdir").mockImplementation(async (directoryPath) => {
			const resolvedDirectory = path.resolve(String(directoryPath));
			if (resolvedDirectory === buildDirPath) {
				return [
					createDirent("index.html", "file"),
					createDirent("about", "directory"),
				] as any;
			}
			if (resolvedDirectory === aboutDirPath) {
				return [createDirent("index.html", "file")] as any;
			}
			return [] as any;
		});

		vi.spyOn(fs, "readFile").mockImplementation(async (filePath) => {
			const resolvedFilePath = path.resolve(String(filePath));
			if (resolvedFilePath === rootHtmlPath) {
				return rootHtml as any;
			}
			if (resolvedFilePath === aboutHtmlPath) {
				return aboutHtml as any;
			}
			return "" as any;
		});

		configureHeaders({
			"Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self';",
			"X-Test": "value",
		});

		await runBuildDone();

		const rootStyleHash = hashSha256(rootStyleContent);
		const rootScriptHash = hashSha256(rootScriptContent);
		const aboutStyleHash = hashSha256(aboutStyleContent);
		const aboutScriptHash = hashSha256(aboutScriptContent);
		const writtenHeaders = writeFileSpy.mock.calls[0][1] as string;
		const parsedHeaders = parseGeneratedHeaders(writtenHeaders);

		expect(parsedHeaders["/*"]["Content-Security-Policy"]).toBe(
			"default-src 'self'; style-src 'self'; script-src 'self';",
		);
		expect(parsedHeaders["/*"]["X-Test"]).toBe("value");

		expect(parsedHeaders["/"]["Content-Security-Policy"]).toContain(
			`style-src 'self' '${rootStyleHash}'`,
		);
		expect(parsedHeaders["/"]["Content-Security-Policy"]).toContain(
			`script-src 'self' '${rootScriptHash}'`,
		);
		expect(parsedHeaders["/"]["Content-Security-Policy"]).not.toContain(aboutStyleHash);
		expect(parsedHeaders["/"]["Content-Security-Policy"]).not.toContain(aboutScriptHash);

		expect(parsedHeaders["/about/"]["Content-Security-Policy"]).toContain(
			`style-src 'self' '${aboutStyleHash}'`,
		);
		expect(parsedHeaders["/about/"]["Content-Security-Policy"]).toContain(
			`script-src 'self' '${aboutScriptHash}'`,
		);
		expect(parsedHeaders["/about/"]["Content-Security-Policy"]).not.toContain(rootStyleHash);
		expect(parsedHeaders["/about/"]["Content-Security-Policy"]).not.toContain(rootScriptHash);
	});

	it("should fail build when a header line exceeds maxHeaderLineLength and overflow is error", async () => {
		setIntegration({
			csp: {
				maxHeaderLineLength: 40,
				overflow: "error",
			},
		});

		configureHeaders({
			"/test": {
				"X-Long-Header": "x".repeat(100),
			},
		});

		await expect(runBuildDone()).rejects.toThrow("Header line length overflow");
		expect(writeFileSpy).not.toHaveBeenCalled();
	});

	it("should warn and keep building when a header line exceeds maxHeaderLineLength and overflow is warn", async () => {
		setIntegration({
			csp: {
				maxHeaderLineLength: 40,
				overflow: "warn",
			},
		});

		configureHeaders({
			"/test": {
				"X-Long-Header": "x".repeat(100),
			},
		});

		await runBuildDone();

		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("Header line length overflow"),
		);
		expect(writeFileSpy).toHaveBeenCalled();
	});

	it("should log an error if writing the _headers file fails", async () => {
		writeFileSpy.mockRejectedValue(new Error("fs error"));
		configureHeaders({ "X-Test": "value" });

		await runBuildDone();

		expect(logger.error).toHaveBeenCalled();
		expect(vi.mocked(logger.error).mock.calls[0][0]).toContain("Failed to write _headers file");
	});
});
