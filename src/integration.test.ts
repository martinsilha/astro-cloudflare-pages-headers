/* eslint-disable */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import astroCloudflarePagesHeaders from "./integration";

describe("astro-cloudflarePagesHeaders integration", () => {
  let integration = astroCloudflarePagesHeaders();
  let hooks: any; // relaxed type for testing
  let logger: any;
  let writeFileSpy: any; // changed type to any

  beforeEach(() => {
    // Create a fake logger with required options.
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      options: { dest: "console", level: "info" },
      label: "test",
      fork: () => logger,
    };

    integration = astroCloudflarePagesHeaders();
    hooks = integration.hooks;

    // Spy on fs.writeFile to intercept file writes.
    writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should log a warning and skip writing file if no headers config is provided", async () => {
    const buildDir = "buildDir";
    // Do not call astro:config:setup so astroHeaders remains undefined.
    await hooks["astro:build:done"]({
      pages: [],
      routes: [],
      assets: new Map(),
      dir: new URL(buildDir),
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "[astro-cloudflare-pages-headers] No headers configuration found in Astro config. Skipping _headers generation."
    );
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("should generate _headers file with flat headers", async () => {
    // Simulate a configuration with flat headers.
    const config = ({
      server: { headers: { "X-Test": "value" } },
      integrations: [],
      trailingSlash: "ignore",
      redirects: {},
      build: {},
    } as any) as any;
    hooks["astro:config:setup"]({
      config,
      logger,
      command: "build",
      isRestart: false,
      updateConfig: (cfg: any) => cfg,
      addRenderer: () => {},
    });

    const buildDir = "buildDir";
    await hooks["astro:build:done"]({
      pages: [],
      routes: [],
      assets: new Map(),
      dir: new URL(buildDir),
      logger,
    });

    const expectedContent = "/*\n  X-Test: value\n";
    const expectedFilePath = path.resolve(buildDir, "_headers");

    expect(writeFileSpy).toHaveBeenCalledWith(expectedFilePath, expectedContent, "utf-8");
    expect(logger.info).toHaveBeenCalledWith(
      `[astro-cloudflare-pages-headers] Successfully created _headers at ${expectedFilePath}`
    );
  });

  it("should generate _headers file with nested headers", async () => {
    // Simulate a configuration with nested headers.
    const config = ({
      server: { headers: { "/test": { "X-Test": "value" } } },
      integrations: [],
      trailingSlash: "ignore",
      redirects: {},
      build: {},
    } as any) as any;
    hooks["astro:config:setup"]({
      config,
      logger,
      command: "build",
      isRestart: false,
      updateConfig: (cfg: any) => cfg,
      addRenderer: () => {},
    });

    const buildDir = "buildDir";
    await hooks["astro:build:done"]({
      pages: [],
      routes: [],
      assets: new Map(),
      dir: new URL(buildDir),
      logger,
    });

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

    const config = ({
      server: { headers: { "X-Test": "value" } },
      integrations: [],
      trailingSlash: "ignore",
      redirects: {},
      build: {},
    } as any) as any;
    hooks["astro:config:setup"]({
      config,
      logger,
      command: "build",
      isRestart: false,
      updateConfig: (cfg: any) => cfg,
      addRenderer: () => {},
    });

    const buildDir = "buildDir";
    await hooks["astro:build:done"]({
      pages: [],
      routes: [],
      assets: new Map(),
      dir: new URL(buildDir),
      logger,
    });

    expect(logger.error).toHaveBeenCalled();
    expect(vi.mocked(logger.error).mock.calls[0][0]).toContain("Failed to write _headers file");
  });
});
