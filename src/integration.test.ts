// astro-cloudflare-pages-headers.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import astroCloudflarePagesHeaders from "./integration";
import type { AstroIntegration } from "astro";

describe("astro-cloudflarePagesHeaders integration", () => {
  let integration: ReturnType<typeof astroCloudflarePagesHeaders>;
  let hooks: AstroIntegration["hooks"];
  let logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  let writeFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Create a fake logger with spies.
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    integration = astroCloudflarePagesHeaders();
    hooks = integration.hooks;

    // Spy on fs.writeFile to intercept file writes.
    writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue() as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should log a warning and skip writing file if no headers config is provided", async () => {
    const buildDir = "buildDir";
    // Note: Do not call astro:config:setup so that astroHeaders remains undefined.
    await hooks["astro:build:done"]({ dir: buildDir, logger });

    expect(logger.warn).toHaveBeenCalledWith(
      "[astro-cloudflare-pages-headers] No headers configuration found in Astro config. Skipping _headers generation."
    );
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("should generate _headers file with flat headers", async () => {
    // Simulate a configuration with flat headers.
    const config = { server: { headers: { "X-Test": "value" } } };
    hooks["astro:config:setup"]({ config, logger });

    const buildDir = "buildDir";
    await hooks["astro:build:done"]({ dir: buildDir, logger });

    const expectedContent = "/*\n  X-Test: value\n";
    const expectedFilePath = path.resolve(buildDir, "_headers");

    expect(writeFileSpy).toHaveBeenCalledWith(expectedFilePath, expectedContent, "utf-8");
    expect(logger.info).toHaveBeenCalledWith(
      `[astro-cloudflare-pages-headers] Successfully created _headers at ${expectedFilePath}`
    );
  });

  it("should generate _headers file with nested headers", async () => {
    // Simulate a configuration with nested headers.
    const config = { server: { headers: { "/test": { "X-Test": "value" } } } };
    hooks["astro:config:setup"]({ config, logger });

    const buildDir = "buildDir";
    await hooks["astro:build:done"]({ dir: buildDir, logger });

    const expectedContent = "/test\n  X-Test: value\n";
    const expectedFilePath = path.resolve(buildDir, "_headers");

    expect(writeFileSpy).toHaveBeenCalledWith(expectedFilePath, expectedContent, "utf-8");
    expect(logger.info).toHaveBeenCalledWith(
      `[astro-cloudflare-pages-headers] Successfully created _headers at ${expectedFilePath}`
    );
  });

  it("should log an error if writing the _headers file fails", async () => {
    // Force fs.writeFile to throw an error.
    writeFileSpy.mockRejectedValue(new Error("fs error"));

    const config = { server: { headers: { "X-Test": "value" } } };
    hooks["astro:config:setup"]({ config, logger });

    const buildDir = "buildDir";
    await hooks["astro:build:done"]({ dir: buildDir, logger });

    expect(logger.error).toHaveBeenCalled();
    expect(vi.mocked(logger.error).mock.calls[0][0]).toContain("Failed to write _headers file");
  }); 
});
