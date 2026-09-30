import { describe, expect, it } from "vitest";
import { normalizeHeaders } from "./headers-config.js";
import { applyConfiguredHeaders } from "./runtime-core.js";

describe("header configuration", () => {
	it("normalizes flat and universal wildcard routes without mutating input", () => {
		const input = { "*": { "X-Test": "wildcard", "x-keep": "universal" }, "/*": { "x-test": "explicit" } };
		expect(normalizeHeaders(input)).toEqual({ "/*": { "x-keep": "universal", "x-test": "explicit" } });
		expect(input["*"]["X-Test"]).toBe("wildcard");
		expect(normalizeHeaders({ "X-Test": "flat" })).toEqual({ "/*": { "X-Test": "flat" } });
		expect(normalizeHeaders({})).toEqual({});
	});

	it.each([
		[{ "X-Test": "yes", "/path": { "X-Test": "no" } }, "cannot mix"],
		[{ "/path": { "bad header": "no" } }, "Invalid HTTP header name"],
		[{ "/path": { "X-Test": "a\nb" } }, "line break"],
		[{ "/a/*/*": { "X-Test": "no" } }, "only one wildcard"],
		[{ "/a?b": { "X-Test": "no" } }, "query strings"],
		[{ "/a#b": { "X-Test": "no" } }, "fragments"],
		[{ "/:id/:id": { "X-Test": "no" } }, "repeats a named placeholder"],
		[{ "/a": { "X-Test": 7 } }, "must have a string value"],
		[{ "/a": { "X-Test": null } }, "must have a string value"],
		[{ "https://user@example.com/*": { "X-Test": "no" } }, "cannot include a port, credentials"],
		[{ "http://example.com/*": { "X-Test": "no" } }, "must use HTTPS"],
		[{ "https://example.com:8443/*": { "X-Test": "no" } }, "cannot include a port"],
		[{ "https://example.com:443/*": { "X-Test": "no" } }, "cannot include a port"],
		[{ "https://*.example.com/": { "X-Test": "no" } }, "wildcards may only appear in the URL path"],
	] as const)("rejects invalid input %#", (input, error) => {
		expect(() => normalizeHeaders(input)).toThrow(error);
	});
});

describe("runtime response headers", () => {
	it("applies exact, wildcard, and placeholder rules in order while preserving response fields", async () => {
		const rules = normalizeHeaders({
			"/*": { "X-General": "general", "X-Order": "general" },
			"/posts/:slug": { "X-Order": "post-:slug", "X-Post": ":slug" },
			"/posts/*": { "X-Order": "splat-:splat" },
		});
		const original = new Response("body", { status: 201, statusText: "Created", headers: { "X-App": "kept" } });
		const response = applyConfiguredHeaders(original, rules, new URL("https://site.example/posts/hello?from=test"));
		expect(response).not.toBe(original);
		expect(response.status).toBe(201);
		expect(response.statusText).toBe("Created");
		expect(response.headers.get("x-general")).toBe("general");
		expect(response.headers.get("x-order")).toBe("general, post-hello, splat-hello");
		expect(response.headers.get("x-post")).toBe("hello");
		expect(response.headers.get("x-app")).toBe("kept");
		expect(await response.text()).toBe("body");
	});

	it("keeps application headers case-insensitively and preserves a streaming body", async () => {
		let release: (() => void) | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("first"));
				void new Promise<void>((resolve) => {
					release = resolve;
				}).then(() => {
					controller.enqueue(new TextEncoder().encode("second"));
					controller.close();
				});
			},
		});
		const original = new Response(body, { headers: { "cAcHe-CoNtRoL": "private, no-store" } });
		const response = applyConfiguredHeaders(original, normalizeHeaders({ "Cache-Control": "public, max-age=3600", "X-Test": "added" }), new URL("https://site.example/"));
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-test")).toBe("added");
		const reader = response.body!.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("first");
		release?.();
		const second = await reader.read();
		expect(new TextDecoder().decode(second.value)).toBe("second");
	});

	it("matches HTTPS host rules without considering request scheme or port", () => {
		const rules = normalizeHeaders({ "HTTPS://:sub.example.com/:slug": { "X-Match": ":sub/:slug" } });
		const response = applyConfiguredHeaders(new Response(null), rules, new URL("http://blog.example.com:8787/post"));
		expect(response.headers.get("x-match")).toBe("blog/post");
	});

	it("matches exact paths and host/path placeholders without crossing delimiters", () => {
		const rules = normalizeHeaders({
			"/exact/:id": { "X-Exact": ":id" },
			"https://:sub.example.com/:file": { "X-Host": ":sub/:file" },
		});
		const exact = applyConfiguredHeaders(new Response(null), rules, new URL("https://site.example/exact/42?ignored=yes"));
		expect(exact.headers.get("x-exact")).toBe("42");
		const host = applyConfiguredHeaders(new Response(null), rules, new URL("http://blog.example.com:8787/file.css?ignored=yes"));
		expect(host.headers.get("x-host")).toBe("blog/file.css");
		const subdomain = applyConfiguredHeaders(new Response(null), rules, new URL("https://a.blog.example.com/file.css"));
		expect(subdomain.headers.has("x-host")).toBe(false);
		const nestedPath = applyConfiguredHeaders(new Response(null), rules, new URL("https://blog.example.com/file.css/extra"));
		expect(nestedPath.headers.has("x-host")).toBe(false);
	});

	it("adds configured headers to an application OPTIONS response without adding a body", async () => {
		const response = applyConfiguredHeaders(
			new Response(null, { status: 204 }),
			normalizeHeaders({ "X-Options": "configured" }),
			new URL("https://site.example/api"),
		);
		expect(response.status).toBe(204);
		expect(response.headers.get("x-options")).toBe("configured");
		expect(response.body).toBeNull();
	});

	it("preserves separate application cookies and does not append a configured cookie over them", async () => {
		const headers = new Headers();
		headers.append("Set-Cookie", "first=one; Path=/");
		headers.append("Set-Cookie", "second=two; Path=/");
		const response = applyConfiguredHeaders(
			new Response("cookies", { status: 202, statusText: "Accepted", headers }),
			normalizeHeaders({ "Set-Cookie": "integration=ignored; Path=/" }),
			new URL("https://site.example/"),
		);
		expect(response.status).toBe(202);
		expect(response.statusText).toBe("Accepted");
		expect(response.headers.getSetCookie()).toEqual(["first=one; Path=/", "second=two; Path=/"]);
		expect(await response.text()).toBe("cookies");
	});

	it("does not add response headers to a WebSocket upgrade", () => {
		const original = { status: 101, headers: new Headers(), body: null } as Response;
		expect(applyConfiguredHeaders(original, normalizeHeaders({ "X-Test": "no" }), new URL("https://site.example/"))).toBe(original);
	});
});
