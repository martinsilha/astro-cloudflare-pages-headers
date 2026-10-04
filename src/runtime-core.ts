import type { Routes } from "./types.js";

interface RouteMatch {
	route: string;
	host: string | undefined;
	pathname: string;
	captures: string[];
	names: string[];
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePart(value: string, delimiter: "." | "/"): { pattern: RegExp; names: string[] } {
	const names: string[] = [];
	let pattern = "^";
	for (let index = 0; index < value.length;) {
		if (value[index] === "*") {
			names.push("splat");
			pattern += "(.*)";
			index += 1;
			continue;
		}
		if (value[index] === ":") {
			const match = value.slice(index).match(/^:([A-Za-z]\w*)/);
			if (match) {
				names.push(match[1]);
				pattern += delimiter === "." ? "([^.]+)" : "([^/]+)";
				index += match[0].length;
				continue;
			}
		}
		pattern += escapeRegex(value[index]);
		index += 1;
	}
	pattern += "$";
	return { pattern: new RegExp(pattern, "i"), names };
}

function compileRoute(route: string): RouteMatch {
	if (/^https:\/\//i.test(route)) {
		const remainder = route.slice(route.indexOf("://") + 3);
		const slash = remainder.indexOf("/");
		const rawHost = slash === -1 ? remainder : remainder.slice(0, slash);
		const pathname = slash === -1 ? "/" : remainder.slice(slash);
		const host = compilePart(rawHost, ".");
		const path = compilePart(pathname, "/");
		return { route, host: host.pattern.source, pathname: path.pattern.source, captures: [], names: [...host.names, ...path.names] };
	}
	const path = compilePart(route === "*" ? "/*" : route, "/");
	return { route, host: undefined, pathname: path.pattern.source, captures: [], names: path.names };
}

function matchRoute(match: RouteMatch, url: URL): Map<string, string> | undefined {
	let hostCaptures: string[] = [];
	if (match.host) {
		const hostMatches = new RegExp(match.host).exec(url.hostname);
		if (!hostMatches) return undefined;
		hostCaptures = hostMatches.slice(1);
	}
	const pathMatches = new RegExp(match.pathname).exec(url.pathname);
	if (!pathMatches) return undefined;
	const values = new Map<string, string>();
	[...hostCaptures, ...pathMatches.slice(1)].forEach((value, index) => values.set(match.names[index], value));
	return values;
}

function interpolate(value: string, captures: Map<string, string>): string {
	return value.replace(/:([A-Za-z]\w*)/g, (match, name: string) => captures.get(name) ?? match);
}

function configuredHeaders(routes: Routes, url: URL): Map<string, { name: string; values: string[] }> {
	const result = new Map<string, { name: string; values: string[] }>();
	for (const [route, headers] of Object.entries(routes)) {
		const captures = matchRoute(compileRoute(route), url);
		if (!captures) continue;
		for (const [name, rawValue] of Object.entries(headers)) {
			const key = name.toLowerCase();
			const value = interpolate(rawValue, captures);
			const current = result.get(key);
			if (current) current.values.push(value);
			else result.set(key, { name, values: [value] });
		}
	}
	return result;
}

function copyResponse(response: Response): Response {
	if (response.status === 101) return response;
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: new Headers(response.headers),
	});
}

/** Apply configured values only when the application's response has no value for that name. */
export function applyConfiguredHeaders(response: Response, routes: Routes, url: URL): Response {
	const merged = configuredHeaders(routes, url);
	if (merged.size === 0 || response.status === 101) return response;
	const result = copyResponse(response);
	for (const [key, entry] of merged) {
		if (result.headers.has(key)) continue;
		if (key === "set-cookie") {
			for (const value of entry.values) result.headers.append(entry.name, value);
		} else {
			result.headers.set(entry.name, entry.values.join(", "));
		}
	}
	return result;
}
