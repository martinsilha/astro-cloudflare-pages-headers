import type { AstroHeaders, Routes } from "./types.js";

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PLACEHOLDER = /:([A-Za-z]\w*)/g;

export function validateRoute(route: string): void {
	if (route === "*") return;
	if (route.includes("\r") || route.includes("\n") || route.includes("?") || route.includes("#")) {
		throw new Error(`Invalid header route ${JSON.stringify(route)}: query strings, fragments, and line breaks are not supported.`);
	}

	if (/^https?:\/\//i.test(route)) {
		let parsed: URL;
		try {
			parsed = new URL(route.replace(PLACEHOLDER, (_match, name: string) => `codex-${name}`));
		} catch {
			throw new Error(`Invalid header route ${JSON.stringify(route)}.`);
		}
		if (parsed.protocol !== "https:") {
			throw new Error(`Host-qualified header routes must use HTTPS: ${JSON.stringify(route)}.`);
		}
		const authority = route.slice(route.indexOf("://") + 3).split("/")[0];
		const closingBracket = authority.startsWith("[") ? authority.indexOf("]") : -1;
		const explicitPort = closingBracket === -1 ? /:\d*$/.test(authority) : authority.slice(closingBracket + 1).startsWith(":");
		if (explicitPort || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
			throw new Error(`Host-qualified header routes cannot include a port, credentials, query, or fragment: ${JSON.stringify(route)}.`);
		}
	} else if (!route.startsWith("/")) {
		throw new Error(`Header routes must begin with "/" or use an HTTPS host: ${JSON.stringify(route)}.`);
	}

	if ((route.match(/\*/g) ?? []).length > 1) {
		throw new Error(`Header route ${JSON.stringify(route)} may contain only one wildcard.`);
	}
	const names = Array.from(route.matchAll(PLACEHOLDER), (match) => match[1]);
	if (new Set(names).size !== names.length) {
		throw new Error(`Header route ${JSON.stringify(route)} repeats a named placeholder.`);
	}
	if (/^https:\/\//i.test(route) && route.includes("*")) {
		const hostStart = route.indexOf("://") + 3;
		const pathStart = route.indexOf("/", hostStart);
		const firstWildcard = route.indexOf("*");
		if (pathStart === -1 || firstWildcard < pathStart) {
			throw new Error(`Header route wildcards may only appear in the URL path: ${JSON.stringify(route)}.`);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRouteHeaders(route: string, value: unknown): Record<string, string> {
	validateRoute(route);
	if (!isRecord(value)) {
		throw new Error(`Headers for route ${JSON.stringify(route)} must be an object of string values.`);
	}
	const result: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(value)) {
		if (!HEADER_NAME.test(name)) {
			throw new Error(`Invalid HTTP header name ${JSON.stringify(name)} for ${JSON.stringify(route)}.`);
		}
		if (typeof headerValue !== "string") {
			throw new Error(`HTTP header ${JSON.stringify(name)} for ${JSON.stringify(route)} must have a string value.`);
		}
		if (/[\r\n]/.test(headerValue)) {
			throw new Error(`HTTP header ${JSON.stringify(name)} for ${JSON.stringify(route)} cannot contain a line break.`);
		}
		result[name] = headerValue;
	}
	return result;
}

function mergeHeaderMaps(
	left: Record<string, string>,
	right: Record<string, string>,
): Record<string, string> {
	const merged = { ...left };
	const keyByLowercase = new Map(Object.keys(merged).map((name) => [name.toLowerCase(), name]));
	for (const [name, value] of Object.entries(right)) {
		const oldKey = keyByLowercase.get(name.toLowerCase());
		if (oldKey) delete merged[oldKey];
		merged[name] = value;
		keyByLowercase.set(name.toLowerCase(), name);
	}
	return merged;
}

/** Clone, validate, and normalize flat/nested options. */
export function normalizeHeaders(input: unknown): Routes {
	if (!isRecord(input)) throw new Error("The headers option must be an object.");
	const entries = Object.entries(input);
	if (entries.length === 0) return {};
	const firstIsFlat = typeof entries[0][1] === "string";
	if (!entries.every(([, value]) => (typeof value === "string") === firstIsFlat)) {
		throw new Error("The headers option cannot mix flat header values and nested route maps.");
	}

	const routes: Routes = {};
	if (firstIsFlat) {
		routes["/*"] = normalizeRouteHeaders("/*", input as AstroHeaders);
	} else {
		for (const [route, value] of entries) {
			routes[route] = normalizeRouteHeaders(route, value);
		}
	}

	if (routes["*"]) {
		if (routes["/*"]) {
			routes["/*"] = mergeHeaderMaps(routes["*"], routes["/*"]);
		} else {
			routes["/*"] = routes["*"];
		}
		delete routes["*"];
	}
	return routes;
}
