import type { Routes } from "./types.js";

const OWNER_BEGIN = "# BEGIN astro-cloudflare-pages-headers";
const OWNER_END = "# END astro-cloudflare-pages-headers";

interface HeaderRule {
	pattern: string;
	lines: string[];
}

interface ParsedHeaderFile {
	preamble: string[];
	rules: HeaderRule[];
}

function parseHeaderFile(source: string): ParsedHeaderFile {
	const preamble: string[] = [];
	const rules: HeaderRule[] = [];
	let current: HeaderRule | undefined;
	let owned = false;
	let markerStartLine = 0;
	for (const [index, line] of source.replace(/\r\n?/g, "\n").split("\n").entries()) {
		const trimmed = line.trim();
		if (trimmed === OWNER_BEGIN) {
			if (owned) throw new Error(`Malformed _headers file: nested generated marker at line ${index + 1}.`);
			owned = true;
			markerStartLine = index + 1;
			continue;
		}
		if (trimmed === OWNER_END) {
			if (!owned) throw new Error(`Malformed _headers file: generated end marker without a start at line ${index + 1}.`);
			owned = false;
			continue;
		}
		if (owned) continue;
		if (!trimmed || trimmed.startsWith("#")) {
			if (current) current.lines.push(line);
			else if (trimmed) preamble.push(line);
			continue;
		}
		if (/^\s/.test(line)) {
			if (!current) throw new Error(`Malformed _headers file: directive appears before a route: ${line.trim()}`);
			current.lines.push(line);
			continue;
		}
		current = { pattern: trimmed, lines: [] };
		rules.push(current);
	}
	if (owned) throw new Error(`Malformed _headers file: generated marker opened at line ${markerStartLine} has no matching end marker.`);
	return { preamble, rules };
}

function mergeRoutes(files: string[]): ParsedHeaderFile {
	const result: ParsedHeaderFile = { preamble: [], rules: [] };
	for (const source of files) {
		const parsed = parseHeaderFile(source);
		result.preamble.push(...parsed.preamble);
		for (const rule of parsed.rules) {
			const existingIndex = result.rules.findIndex((candidate) => candidate.pattern === rule.pattern);
			if (existingIndex === -1) result.rules.push(rule);
			else {
				const existing = result.rules[existingIndex];
				const known = new Set(existing.lines);
				const additional = rule.lines.filter((line) => !known.has(line));
				result.rules[existingIndex] = { pattern: rule.pattern, lines: [...existing.lines, ...additional] };
			}
		}
	}
	result.rules = result.rules.filter((rule) => rule.lines.some((line) => line.trim().length > 0));
	return result;
}

function addGeneratedRule(rules: HeaderRule[], pattern: string, headers: Record<string, string>): void {
	if (Object.keys(headers).length === 0) return;
	let index = rules.findIndex((rule) => rule.pattern === pattern);
	let rule: HeaderRule;
	if (index === -1) {
		rule = { pattern, lines: [] };
		rules.push(rule);
		index = rules.length - 1;
	} else {
		rule = rules[index];
	}
	if (Object.keys(headers).some((name) => name.startsWith("! "))) {
		rules.splice(index, 1);
		rules.push(rule);
	}
	rule.lines.push(OWNER_BEGIN);
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith("! ")) rule.lines.push(`  ${name}`);
		else rule.lines.push(`  ${name}: ${value}`);
	}
	rule.lines.push(OWNER_END);
}


export interface HeaderField {
	route: string;
	name: string;
	value: string;
	removal: boolean;
}

export function extractHeaderFields(sources: string[]): HeaderField[] {
	const fields: HeaderField[] = [];
	for (const source of new Set(sources.filter(Boolean))) {
		for (const rule of parseHeaderFile(source).rules) {
			for (const line of rule.lines) {
				const removal = line.match(/^\s+!\s+(.+)\s*$/);
				if (removal) {
					fields.push({ route: rule.pattern, name: removal[1].trim(), value: "", removal: true });
					continue;
				}
				const header = line.match(/^\s+([^!:][^:]*):\s*(.*)$/);
				if (header) fields.push({ route: rule.pattern, name: header[1].trim(), value: header[2], removal: false });
			}
		}
	}
	return fields;
}

export function mergeHeadersFile(sources: string[], routes: Routes): string {
	const unique = Array.from(new Set(sources.filter((source) => source.length > 0)));
	const parsed = mergeRoutes(unique);
	for (const [pattern, headers] of Object.entries(routes)) addGeneratedRule(parsed.rules, pattern, headers);
	const lines = [...parsed.preamble];
	for (const rule of parsed.rules) lines.push(rule.pattern, ...rule.lines, "");
	const content = lines.join("\n");
	return unique.some((source) => source.endsWith("\n")) && content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
}

export function countHeaderRules(content: string): number {
	return parseHeaderFile(content).rules.length;
}
