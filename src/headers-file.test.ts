import { describe, expect, it } from "vitest";
import { countHeaderRules, extractHeaderFields, mergeHeadersFile } from "./headers-file.js";

describe("_headers merge", () => {
	it("coalesces identical copied files and preserves distinct existing fields", () => {
		const existing = "# manual\n/*\n  X-Manual: keep\n";
		const output = mergeHeadersFile([existing, existing], { "/*": { "X-Generated": "yes" } });
		expect(output.match(/X-Manual: keep/g)).toHaveLength(1);
		expect(countHeaderRules(output)).toBe(1);
		expect(output).toContain("X-Generated: yes");
		expect(extractHeaderFields([output])).toEqual([
			expect.objectContaining({ route: "/*", name: "X-Manual", value: "keep", removal: false }),
		]);
	});

	it("replaces only its own marked directives on repeated builds", () => {
		const first = mergeHeadersFile([], { "/*": { "X-Generated": "old" } });
		const second = mergeHeadersFile([first], { "/*": { "X-Generated": "new" } });
		expect(second).not.toContain("X-Generated: old");
		expect(second).toContain("X-Generated: new");
		expect(countHeaderRules(second)).toBe(1);
	});

	it.each([
		["# END astro-cloudflare-pages-headers\n", "end marker without a start"],
		["/*\n# BEGIN astro-cloudflare-pages-headers\n", "has no matching end"],
		["/*\n# BEGIN astro-cloudflare-pages-headers\n# BEGIN astro-cloudflare-pages-headers\n# END astro-cloudflare-pages-headers\n", "nested generated marker"],
	])("rejects malformed ownership markers", (content, message) => {
		expect(() => mergeHeadersFile([content], {})).toThrow(message);
	});
});

describe("manual header syntax preservation", () => {
	it("extracts removals, blank values and colon-containing values without treating comments as fields", () => {
		const source = "# top\n/route\n  !   X-Remove  \n  X-Empty:\n  X-Link  : https://example.com/a:b\n  # comment: not a header\n";
		expect(extractHeaderFields(["", source, source])).toEqual([
			{ route: "/route", name: "X-Remove", value: "", removal: true },
			{ route: "/route", name: "X-Empty", value: "", removal: false },
			{ route: "/route", name: "X-Link", value: "https://example.com/a:b", removal: false },
		]);
	});
	it("merges distinct files by route, retaining unique directives, comments and order", () => {
		const result = mergeHeadersFile([
			"# first\r/a\r  A: one\r  # note\r/b\r  B: two\r",
			"# second\n/a\n  A: one\n  C: three\n/c\n  D: four\n",
		], {});
		expect(result).toBe("# first\n# second\n/a\n  A: one\n  # note\n  C: three\n\n/b\n  B: two\n\n\n/c\n  D: four\n\n");
	});
	it("places removal rules last and does not render empty generated maps", () => {
		const result = mergeHeadersFile(["/remove\n  X-Existing: yes\n/other\n  X-Other: yes\n"], {
			"/empty": {}, "/remove": { "X-New": "value", "! X-Existing": "" },
		});
		expect(result.indexOf("/other")).toBeLessThan(result.indexOf("/remove"));
		expect(result).toContain("  ! X-Existing\n");
		expect(result).not.toContain("! X-Existing:");
		expect(result).not.toContain("/empty");
		expect(countHeaderRules(result)).toBe(2);
	});
	it("rejects directives before any route and reports actual malformed marker lines", () => {
		expect(() => mergeHeadersFile(["  X-Orphan: no\n"], {})).toThrow("directive appears before a route: X-Orphan: no");
		expect(() => mergeHeadersFile(["# note\n# END astro-cloudflare-pages-headers\n"], {})).toThrow("at line 2");
		expect(() => mergeHeadersFile(["# note\n# BEGIN astro-cloudflare-pages-headers\n"], {})).toThrow("opened at line 2");
		expect(() => mergeHeadersFile(["# BEGIN astro-cloudflare-pages-headers\n# BEGIN astro-cloudflare-pages-headers\n"], {})).toThrow("at line 2");
	});
	it("ignores empty inputs and omits routes with only whitespace", () => {
		expect(mergeHeadersFile(["", "\n", "/empty\n  \n"], {})).toBe("");
		expect(countHeaderRules("/one\n X: y\n/two\n X: z\n")).toBe(2);
	});
});
