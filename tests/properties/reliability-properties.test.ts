import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { normalizeHeaders } from "../../src/headers-config.js";
import { mergeHeadersFile } from "../../src/headers-file.js";
import { applyConfiguredHeaders } from "../../src/runtime-core.js";

const seed = Number(process.env.FC_SEED ?? "20260930");
const numRuns = process.env.RELIABILITY_NIGHTLY === "true" ? 5_000 : 300;
const word = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
    minLength: 1,
    maxLength: 18,
  })
  .map((parts) => parts.join(""));
const value = fc
  .array(fc.constantFrom("a", "Z", "0", " ", ";", "/"), { maxLength: 40 })
  .map((parts) => parts.join(""));
const routeMap = fc
  .uniqueArray(word, { minLength: 1, maxLength: 8 })
  .chain((paths) =>
    fc
      .array(value, { minLength: paths.length, maxLength: paths.length })
      .map((values) =>
        Object.fromEntries(
          paths.map((path, index) => [
            `/${path}`,
            { "X-Fixture": values[index] ?? "" },
          ]),
        ),
      ),
  );

describe("reliability properties", () => {
  it("normalization is idempotent and never mutates nested caller input", () => {
    fc.assert(
      fc.property(routeMap, (input) => {
        const snapshot = structuredClone(input);
        const normalized = normalizeHeaders(input);
        expect(normalizeHeaders(normalized)).toEqual(normalized);
        expect(input).toEqual(snapshot);
      }),
      { seed, numRuns },
    );
  });

  it("generated-file merging is stable across repeated builds", () => {
    fc.assert(
      fc.property(routeMap, (routes) => {
        const first = mergeHeadersFile([], routes);
        expect(mergeHeadersFile([first], routes)).toBe(first);
      }),
      { seed, numRuns },
    );
  });

  it("route placeholders preserve generated ASCII path segments", () => {
    fc.assert(
      fc.property(word, (id) => {
        const rules = normalizeHeaders({
          "/items/:id": { "X-Item": "item-:id" },
        });
        const response = applyConfiguredHeaders(
          new Response("ok"),
          rules,
          new URL(`https://example.test/items/${id}`),
        );
        expect(response.headers.get("x-item")).toBe(`item-${id}`);
      }),
      { seed, numRuns },
    );
  });

  it("application headers win case-insensitively without changing response data", () => {
    fc.assert(
      fc.asyncProperty(value, value, async (appValue, configuredValue) => {
        const rules = normalizeHeaders({
          "/*": { "Cache-Control": configuredValue, "X-Added": "present" },
        });
        const original = new Response("body", {
          status: 202,
          headers: { "cache-control": appValue },
        });
        const result = applyConfiguredHeaders(
          original,
          rules,
          new URL("https://example.test/a"),
        );
        expect(result.headers.get("CACHE-control")).toBe(appValue.trim());
        expect(result.headers.get("x-added")).toBe("present");
        expect(result.status).toBe(202);
        expect(await result.text()).toBe("body");
      }),
      { seed, numRuns },
    );
  });
});
