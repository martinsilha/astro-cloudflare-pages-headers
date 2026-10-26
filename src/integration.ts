import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroConfig, AstroIntegration, AstroIntegrationLogger } from "astro";
import { normalizeHeaders } from "./headers-config.js";
import { countHeaderRules, extractHeaderFields, mergeHeadersFile, type HeaderField } from "./headers-file.js";
import { resolveCloudflareVersion, resolveGeneratedAssets, toPath } from "./output-path.js";
import type {
	AstroCloudflarePagesHeadersOptions,
	CspAutoHashesOptions,
	Routes,
} from "./types.js";

const NAME = "astro-cloudflare-pages-headers";
const INTEGRATION_NAME = "astroCloudflarePagesHeaders";
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

interface ParsedCspDirectives {
	directives: Map<string, string>;
	directiveNames: Map<string, string>;
	order: string[];
}

const DEFAULT_CSP_OPTIONS: ResolvedCspOptions = {
	autoHashes: false,
	hashStyleElements: true,
	hashStyleAttributes: true,
	hashInlineScripts: true,
	stripUnsafeInline: true,
	mode: "route",
	maxHeaderLineLength: 2000,
	overflow: "error",
};

function resolveCspOptions(
	options: AstroCloudflarePagesHeadersOptions,
): ResolvedCspOptions {
	const merged = {
		...DEFAULT_CSP_OPTIONS,
		...(options.csp ?? {}),
	};

	return {
		...merged,
		mode: merged.mode === "route" ? "route" : "global",
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
	const directiveNames = new Map<string, string>();
	const order: string[] = [];

	for (const chunk of csp.split(";").map((value) => value.trim()).filter(Boolean)) {
		const firstSpace = chunk.indexOf(" ");
		const name = firstSpace === -1 ? chunk : chunk.slice(0, firstSpace);
		const key = name.toLowerCase();
		const sources = firstSpace === -1 ? "" : chunk.slice(firstSpace + 1).trim();

		// CSP directive names are ASCII case-insensitive. Keep the first spelling
		// and value, matching the browser's handling of duplicate directives.
		if (directives.has(key)) continue;
		order.push(key);
		directiveNames.set(key, name);
		directives.set(key, sources);
	}

	return { directives, directiveNames, order };
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
		const directiveName = parsed.directiveNames.get(name) ?? name;
		rendered.push(value ? `${directiveName} ${value}` : directiveName);
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
		let entries;
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			throw new Error(`[${NAME}] Could not scan generated HTML directory ${directory} for CSP hashes.`, { cause: error });
		}

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

interface CspRouteMapping {
	base: string;
	htmlHandling?: string;
	notFoundHandling?: string;
	pagesHosting?: boolean;
	spaFallback?: boolean;
}

function mapHtmlFileToRoute(buildDir: string, htmlFile: string, mapping: CspRouteMapping): string {
	const relativePath = path.relative(buildDir, htmlFile)
		.split(path.sep)
		.join("/");
	const handling = mapping.htmlHandling ?? "auto-trailing-slash";
	let route: string;

	if (handling === "none") {
		route = `/${relativePath}`;
	} else if (relativePath === "index.html") {
		route = "/";
	} else if (relativePath.endsWith("/index.html")) {
		const routePath = relativePath.slice(0, -"/index.html".length);
		route = `/${routePath}${handling === "drop-trailing-slash" ? "" : "/"}`;
	} else if (relativePath.endsWith(".html")) {
		const routePath = `/${relativePath.slice(0, -".html".length)}`;
		route = handling === "force-trailing-slash" ? `${routePath}/` : routePath;
	} else {
		route = `/${relativePath}`;
	}

	const base = mapping.base.replace(/^\/+|\/+$/g, "");
	if (base) {
		const basePath = `/${base}`;
		if (route !== basePath && !route.startsWith(`${basePath}/`)) {
			route = route === "/" ? `${basePath}/` : `${basePath}${route}`;
		}
	}
	if (handling === "force-trailing-slash" && route !== "/" && !route.endsWith("/")) route += "/";
	if (handling === "drop-trailing-slash" && route !== "/") route = route.replace(/\/+$/, "");
	return route;
}

function hasUniversalRouteConflict(headers: unknown): boolean {
	return typeof headers === "object" && headers !== null && !Array.isArray(headers) &&
		Object.hasOwn(headers, "*") && Object.hasOwn(headers, "/*");
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

function patchDirectiveSources(
	parsed: ParsedCspDirectives,
	directiveName: string,
	additionalSources: string[],
	cspOptions: ResolvedCspOptions,
	{
		defaultSources,
	}: {
		defaultSources?: string;
	} = {},
): boolean {
	const existingSources = parsed.directives.get(directiveName);
	const fallback = existingSources ?? defaultSources ?? parsed.directives.get("default-src");
	if (existingSources === undefined && fallback === undefined) {
		return false;
	}
	const currentSources = splitCspSources(fallback ?? "");
	const nextSources = mergeCspSources(currentSources, additionalSources, {
		stripUnsafeInline: cspOptions.stripUnsafeInline,
	});

	if (parsed.directives.get(directiveName) !== nextSources) {
		parsed.directives.set(directiveName, nextSources);
		return true;
	}

	return false;
}

function patchSingleCspPolicy(
	rawCspValue: string,
	sources: CspHashSources,
	cspOptions: ResolvedCspOptions,
): string {
	const cspValue = rawCspValue.trim().replace(/;+\s*$/, "");
	const parsed = parseCspDirectives(cspValue);
	let changed = false;

	if (cspOptions.hashStyleElements && sources.styleElementSources.length > 0) {
		changed =
			patchDirectiveSources(
				parsed,
				"style-src",
				sources.styleElementSources,
				cspOptions,
			) || changed;

		if (parsed.directives.has("style-src-elem")) {
			changed =
				patchDirectiveSources(
					parsed,
					"style-src-elem",
					sources.styleElementSources,
					cspOptions,
					{ defaultSources: parsed.directives.get("style-src") },
				) || changed;
		}
	}

	if (cspOptions.hashStyleAttributes && sources.styleAttributeSources.length > 0) {
		changed =
			patchDirectiveSources(
				parsed,
				"style-src-attr",
				["'unsafe-hashes'", ...sources.styleAttributeSources],
				cspOptions,
				{ defaultSources: parsed.directives.get("style-src") },
			) || changed;
	}

	if (cspOptions.hashInlineScripts && sources.scriptElementSources.length > 0) {
		changed =
			patchDirectiveSources(
				parsed,
				"script-src",
				sources.scriptElementSources,
				cspOptions,
			) || changed;

		if (parsed.directives.has("script-src-elem")) {
			changed =
				patchDirectiveSources(
					parsed,
					"script-src-elem",
					sources.scriptElementSources,
					cspOptions,
					{ defaultSources: parsed.directives.get("script-src") },
				) || changed;
		}
	}

	if (!changed) {
		return rawCspValue;
	}

	return `${serializeCspDirectives(parsed)};`;
}

function patchCspValue(
	rawCspValue: string,
	sources: CspHashSources,
	cspOptions: ResolvedCspOptions,
): string {
	const policies = rawCspValue.split(/,\s*(?=[a-z][a-z0-9-]*\s)/i);
	return policies
		.map((policy) => patchSingleCspPolicy(policy, sources, cspOptions))
		.join(", ");
}

function canonicalRoute(route: string): string {
	const pathname = /^https:\/\//i.test(route)
		? new URL(route.replace(/:([A-Za-z]\w*)/g, "codex-$1")).pathname
		: route;
	return pathname.length > 1 ? pathname.replace(/\/+$/, "") : "/";
}

function pathRouteMatch(route: string, pathname: string): Map<string, string> | undefined {
	const routePath = canonicalRoute(route);
	const names: string[] = [];
	let source = "^";
	for (let index = 0; index < routePath.length;) {
		if (routePath[index] === "*") {
			names.push("splat");
			source += "(.*)";
			index += 1;
			continue;
		}
		if (routePath[index] === ":") {
			const placeholder = routePath.slice(index).match(/^:([A-Za-z]\w*)/);
			if (placeholder) {
				names.push(placeholder[1]);
				source += "([^/]+)";
				index += placeholder[0].length;
				continue;
			}
		}
		source += routePath[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		index += 1;
	}
	const match = new RegExp(`${source}$`).exec(canonicalRoute(pathname));
	if (!match) return undefined;
	return new Map(names.map((name, index) => [name, match[index + 1]]));
}

function resolveHeadersForPath(
	routes: Routes,
	pathname: string,
	preservedFields: HeaderField[] = [],
): Record<string, string> {
	const values = new Map<string, { name: string; values: string[] }>();
	const addValue = (name: string, value: string, captures: Map<string, string>, removal = false): void => {
		const key = name.toLowerCase();
		if (removal) {
			values.delete(key);
			return;
		}
		const resolved = value.replace(/:([A-Za-z]\w*)/g, (match, placeholder: string) => captures.get(placeholder) ?? match);
		const entry = values.get(key);
		if (entry) {
			entry.name = name;
			entry.values.push(resolved);
		} else values.set(key, { name, values: [resolved] });
	};
	for (const field of preservedFields) {
		const captures = pathRouteMatch(field.route, pathname);
		if (!captures) continue;
		if (/^https:\/\//i.test(field.route)) {
			throw new Error("[astro-cloudflare-pages-headers] Cannot safely expand CSP for " + JSON.stringify(pathname) + " because preserved host-qualified headers also match.");
		}
		addValue(field.name, field.value, captures, field.removal);
	}
	for (const [route, headers] of Object.entries(routes)) {
		if (/^https:\/\//i.test(route)) {
			if (pathRouteMatch(route, pathname)) {
				throw new Error("[astro-cloudflare-pages-headers] Cannot safely expand CSP for " + JSON.stringify(pathname) + " because host-qualified headers also match.");
			}
			continue;
		}
		const captures = pathRouteMatch(route, pathname);
		if (!captures) continue;
		for (const [name, value] of Object.entries(headers)) addValue(name, value, captures);
	}
	return Object.fromEntries(Array.from(values.values(), ({ name, values: headerValues }) => [name, headerValues.join(", ")]));
}

function removeMatchingExactRoute(routes: Routes, route: string): void {
	const canonical = canonicalRoute(route);
	const match = Object.keys(routes).find((candidate) => !candidate.includes("*") && !/^https:\/\//i.test(candidate) && canonicalRoute(candidate) === canonical);
	if (!match) return;
	delete routes[match];
}

async function patchRoutesCsp(
	routes: Routes,
	buildDir: string,
	cspOptions: ResolvedCspOptions,
	mapping: CspRouteMapping,
	preservedSources: string[],
): Promise<CspHashReport> {
	const cspRoutes = Object.entries(routes)
		.map(([route, headers]) => {
			const headerKey = findHeaderKey(headers, CONTENT_SECURITY_POLICY_HEADER);
			return headerKey ? { route, headers, headerKey } : undefined;
		})
		.filter((route): route is CspRoute => Boolean(route));
	if (cspRoutes.length === 0) {
		return { inlineStyleHashes: 0, styleAttributeHashes: 0, inlineScriptHashes: 0, updatedCspHeaders: 0 };
	}

	const routeHashes = await collectCspRouteHashes(buildDir, cspOptions, mapping);
	let updatedCspHeaders = 0;
	if (cspOptions.mode === "global") {
		for (const route of cspRoutes) {
			const current = route.headers[route.headerKey];
			const next = patchCspValue(current, routeHashes.totals, cspOptions);
			if (next !== current) {
				route.headers[route.headerKey] = next;
				updatedCspHeaders += 1;
			}
		}
		return { ...routeHashes.totals, updatedCspHeaders };
	}
	const originalRoutes = structuredClone(routes) as Routes;
	const outputRoutes = structuredClone(routes) as Routes;
	const preservedContent = mergeHeadersFile(preservedSources, {});
	const preservedFields = extractHeaderFields(preservedContent ? [preservedContent] : []);
	for (const [builtRoute, sources] of routeHashes.sourcesByRoute) {
		const matchingPolicies = cspRoutes.filter(({ route }) => pathRouteMatch(route, builtRoute) !== undefined);
		if (matchingPolicies.length === 0) continue;
		const patchedPolicies = matchingPolicies.map(({ headers, headerKey }) =>
			patchCspValue(headers[headerKey], sources, cspOptions),
		);
		const changed = matchingPolicies.some(({ headers, headerKey }, index) => patchedPolicies[index] !== headers[headerKey]);
		if (!changed) continue;

		const effectiveHeaders = resolveHeadersForPath(originalRoutes, builtRoute, preservedFields);
		removeMatchingExactRoute(outputRoutes, builtRoute);
		const targetRoute = builtRoute;
		const override: Record<string, string> = {};
		for (const [name, value] of Object.entries(effectiveHeaders)) {
			if (name.toLowerCase() === CONTENT_SECURITY_POLICY_HEADER) continue;
			override[`! ${name}`] = "";
			override[name] = value;
		}
		override[`! ${CONTENT_SECURITY_POLICY_HEADER}`] = "";
		override[matchingPolicies[0].headerKey] = patchedPolicies.join(", ");
		outputRoutes[targetRoute] = override;
		updatedCspHeaders += 1;
	}
	for (const key of Object.keys(routes)) delete routes[key];
	Object.assign(routes, outputRoutes);
	return { ...routeHashes.totals, updatedCspHeaders };
}

async function collectCspRouteHashes(
	buildDir: string,
	cspOptions: ResolvedCspOptions,
	mapping: CspRouteMapping,
): Promise<CspRouteHashes> {
	const hashSetsByRoute = new Map<string, CspHashSets>();
	const totals = createEmptyCspHashSets();
	const htmlFiles = await collectHtmlFiles(buildDir);
	const htmlByFile = new Map<string, { html: string; hashes: CspHashSets }>();
	for (const htmlFile of htmlFiles) {
		let html: string;
		try {
			html = await fs.readFile(htmlFile, "utf8");
		} catch (error) {
			throw new Error(`[${NAME}] Could not read generated HTML at ${htmlFile} while collecting CSP hashes.`, { cause: error });
		}
		const hashes = collectCspHashesFromHtml(html, cspOptions);
		htmlByFile.set(htmlFile, { html, hashes });
		mergeCspHashSets(totals, hashes);
	}
	const totalSources = buildCspHashSources(totals);
	const hasAnyHashes = totalSources.inlineScriptHashes + totalSources.inlineStyleHashes + totalSources.styleAttributeHashes > 0;
	if (cspOptions.mode === "route" && hasAnyHashes && (mapping.notFoundHandling === "single-page-application" || mapping.spaFallback)) {
		throw new Error(`[${NAME}] Route-mode CSP auto-hashing cannot cover an SPA fallback served at arbitrary paths. Use csp.mode: "global" or disable auto-hashing.`);
	}
	if (cspOptions.mode === "route" && (mapping.notFoundHandling === "404-page" || mapping.pagesHosting === true)) {
		const fallbackHasHashes = Array.from(htmlByFile.entries()).some(([file, entry]) => {
			const relativePath = path.relative(buildDir, file).split(path.sep).join("/").toLowerCase();
			const is404 = relativePath === "404.html" || relativePath === "404/index.html";
			const sources = buildCspHashSources(entry.hashes);
			return is404 && sources.inlineScriptHashes + sources.inlineStyleHashes + sources.styleAttributeHashes > 0;
		});
		if (fallbackHasHashes) {
			throw new Error(`[${NAME}] Route-mode CSP auto-hashing cannot cover a 404 fallback served for arbitrary paths. Use csp.mode: "global" or disable auto-hashing.`);
		}
	}
	for (const [htmlFile, { hashes }] of htmlByFile) {
		const route = mapHtmlFileToRoute(buildDir, htmlFile, mapping);
		const existing = hashSetsByRoute.get(route);
		if (existing) mergeCspHashSets(existing, hashes);
		else hashSetsByRoute.set(route, hashes);
	}
	const sourcesByRoute = new Map<string, CspHashSources>();
	for (const [route, hashes] of hashSetsByRoute) sourcesByRoute.set(route, buildCspHashSources(hashes));
	return { sourcesByRoute, totals: buildCspHashSources(totals) };
}

function enforceHeaderLineLengthLimit(
	routes: Routes,
	cspOptions: ResolvedCspOptions,
	logger: AstroIntegrationLogger,
): void {
	const exceedingLines: { route: string; headerName: string; length: number }[] = [];

	for (const [route, headers] of Object.entries(routes)) {
		for (const [headerName, headerValue] of Object.entries(headers)) {
			const headerLine = headerName.startsWith("! ") ? `  ${headerName}` : `  ${headerName}: ${headerValue}`;
			if (headerLine.length > Math.min(2000, cspOptions.maxHeaderLineLength)) {
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
		`"${firstExceededLine.headerName}". Max allowed is ${Math.min(2000, cspOptions.maxHeaderLineLength).toLocaleString("en-US")} characters. ` +
		`Found ${exceedingLines.length} overflowing line(s).`;

	if (cspOptions.overflow === "warn") {
		logger.warn(message);
		return;
	}

	throw new Error(message);
}

// Helper function to generate the _headers file content.
async function readHeadersFile(filename: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filename, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeHeadersFile(filename: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filename), { recursive: true });
	const temporaryPath = `${filename}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporaryPath, content, "utf8");
		await fs.rename(temporaryPath, filename);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
}

async function hasSpaFallbackRedirect(assetsDirectory: string): Promise<boolean> {
	const filename = path.join(assetsDirectory, "_redirects");
	let contents: string;
	try {
		contents = await fs.readFile(filename, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error(`[${NAME}] Could not read Cloudflare redirects at ${filename} while checking CSP fallback coverage.`, { cause: error });
	}
	return contents.split(/\r?\n/).some((line) => {
		const normalized = line.trim();
		if (!normalized || normalized.startsWith("#")) return false;
		const [source, destination, status] = normalized.split(/\s+/);
		return source === "/*" && destination?.startsWith("/") && status === "200";
	});
}


async function validatePreservedCspPolicies(
	routes: Routes,
	sources: string[],
	buildDir: string,
	mapping: CspRouteMapping,
): Promise<void> {
	const configuredPolicies = Object.entries(routes)
		.filter(([, headers]) => findHeaderKey(headers, CONTENT_SECURITY_POLICY_HEADER));
	if (configuredPolicies.length === 0) return;
	const preservedPolicies = extractHeaderFields(sources)
		.filter((field) => !field.removal && field.name.toLowerCase() === CONTENT_SECURITY_POLICY_HEADER);
	if (preservedPolicies.length === 0) return;
	for (const htmlFile of await collectHtmlFiles(buildDir)) {
		const pageRoute = mapHtmlFileToRoute(buildDir, htmlFile, mapping);
		const configuredMatches = configuredPolicies.some(([route]) => pathRouteMatch(route, pageRoute));
		if (!configuredMatches) continue;
		const preserved = preservedPolicies.find((field) => pathRouteMatch(field.route, pageRoute));
		if (preserved) {
			throw new Error(`[${NAME}] A preserved _headers CSP policy on ${JSON.stringify(preserved.route)} also matches generated HTML at ${JSON.stringify(pageRoute)} and cannot be safely expanded. Move the policy to the integration headers option or use csp.mode: "global" after reconciling duplicate rules.`);
		}
	}
}

function countRulesWithGenerated(content: string): number {
	return countHeaderRules(content);
}

function cacheControlKey(headers: Record<string, string>): string | undefined {
	return findHeaderKey(headers, "cache-control");
}

function assetPatternFor(config: AstroConfig): string {
	const base = config.base.replace(/^\/+|\/+$/g, "");
	const assets = config.build.assets || "_astro";
	return `/${[base, assets.replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/")}/*`;
}

function validateCacheControlRules(
	routes: Routes,
	sources: string[],
	assetsPattern: string,
	adapterName: string | undefined,
): void {
	if (adapterName !== "@astrojs/cloudflare") return;
	const assetDirectory = assetsPattern.slice(0, -1);
	const samples = ["probe", "probe.css", "probe.js", "font.woff2"].map((name) => `${assetDirectory}${name}`);
	const matchingCount = (route: string): number => samples.filter((sample) => pathRouteMatch(route, sample) !== undefined).length;
	const configured = Object.entries(routes).flatMap(([route, headers]) => {
		const name = cacheControlKey(headers);
		return name ? [{ route, value: headers[name], origin: "configuration" as const }] : [];
	});
	const preserved = extractHeaderFields(sources)
		.filter((field) => !field.removal && field.name.toLowerCase() === "cache-control")
		.map((field) => ({ route: field.route, value: field.value, origin: "existing _headers" as const }));
	const all = [...configured, ...preserved];
	for (const field of all) {
		const count = matchingCount(field.route);
		if (count > 0 && count < samples.length) {
			throw new Error(`[${NAME}] Cache-Control rule ${JSON.stringify(field.route)} overlaps only part of the generated asset directory ${JSON.stringify(assetsPattern)}. Use a rule that covers the complete asset pattern or reconcile the existing rule.`);
		}
	}
	for (const sample of samples) {
		const configuredValues = new Set(configured.filter((field) => pathRouteMatch(field.route, sample)).map((field) => field.value));
		const preservedValues = new Set(preserved.filter((field) => pathRouteMatch(field.route, sample)).map((field) => field.value));
		if (configuredValues.size > 1 && !Object.keys(routes).some((route) => route === assetsPattern && cacheControlKey(routes[route]))) {
			throw new Error(`[${NAME}] Overlapping configured Cache-Control rules produce conflicting values for ${JSON.stringify(sample)}. Add a complete ${JSON.stringify(assetsPattern)} rule to define the asset value.`);
		}
		if (configuredValues.size > 0 && Array.from(preservedValues).some((value) => !configuredValues.has(value))) {
			throw new Error(`[${NAME}] A preserved _headers Cache-Control rule conflicts with the configured asset value for ${JSON.stringify(sample)}. Reconcile the existing rule before building.`);
		}
	}

	const exactRoute = Object.keys(routes).find((route) => route === assetsPattern);
	const exactHeaders = exactRoute ? routes[exactRoute] : undefined;
	const exactKey = exactHeaders ? cacheControlKey(exactHeaders) : undefined;
	const exactValue = exactHeaders && exactKey ? exactHeaders[exactKey] : undefined;
	if (exactRoute && exactHeaders && exactKey && exactValue !== undefined) {
		const otherConfiguredValues = configured
			.filter((field) => field.route !== exactRoute && matchingCount(field.route) === samples.length)
			.map((field) => field.value);
		if (otherConfiguredValues.length > 0) {
			const nextHeaders: Record<string, string> = {};
			for (const [name, value] of Object.entries(exactHeaders)) {
				if (name.toLowerCase() !== "cache-control") nextHeaders[name] = value;
			}
			nextHeaders[`! ${exactKey}`] = "";
			nextHeaders[exactKey] = exactValue;
			routes[exactRoute] = nextHeaders;
		}
	}
}

export default function astroCloudflarePagesHeaders(
	options: AstroCloudflarePagesHeadersOptions = {},
): AstroIntegration {
	const cspOptions = resolveCspOptions(options);
	let projectConfig: AstroConfig | undefined;
	let configuredRoutes: Routes = {};
	let runtimeEnabled = false;
	let runtimeConfigJson = JSON.stringify({ enabled: false, routes: {} });
	let adapterName: string | undefined;
	let adapterVersion: number | undefined;
	let originalClientDir: string | undefined;
	let outputLogger: AstroIntegrationLogger | undefined;

	const runtimePlugin = {
		name: `${NAME}:runtime-config`,
		config() {
			return { define: { __ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__: runtimeConfigJson } };
		},
	};

	const emitHeaders = async (renderedDir: URL | string, phase: "generated" | "done"): Promise<void> => {
		if (!projectConfig || !outputLogger) return;
		const htmlDir = toPath(renderedDir);
		const assets = await resolveGeneratedAssets(projectConfig, htmlDir, {
			explicitDirectory: options.assetsDirectory,
			adapterName,
			adapterVersion,
			originalClientDir,
		});
		const routes = structuredClone(configuredRoutes) as Routes;
		if (options.workers === true) outputLogger.warn(`[${NAME}] The workers option is deprecated; wildcard routes are normalized automatically.`);

		const targetPaths = new Set([path.resolve(assets.directory)]);
		if (phase === "generated" && htmlDir !== path.resolve(assets.directory)) targetPaths.add(htmlDir);

		const sources: string[] = [];
		const sourcePaths = new Set([...targetPaths, htmlDir]);
		if (projectConfig.publicDir) sourcePaths.add(toPath(projectConfig.publicDir));
		const clientDirectory = originalClientDir ?? (projectConfig.build.client ? toPath(projectConfig.build.client) : undefined);
		if (clientDirectory) sourcePaths.add(clientDirectory);
		for (const target of sourcePaths) {
			const filename = path.join(target, "_headers");
			let current: string | undefined;
			try {
				current = await readHeadersFile(filename);
			} catch (error) {
				throw new Error(`[${NAME}] Could not read existing _headers file at ${filename}.`, { cause: error });
			}
			if (current !== undefined) sources.push(current);
		}
		const mapping: CspRouteMapping = {
			base: projectConfig.base,
			htmlHandling: assets.htmlHandling,
			notFoundHandling: assets.notFoundHandling,
			pagesHosting: adapterName !== "@astrojs/cloudflare",
			spaFallback: assets.notFoundHandling === "single-page-application" || await hasSpaFallbackRedirect(assets.directory),
		};
		if (Object.keys(routes).length > 0 && cspOptions.autoHashes && hasEnabledHashCategory(cspOptions)) {
			await validatePreservedCspPolicies(routes, sources, htmlDir, mapping);
			const report = await patchRoutesCsp(routes, htmlDir, cspOptions, mapping, sources);
			outputLogger.info(`[${NAME}] CSP auto-hash patch completed: ${report.inlineStyleHashes} inline style hashes, ${report.styleAttributeHashes} style attribute hashes, ${report.inlineScriptHashes} inline script hashes, ${report.updatedCspHeaders} updated CSP headers.`);
		} else if (cspOptions.autoHashes) {
			outputLogger.warn(`[${NAME}] CSP auto-hashes are enabled, but no hash categories are enabled. Skipping CSP patch.`);
		}
		enforceHeaderLineLengthLimit(routes, cspOptions, outputLogger);
		validateCacheControlRules(routes, sources, assetPatternFor(projectConfig), adapterName);
		const content = mergeHeadersFile(sources, routes);
		const lines = content.split("\n");
		const tooLong = lines.find((line) => line.length > Math.min(2000, cspOptions.maxHeaderLineLength));
		const rulesCount = countRulesWithGenerated(content);
		if (tooLong || rulesCount > 100) {
			const message = tooLong
				? `[${NAME}] Header line length overflow: ${tooLong.length} characters. Cloudflare allows at most 2,000 characters per line.`
				: `[${NAME}] Header rule count overflow: ${rulesCount} rules. Cloudflare allows at most 100 rules.`;
			if (cspOptions.overflow === "warn") outputLogger.warn(message);
			else throw new Error(message);
		}
		if (Object.keys(routes).length === 0 && sources.length === 0) return;
		for (const target of targetPaths) {
			const filename = path.join(target, "_headers");
			try {
				if (content.trim().length === 0) await fs.rm(filename, { force: true });
				else await writeHeadersFile(filename, content);
			} catch (error) {
				throw new Error(`[${NAME}] Could not write finalized _headers file at ${filename}.`, { cause: error });
			}
		}
		outputLogger.info(`[${NAME}] Wrote _headers during ${phase} phase to ${assets.directory}`);
	};

	return {
		name: INTEGRATION_NAME,
		hooks: {
			"astro:config:setup": ({ config, updateConfig, addMiddleware, logger }) => {
				projectConfig = config;
				outputLogger = logger;
				adapterName = config.adapter?.name;
				if (adapterName === "@astrojs/cloudflare") {
					adapterVersion = resolveCloudflareVersion(config.root, "@astrojs/cloudflare");
					if (config.build.client) originalClientDir = toPath(config.build.client);
				}
				updateConfig({ vite: { plugins: [runtimePlugin] } });
				if (options.runtime !== false) {
					const runtimeFile = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./runtime.ts" : "./runtime.js", import.meta.url));
					addMiddleware({ entrypoint: runtimeFile, order: "pre" });
				}
			},
			"astro:config:done": ({ config, logger }) => {
				projectConfig = config;
				outputLogger = logger;
				adapterName = config.adapter?.name;
				if (adapterName === "@astrojs/cloudflare" && adapterVersion === undefined) adapterVersion = resolveCloudflareVersion(config.root, "@astrojs/cloudflare");
				const legacyHeaders = config.server?.headers;
				const headerSource = options.headers !== undefined ? options.headers : legacyHeaders ?? {};
				if (hasUniversalRouteConflict(headerSource)) logger.warn(`[${NAME}] Both "*" and "/*" are configured; their values are merged case-insensitively and explicit "/*" values win.`);
				configuredRoutes = normalizeHeaders(headerSource);
				runtimeEnabled = options.runtime === true || (options.runtime !== false && adapterName === "@astrojs/cloudflare");
			runtimeConfigJson = JSON.stringify({ enabled: runtimeEnabled, routes: configuredRoutes });
				const security = "security" in config ? config.security : undefined;
				const nativeCsp = typeof security === "object" && security !== null && "csp" in security && security.csp;
				if (nativeCsp && Object.values(configuredRoutes).some((headers) => findHeaderKey(headers, CONTENT_SECURITY_POLICY_HEADER))) {
					logger.warn(`[${NAME}] Astro native CSP and integration Content-Security-Policy headers are both configured. The browser enforces both policies; choose one owner for script and style policy.`);
				}
			},
			"astro:build:generated": async ({ dir, logger }) => {
				outputLogger = logger;
				await emitHeaders(dir, "generated");
			},
			"astro:build:done": async ({ dir, logger }) => {
				outputLogger = logger;
				if (Object.keys(configuredRoutes).length === 0) {
					logger.warn(`[${NAME}] No headers configuration found in Astro config. Skipping _headers generation.`);
				}
				await emitHeaders(dir, "done");
			},
		},
	};
}
