import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroConfig, AstroIntegration, AstroIntegrationLogger } from "astro";
import type {
	AstroCloudflarePagesHeadersOptions,
	AstroHeaders,
	CspAutoHashesOptions,
	HeadersFlat,
	HeadersNested,
	Routes,
} from "./types";

const NAME = "astro-cloudflare-pages-headers";
const CONTENT_SECURITY_POLICY_HEADER = "content-security-policy";
const STYLE_TAG_REGEX = /<style([^>]*)>([\s\S]*?)<\/style>/gi;
const SCRIPT_TAG_REGEX = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
const STYLE_ATTR_REGEX =
	/style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>\s]+))/gi;
const INTEGRITY_HASH_REGEX = /integrity\s*=\s*["'](sha256-[A-Za-z0-9+/]{43}=)["']/i;
const HAS_SCRIPT_SRC_REGEX = /\ssrc\s*=/i;

type ResolvedCspOptions = Required<CspAutoHashesOptions>;

interface CspHashSources {
	styleElementSources: string[];
	styleAttributeSources: string[];
	scriptElementSources: string[];
	inlineStyleHashes: number;
	styleAttributeHashes: number;
	inlineScriptHashes: number;
}

interface CspHashSets {
	styleElementHashes: Set<string>;
	styleAttributeHashes: Set<string>;
	scriptElementHashes: Set<string>;
}

interface CspHashReport {
	inlineStyleHashes: number;
	styleAttributeHashes: number;
	inlineScriptHashes: number;
	updatedCspHeaders: number;
}

interface CspRouteHashes {
	sourcesByRoute: Map<string, CspHashSources>;
	totals: CspHashSources;
}

interface CspRoute {
	route: string;
	headers: Record<string, string>;
	headerKey: string;
}

interface WildcardCspRoute extends CspRoute {
	pattern: RegExp;
	originalOrder: number;
}

interface ParsedCspDirectives {
	directives: Map<string, string>;
	order: string[];
}

const DEFAULT_CSP_OPTIONS: ResolvedCspOptions = {
	autoHashes: false,
	hashStyleElements: true,
	hashStyleAttributes: true,
	hashInlineScripts: false,
	stripUnsafeInline: true,
	mode: "global",
	maxHeaderLineLength: 2000,
	overflow: "error",
};

// Helper function to check if an object is empty.
const isEmptyObject = (obj: object): boolean => Object.keys(obj).length === 0;

function resolveCspOptions(
	options: AstroCloudflarePagesHeadersOptions,
): ResolvedCspOptions {
	const merged = {
		...DEFAULT_CSP_OPTIONS,
		...(options.csp ?? {}),
	};

	return {
		...merged,
		mode:
			merged.mode === "route" || merged.mode === "per-route"
				? "route"
				: "global",
		maxHeaderLineLength:
			Number.isFinite(merged.maxHeaderLineLength) &&
			(merged.maxHeaderLineLength ?? 0) > 0
				? Math.floor(merged.maxHeaderLineLength)
				: DEFAULT_CSP_OPTIONS.maxHeaderLineLength,
		overflow: merged.overflow === "warn" ? "warn" : "error",
	};
}

function hasEnabledHashCategory(cspOptions: ResolvedCspOptions): boolean {
	return (
		cspOptions.hashStyleElements ||
		cspOptions.hashStyleAttributes ||
		cspOptions.hashInlineScripts
	);
}

// Updated helper function to convert the provided directory into a string path.
function getBuildDir(dir: URL | string): string {
	if (typeof dir === "string") {
		return path.resolve(dir);
	}
	const filePath = fileURLToPath(dir);
	// If the resolved filePath is not under process.cwd(), treat it as relative.
	if (!filePath.startsWith(process.cwd())) {
		return path.resolve(process.cwd(), filePath.substring(1));
	}
	return filePath;
}

const hashSha256 = (value: string): string =>
	`sha256-${createHash("sha256").update(value, "utf8").digest("base64")}`;

const decodeHtmlEntities = (value: string): string =>
	value
		.replace(/&quot;|&#34;|&#x22;/gi, "\"")
		.replace(/&apos;|&#39;|&#x27;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&");

const splitCspSources = (value: string): string[] =>
	value.split(/\s+/).filter(Boolean);

function mergeCspSources(
	existingSources: string[],
	additionalSources: string[],
	{ stripUnsafeInline = false }: { stripUnsafeInline?: boolean } = {},
): string {
	const merged: string[] = [];
	const seen = new Set<string>();
	const hasAdditionalSources = additionalSources.some(Boolean);

	for (const source of existingSources) {
		if (!source) {
			continue;
		}
		if (hasAdditionalSources && source === "'none'") {
			continue;
		}
		if (stripUnsafeInline && source === "'unsafe-inline'") {
			continue;
		}
		if (!seen.has(source)) {
			seen.add(source);
			merged.push(source);
		}
	}

	for (const source of additionalSources) {
		if (!source || seen.has(source)) {
			continue;
		}
		seen.add(source);
		merged.push(source);
	}

	return merged.join(" ").trim();
}

function parseCspDirectives(csp: string): ParsedCspDirectives {
	const directives = new Map<string, string>();
	const order: string[] = [];

	for (const chunk of csp.split(";").map((value) => value.trim()).filter(Boolean)) {
		const firstSpace = chunk.indexOf(" ");
		const name = firstSpace === -1 ? chunk : chunk.slice(0, firstSpace);
		const sources = firstSpace === -1 ? "" : chunk.slice(firstSpace + 1).trim();

		if (!directives.has(name)) {
			order.push(name);
		}

		directives.set(name, sources);
	}

	return { directives, order };
}

function serializeCspDirectives(parsed: ParsedCspDirectives): string {
	const rendered: string[] = [];
	const seen = new Set<string>();

	for (const name of parsed.order) {
		if (!parsed.directives.has(name)) {
			continue;
		}

		seen.add(name);
		const value = parsed.directives.get(name);
		rendered.push(value ? `${name} ${value}` : name);
	}

	for (const [name, value] of parsed.directives.entries()) {
		if (seen.has(name)) {
			continue;
		}
		rendered.push(value ? `${name} ${value}` : name);
	}

	return rendered.join("; ");
}

function quoteAndSortHashes(hashes: Set<string>): string[] {
	return Array.from(hashes)
		.sort()
		.map((hash) => `'${hash}'`);
}

function createEmptyCspHashSets(): CspHashSets {
	return {
		styleElementHashes: new Set<string>(),
		styleAttributeHashes: new Set<string>(),
		scriptElementHashes: new Set<string>(),
	};
}

function mergeCspHashSets(target: CspHashSets, source: CspHashSets): void {
	for (const hash of source.styleElementHashes) {
		target.styleElementHashes.add(hash);
	}
	for (const hash of source.styleAttributeHashes) {
		target.styleAttributeHashes.add(hash);
	}
	for (const hash of source.scriptElementHashes) {
		target.scriptElementHashes.add(hash);
	}
}

function buildCspHashSources(hashSets: CspHashSets): CspHashSources {
	return {
		styleElementSources: quoteAndSortHashes(hashSets.styleElementHashes),
		styleAttributeSources: quoteAndSortHashes(hashSets.styleAttributeHashes),
		scriptElementSources: quoteAndSortHashes(hashSets.scriptElementHashes),
		inlineStyleHashes: hashSets.styleElementHashes.size,
		styleAttributeHashes: hashSets.styleAttributeHashes.size,
		inlineScriptHashes: hashSets.scriptElementHashes.size,
	};
}

function hasAnyCspSources(sources: CspHashSources): boolean {
	return (
		sources.styleElementSources.length > 0 ||
		sources.styleAttributeSources.length > 0 ||
		sources.scriptElementSources.length > 0
	);
}

function collectCspHashesFromHtml(
	html: string,
	cspOptions: ResolvedCspOptions,
): CspHashSets {
	const hashSets = createEmptyCspHashSets();

	if (cspOptions.hashStyleElements) {
		STYLE_TAG_REGEX.lastIndex = 0;
		for (const match of html.matchAll(STYLE_TAG_REGEX)) {
			const attrs = match[1] ?? "";
			const content = match[2] ?? "";
			const integrityHash = attrs.match(INTEGRITY_HASH_REGEX)?.[1];

			if (integrityHash) {
				hashSets.styleElementHashes.add(integrityHash);
			} else if (content.length > 0) {
				hashSets.styleElementHashes.add(hashSha256(content));
			}
		}
	}

	if (cspOptions.hashInlineScripts) {
		SCRIPT_TAG_REGEX.lastIndex = 0;
		for (const match of html.matchAll(SCRIPT_TAG_REGEX)) {
			const attrs = match[1] ?? "";
			const content = match[2] ?? "";
			const integrityHash = attrs.match(INTEGRITY_HASH_REGEX)?.[1];

			if (HAS_SCRIPT_SRC_REGEX.test(attrs)) {
				continue;
			}

			if (integrityHash) {
				hashSets.scriptElementHashes.add(integrityHash);
			} else if (content.trim()) {
				hashSets.scriptElementHashes.add(hashSha256(content));
			}
		}
	}

	if (cspOptions.hashStyleAttributes) {
		STYLE_ATTR_REGEX.lastIndex = 0;
		for (const match of html.matchAll(STYLE_ATTR_REGEX)) {
			const rawValue =
				match[1] ??
				match[2] ??
				match[3] ??
				"";

			if (!rawValue) {
				continue;
			}

			hashSets.styleAttributeHashes.add(hashSha256(rawValue));

			const decodedValue = decodeHtmlEntities(rawValue);
			if (decodedValue !== rawValue) {
				hashSets.styleAttributeHashes.add(hashSha256(decodedValue));
			}
		}
	}

	return hashSets;
}

async function collectHtmlFiles(rootDir: string): Promise<string[]> {
	const htmlFiles: string[] = [];

	const walk = async (directory: string): Promise<void> => {
		const entries = await fs.readdir(directory, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);

			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}

			if (entry.isFile() && fullPath.endsWith(".html")) {
				htmlFiles.push(fullPath);
			}
		}
	};

	await walk(rootDir);
	return htmlFiles;
}

function mapHtmlFileToRoute(buildDir: string, htmlFile: string): string {
	const relativePath = path.relative(buildDir, htmlFile)
		.split(path.sep)
		.join("/");

	if (relativePath === "index.html") {
		return "/";
	}

	if (relativePath.endsWith("/index.html")) {
		const routePath = relativePath.slice(0, -"/index.html".length);
		return `/${routePath}/`;
	}

	if (relativePath.endsWith(".html")) {
		return `/${relativePath.slice(0, -".html".length)}`;
	}

	return `/${relativePath}`;
}

async function collectCspHashesFromBuild(
	buildDir: string,
	cspOptions: ResolvedCspOptions,
): Promise<CspHashSources> {
	const mergedHashSets = createEmptyCspHashSets();
	const htmlFiles = await collectHtmlFiles(buildDir);

	for (const htmlFile of htmlFiles) {
		const html = await fs.readFile(htmlFile, "utf8");
		const fileHashSets = collectCspHashesFromHtml(html, cspOptions);
		mergeCspHashSets(mergedHashSets, fileHashSets);
	}

	return buildCspHashSources(mergedHashSets);
}

async function collectCspHashesByRouteFromBuild(
	buildDir: string,
	cspOptions: ResolvedCspOptions,
): Promise<CspRouteHashes> {
	const hashSetsByRoute = new Map<string, CspHashSets>();
	const totals = createEmptyCspHashSets();
	const htmlFiles = await collectHtmlFiles(buildDir);

	for (const htmlFile of htmlFiles) {
		const html = await fs.readFile(htmlFile, "utf8");
		const route = mapHtmlFileToRoute(buildDir, htmlFile);
		const fileHashSets = collectCspHashesFromHtml(html, cspOptions);
		const existingHashSets = hashSetsByRoute.get(route);

		if (existingHashSets) {
			mergeCspHashSets(existingHashSets, fileHashSets);
		} else {
			hashSetsByRoute.set(route, fileHashSets);
		}

		mergeCspHashSets(totals, fileHashSets);
	}

	const sourcesByRoute = new Map<string, CspHashSources>();
	for (const [route, hashSets] of hashSetsByRoute.entries()) {
		sourcesByRoute.set(route, buildCspHashSources(hashSets));
	}

	return {
		sourcesByRoute,
		totals: buildCspHashSources(totals),
	};
}

function findHeaderKey(
	headers: Record<string, string>,
	headerName: string,
): string | undefined {
	const normalizedHeaderName = headerName.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === normalizedHeaderName) {
			return key;
		}
	}
	return undefined;
}

function patchCspValue(
	rawCspValue: string,
	sources: CspHashSources,
	cspOptions: ResolvedCspOptions,
): string {
	const cspValue = rawCspValue.trim().replace(/;+\s*$/, "");
	const parsed = parseCspDirectives(cspValue);
	let changed = false;

	if (cspOptions.hashStyleElements && sources.styleElementSources.length > 0) {
		const currentStyleSources = splitCspSources(
			parsed.directives.get("style-src") ?? "'self'",
		);
		const nextStyleSources = mergeCspSources(
			currentStyleSources,
			sources.styleElementSources,
			{ stripUnsafeInline: cspOptions.stripUnsafeInline },
		);

		if (parsed.directives.get("style-src") !== nextStyleSources) {
			parsed.directives.set("style-src", nextStyleSources);
			changed = true;
		}
	}

	if (cspOptions.hashStyleAttributes && sources.styleAttributeSources.length > 0) {
		const currentStyleAttributeSources = splitCspSources(
			parsed.directives.get("style-src-attr") ?? "",
		);
		const nextStyleAttributeSources = mergeCspSources(
			currentStyleAttributeSources,
			["'unsafe-hashes'", ...sources.styleAttributeSources],
			{ stripUnsafeInline: cspOptions.stripUnsafeInline },
		);

		if (parsed.directives.get("style-src-attr") !== nextStyleAttributeSources) {
			parsed.directives.set("style-src-attr", nextStyleAttributeSources);
			changed = true;
		}
	}

	if (cspOptions.hashInlineScripts && sources.scriptElementSources.length > 0) {
		const currentScriptSources = splitCspSources(
			parsed.directives.get("script-src") ?? "'self'",
		);
		const nextScriptSources = mergeCspSources(
			currentScriptSources,
			sources.scriptElementSources,
			{ stripUnsafeInline: cspOptions.stripUnsafeInline },
		);

		if (parsed.directives.get("script-src") !== nextScriptSources) {
			parsed.directives.set("script-src", nextScriptSources);
			changed = true;
		}
	}

	if (!changed) {
		return rawCspValue;
	}

	return `${serializeCspDirectives(parsed)};`;
}

async function patchRoutesCsp(
	routes: Routes,
	buildDir: string,
	cspOptions: ResolvedCspOptions,
): Promise<CspHashReport> {
	const cspRoutes = Object.entries(routes)
		.map(([route, headers]) => {
			const headerKey = findHeaderKey(headers, CONTENT_SECURITY_POLICY_HEADER);
			if (!headerKey) {
				return undefined;
			}
			return { route, headers, headerKey };
		})
		.filter((route): route is CspRoute => Boolean(route));

	if (cspRoutes.length === 0) {
		return {
			inlineStyleHashes: 0,
			styleAttributeHashes: 0,
			inlineScriptHashes: 0,
			updatedCspHeaders: 0,
		};
	}

	if (cspOptions.mode === "route") {
		const routeHashes = await collectCspHashesByRouteFromBuild(buildDir, cspOptions);
		let updatedCspHeaders = 0;

		const exactRoutes = cspRoutes.filter(({ route }) => !route.includes("*"));
		const wildcardRoutes: WildcardCspRoute[] = cspRoutes
			.filter(({ route }) => route.includes("*"))
			.map((route, originalOrder): WildcardCspRoute => ({
				...route,
				pattern: new RegExp(
					`^${route.route
						.split("*")
						.map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
						.join(".*")}$`,
				),
				originalOrder,
			}))
			.sort((left, right) => {
				const leftSpecificity = left.route.replace(/\*/g, "").length;
				const rightSpecificity = right.route.replace(/\*/g, "").length;
				if (leftSpecificity !== rightSpecificity) {
					return rightSpecificity - leftSpecificity;
				}
				return left.originalOrder - right.originalOrder;
			});

		for (const route of exactRoutes) {
			const directSources = routeHashes.sourcesByRoute.get(route.route);
			let sources = directSources;
			if (!sources) {
				const normalizedRoute = route.route === "/" ? "/" : route.route.replace(/\/+$/, "");
				for (const [hashRoute, hashSources] of routeHashes.sourcesByRoute.entries()) {
					const normalizedHashRoute =
						hashRoute === "/" ? "/" : hashRoute.replace(/\/+$/, "");
					if (normalizedHashRoute === normalizedRoute) {
						sources = hashSources;
						break;
					}
				}
			}

			if (!sources || !hasAnyCspSources(sources)) {
				continue;
			}

			const currentValue = route.headers[route.headerKey];
			const nextValue = patchCspValue(currentValue, sources, cspOptions);
			if (nextValue !== currentValue) {
				route.headers[route.headerKey] = nextValue;
				updatedCspHeaders += 1;
			}
		}

		for (const [builtRoute, sources] of routeHashes.sourcesByRoute.entries()) {
			if (!hasAnyCspSources(sources)) {
				continue;
			}

			const normalizedBuiltRoute = builtRoute === "/" ? "/" : builtRoute.replace(/\/+$/, "");
			const existingRouteEntry = Object.entries(routes).find(([route]) => {
				if (route.includes("*")) {
					return false;
				}
				const normalizedRoute = route === "/" ? "/" : route.replace(/\/+$/, "");
				return normalizedRoute === normalizedBuiltRoute;
			});
			const existingRouteKey = existingRouteEntry?.[0];
			const existingHeaders = existingRouteKey ? routes[existingRouteKey] : undefined;
			const existingHeaderKey = existingHeaders
				? findHeaderKey(existingHeaders, CONTENT_SECURITY_POLICY_HEADER)
				: undefined;

			if (existingHeaderKey) {
				continue;
			}

			const template = wildcardRoutes.find(({ pattern }) => pattern.test(builtRoute));
			if (!template) {
				continue;
			}

			const targetRouteKey = existingRouteKey ?? builtRoute;
			const targetHeaders = existingHeaders ?? {};
			const nextValue = patchCspValue(
				template.headers[template.headerKey],
				sources,
				cspOptions,
			);

			if (nextValue === template.headers[template.headerKey]) {
				continue;
			}

			targetHeaders[template.headerKey] = nextValue;
			routes[targetRouteKey] = targetHeaders;
			updatedCspHeaders += 1;
		}

		return {
			inlineStyleHashes: routeHashes.totals.inlineStyleHashes,
			styleAttributeHashes: routeHashes.totals.styleAttributeHashes,
			inlineScriptHashes: routeHashes.totals.inlineScriptHashes,
			updatedCspHeaders,
		};
	}

	const sources = await collectCspHashesFromBuild(buildDir, cspOptions);
	let updatedCspHeaders = 0;

	for (const route of cspRoutes) {
		const currentValue = route.headers[route.headerKey];
		const nextValue = patchCspValue(currentValue, sources, cspOptions);

		if (nextValue !== currentValue) {
			route.headers[route.headerKey] = nextValue;
			updatedCspHeaders += 1;
		}
	}

	return {
		inlineStyleHashes: sources.inlineStyleHashes,
		styleAttributeHashes: sources.styleAttributeHashes,
		inlineScriptHashes: sources.inlineScriptHashes,
		updatedCspHeaders,
	};
}

function enforceHeaderLineLengthLimit(
	routes: Routes,
	cspOptions: ResolvedCspOptions,
	logger: AstroIntegrationLogger,
): void {
	const exceedingLines: { route: string; headerName: string; length: number }[] = [];

	for (const [route, headers] of Object.entries(routes)) {
		for (const [headerName, headerValue] of Object.entries(headers)) {
			const headerLine = `  ${headerName}: ${headerValue}`;
			if (headerLine.length > cspOptions.maxHeaderLineLength) {
				exceedingLines.push({
					route,
					headerName,
					length: headerLine.length,
				});
			}
		}
	}

	if (exceedingLines.length === 0) {
		return;
	}

	const [firstExceededLine] = exceedingLines;
	const message =
		`[${NAME}] Header line length overflow: ${firstExceededLine.length} characters for "${firstExceededLine.route}" -> ` +
		`"${firstExceededLine.headerName}". Max allowed is ${cspOptions.maxHeaderLineLength}. ` +
		`Found ${exceedingLines.length} overflowing line(s).`;

	if (cspOptions.overflow === "warn") {
		logger.warn(message);
		return;
	}

	throw new Error(message);
}

// Helper function to generate the _headers file content.
function generateHeadersContent(routes: Routes): string {
	const lines: string[] = [];
	for (const [route, headers] of Object.entries(routes)) {
		lines.push(route);
		for (const [headerName, headerValue] of Object.entries(headers)) {
			lines.push(`  ${headerName}: ${headerValue}`);
		}
		lines.push(""); // Add an empty line between routes.
	}
	return lines.join("\n");
}

// New helper to parse astroHeaders into a routes object.
function parseHeaders(astroHeaders: AstroHeaders): Routes {
	const sampleValue = Object.values(astroHeaders)[0];
	if (typeof sampleValue === "string") {
		return { "/*": astroHeaders as HeadersFlat };
	}
	return astroHeaders as HeadersNested;
}

function normalizeWorkersWildcardRoute(
	routes: Routes,
	workersEnabled: boolean,
	logger: AstroIntegrationLogger,
): void {
	if (!workersEnabled || !routes["*"]) {
		return;
	}

	if (routes["/*"]) {
		routes["/*"] = { ...routes["*"], ...routes["/*"] };
		logger.warn(
			`[${NAME}] Both "*" and "/*" routes were found with workers mode enabled. Merged both into "/*" and kept explicit "/*" header values on conflicts.`,
		);
	} else {
		routes["/*"] = routes["*"];
	}

	delete routes["*"];
}

// Export an integration function.
// When called, it returns an object containing hooks with a scoped astroHeaders variable.
export default function astroCloudflarePagesHeaders(
	options: AstroCloudflarePagesHeadersOptions = {},
) {
	let astroHeaders: AstroHeaders | undefined;
	const cspOptions = resolveCspOptions(options);
	const workersEnabled = options.workers === true;

	return {
		name: "astroCloudflarePagesHeaders",
		hooks: {
			"astro:config:setup": ({ config, logger }: { config: AstroConfig; logger: AstroIntegrationLogger }) => {
				logger.info(`[${NAME}] Setting up integration`);
				if (config.server?.headers) {
					astroHeaders = config.server.headers as AstroHeaders;
				}
			},
			"astro:build:done": async ({ dir, logger }: { dir: URL | string; logger: AstroIntegrationLogger }) => {
				logger.info(`[${NAME}] Running build hook`);

				if (
					!astroHeaders ||
					(typeof astroHeaders === "object" && isEmptyObject(astroHeaders))
				) {
					logger.warn(
						`[${NAME}] No headers configuration found in Astro config. Skipping _headers generation.`,
					);
					return;
				}

				const routes = parseHeaders(astroHeaders);
				normalizeWorkersWildcardRoute(routes, workersEnabled, logger);
				const buildDir = getBuildDir(dir);
				const headersFilePath = path.resolve(buildDir, "_headers");

				if (cspOptions.autoHashes) {
					if (hasEnabledHashCategory(cspOptions)) {
						try {
							const report = await patchRoutesCsp(routes, buildDir, cspOptions);
							logger.info(
								`[${NAME}] CSP auto-hash patch completed: ${report.inlineStyleHashes} inline style hashes, ${report.styleAttributeHashes} style attribute hashes, ${report.inlineScriptHashes} inline script hashes, ${report.updatedCspHeaders} updated CSP headers.`,
							);
						} catch (err) {
							logger.error(`[${NAME}] Failed to patch CSP hashes: ${err}`);
						}
					} else {
						logger.warn(
							`[${NAME}] CSP auto-hashes are enabled, but no hash categories are enabled. Skipping CSP patch.`,
						);
					}
				}

				enforceHeaderLineLengthLimit(routes, cspOptions, logger);
				const headersContent = generateHeadersContent(routes);

				try {
					await fs.writeFile(headersFilePath, headersContent, "utf-8");
					logger.info(
						`[${NAME}] Successfully created _headers at ${headersFilePath}`,
					);
				} catch (err) {
					logger.error(`[${NAME}] Failed to write _headers file: ${err}`);
				}
			},
		},
	} as unknown as AstroIntegration;
}
