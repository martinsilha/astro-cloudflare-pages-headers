import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Astro middleware entrypoint", () => {
  it("returns the original response when the injected runtime config is disabled", async () => {
    vi.stubGlobal("__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__", {
      enabled: false,
      routes: {},
    });
    const { onRequest } = await import("./runtime.js");
    const response = new Response("body", { status: 202 });
    const next = vi.fn(async () => response);
    await expect(
      onRequest({ url: new URL("https://example.test/") }, next),
    ).resolves.toBe(response);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("adds configured response headers when the injected runtime config is enabled", async () => {
    vi.stubGlobal("__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__", {
      enabled: true,
      routes: { "/*": { "X-Runtime": "enabled" } },
    });
    const { onRequest } = await import("./runtime.js");
    const result = await onRequest(
      { url: new URL("https://example.test/docs") },
      async () => new Response("body", { headers: { "X-App": "preserved" } }),
    );
    expect(result.headers.get("x-runtime")).toBe("enabled");
    expect(result.headers.get("x-app")).toBe("preserved");
    expect(await result.text()).toBe("body");
  });

  it("propagates route-handler failures", async () => {
    vi.stubGlobal("__ASTRO_CLOUDFLARE_PAGES_HEADERS_CONFIG__", {
      enabled: true,
      routes: {},
    });
    const { onRequest } = await import("./runtime.js");
    const failure = new Error("route failed");
    await expect(
      onRequest({ url: new URL("https://example.test/") }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
