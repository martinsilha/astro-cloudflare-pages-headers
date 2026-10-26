import { expect, test } from "@playwright/test";

for (const route of ["/docs/", "/docs/about/"]) {
  test("enforces configured CSP on " + route, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    await page.addInitScript(() => {
      const target = window as Window & {
        __cspViolations?: Array<{ directive: string; blocked: string }>;
      };
      target.__cspViolations = [];
      window.addEventListener("securitypolicyviolation", (event) => {
        target.__cspViolations?.push({
          directive: event.violatedDirective,
          blocked: event.blockedURI,
        });
      });
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    const cspHeader = response?.headers()["content-security-policy"] ?? "";
    const cspMetaLocator = page.locator(
      'meta[http-equiv="content-security-policy"]',
    );
    const hasNativeCspMeta = (await cspMetaLocator.count()) > 0;
    const cspMeta = hasNativeCspMeta
      ? await cspMetaLocator.getAttribute("content")
      : null;
    const nativeCsp = process.env.PLAYWRIGHT_NATIVE_CSP === "true";
    expect(hasNativeCspMeta).toBe(nativeCsp);
    const csp = cspHeader || cspMeta || "";
    expect(csp.toLowerCase()).toContain("script-src");
    expect(csp.toLowerCase()).toContain("style-src");
    expect(csp).toContain("sha256-");

    const expectedMarker = route.includes("about") ? "about" : "index";
    const expectedColor = route.includes("about")
      ? "rgb(0, 0, 255)"
      : "rgb(255, 0, 0)";
    if (nativeCsp) {
      // Astro's native meta policy is enforced alongside the integration
      // response policy, so this fixture's raw inline script and style are
      // intentionally denied by the stricter native policy.
      expect(
        await page.evaluate(
          () => (window as Window & { cspFixture?: string }).cspFixture,
        ),
      ).toBeUndefined();
    } else {
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as Window & { cspFixture?: string }).cspFixture,
          ),
        )
        .toBe(expectedMarker);
    }
    const initialColor = await page
      .locator("div")
      .first()
      .evaluate((node) => getComputedStyle(node).color);
    expect(initialColor).toBe(nativeCsp ? "rgb(0, 0, 0)" : expectedColor);

    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__unauthorizedScriptExecuted = true";
      document.head.append(script);
      const style = document.createElement("style");
      style.textContent = "div { color: rgb(1, 2, 3) !important }";
      document.head.append(style);
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const target = window as Window & { __cspViolations?: unknown[] };
          return target.__cspViolations?.length ?? 0;
        }),
      )
      .toBeGreaterThanOrEqual(2);
    expect(
      await page.evaluate(() =>
        Boolean(
          (window as Window & { __unauthorizedScriptExecuted?: boolean })
            .__unauthorizedScriptExecuted,
        ),
      ),
    ).toBe(false);
    await expect
      .poll(() =>
        page
          .locator("div")
          .first()
          .evaluate((node) => getComputedStyle(node).color),
      )
      .toBe(initialColor);

    const violations = await page.evaluate(() => {
      const target = window as Window & {
        __cspViolations?: Array<{ directive: string; blocked: string }>;
      };
      return target.__cspViolations ?? [];
    });
    expect(
      violations.some(
        (violation) =>
          violation.directive.startsWith("script-src") &&
          violation.blocked === "inline",
      ),
    ).toBe(true);
    expect(
      violations.some(
        (violation) =>
          violation.directive.startsWith("style-src") &&
          violation.blocked === "inline",
      ),
    ).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(
      consoleErrors.every((message) =>
        /content[- ]security[- ]policy|refused to execute|refused to apply/i.test(
          message,
        ),
      ),
    ).toBe(true);

    if (process.env.PLAYWRIGHT_STATIC_PAGES !== "true") {
      const dynamicResponse = await page.request.get(
        new URL("/docs/api-plain", page.url()).toString(),
      );
      expect(dynamicResponse.status()).toBe(200);
      const dynamicHeaders = dynamicResponse.headers();
      const dynamicCsp = dynamicHeaders["content-security-policy"] ?? "";
      if (nativeCsp) {
        expect(dynamicCsp).not.toContain("sha256-");
      } else {
        expect(dynamicCsp.toLowerCase()).toContain("script-src");
        expect(dynamicCsp).not.toContain("sha256-");
      }
    }
  });
}
