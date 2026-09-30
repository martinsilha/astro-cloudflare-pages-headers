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
