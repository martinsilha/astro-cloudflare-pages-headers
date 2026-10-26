import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveCloudflareVersion,
  resolveGeneratedAssets,
  toPath,
  type AssetLayoutConfig,
} from "./output-path.js";

const roots: string[] = [];

async function createConfig(): Promise<{
  root: string;
  config: AssetLayoutConfig;
  rendered: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "astro-assets space-"));
  roots.push(root);
  const outDir = path.join(root, "output dir");
  const server = path.join(outDir, "server bundle");
  const client = path.join(root, "client assets");
  const rendered = path.join(outDir, "rendered html");
  await Promise.all(
    [outDir, server, client, rendered].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  return {
    root,
    rendered,
    config: {
      root: pathToFileURL(`${root}${path.sep}`),
      outDir: pathToFileURL(`${outDir}${path.sep}`),
      base: "/docs/",
      build: {
        server: pathToFileURL(`${server}${path.sep}`),
        client: pathToFileURL(`${client}${path.sep}`),
        assets: "_astro",
      },
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("generated Cloudflare asset path resolution", () => {
  it("uses generated Wrangler metadata with comments, trailing commas, spaces, and HTML handling", async () => {
    const { config, rendered } = await createConfig();
    const server = new URL(
      config.build.server instanceof URL
        ? config.build.server
        : pathToFileURL(config.build.server),
    );
    const filename = new URL("wrangler.jsonc", server);
    await fs.writeFile(
      filename,
      '{\n  // Generated for deployment\n  "assets": { "directory": "../../client assets", "html_handling": "drop-trailing-slash", },\n}\n',
    );
    const result = await resolveGeneratedAssets(config, rendered, {});
    expect(result.directory).toBe(
      path.resolve(
        path.dirname(fileURLToPath(filename)),
        "../../client assets",
      ),
    );
    expect(result.htmlHandling).toBe("drop-trailing-slash");
    expect(result.configPath).toBe(fileURLToPath(filename));
  });

  it("resolves relative, absolute, and file-URL overrides and rejects known-path conflicts", async () => {
    const { root, config, rendered } = await createConfig();
    const relative = await resolveGeneratedAssets(config, rendered, {
      explicitDirectory: "custom assets",
    });
    expect(relative.directory).toBe(path.join(root, "custom assets"));
    const absolute = path.join(root, "absolute assets");
    expect(
      (
        await resolveGeneratedAssets(config, rendered, {
          explicitDirectory: absolute,
        })
      ).directory,
    ).toBe(absolute);
    expect(
      (
        await resolveGeneratedAssets(config, rendered, {
          explicitDirectory: pathToFileURL(`${absolute}${path.sep}`),
        })
      ).directory,
    ).toBe(absolute);

    const server = new URL(
      config.build.server instanceof URL
        ? config.build.server
        : pathToFileURL(config.build.server),
    );
    await fs.writeFile(
      new URL("wrangler.json", server),
      JSON.stringify({ assets: { directory: "../../client assets" } }),
    );
    await expect(
      resolveGeneratedAssets(config, rendered, {
        explicitDirectory: "custom assets",
      }),
    ).rejects.toThrow("disagrees with the deployment asset directory");
  });

  it("uses known legacy and modern adapter layouts without guessing unknown Cloudflare layouts", async () => {
    const { config, rendered } = await createConfig();
    expect(
      (
        await resolveGeneratedAssets(config, rendered, {
          adapterName: "@astrojs/cloudflare",
          adapterVersion: 12,
        })
      ).directory,
    ).toBe(path.resolve(toPath(config.outDir)));
    const modernClient = path.resolve(toPath(config.build.client));
    expect(
      (
        await resolveGeneratedAssets(config, path.join(modernClient, "docs"), {
          adapterName: "@astrojs/cloudflare",
          adapterVersion: 13,
        })
      ).directory,
    ).toBe(modernClient);
    await expect(
      resolveGeneratedAssets(config, rendered, {
        adapterName: "@astrojs/cloudflare",
      }),
    ).rejects.toThrow("Set assetsDirectory");
  });

  it("ignores a source Wrangler configuration outside generated build outputs", async () => {
    const { root, config } = await createConfig();
    const output = toPath(config.outDir);
    await fs.writeFile(
      path.join(root, "wrangler.jsonc"),
      '{ "assets": { "directory": "source-assets" } }',
    );
    expect((await resolveGeneratedAssets(config, output, {})).directory).toBe(
      path.resolve(output),
    );
  });

  it("parses TOML metadata and ignores non-string handling options", async () => {
    const { config, rendered } = await createConfig();
    const server = new URL(
      config.build.server instanceof URL
        ? config.build.server
        : pathToFileURL(config.build.server),
    );
    await fs.writeFile(
      new URL("wrangler.toml", server),
      '[assets]\ndirectory = "../../client assets"\nhtml_handling = "none"\nnot_found_handling = "404-page"\n',
    );
    const result = await resolveGeneratedAssets(config, rendered, {});
    expect(result.directory).toBe(
      path.resolve(fileURLToPath(server), "../../client assets"),
    );
    expect(result.htmlHandling).toBe("none");
    expect(result.notFoundHandling).toBe("404-page");
  });

  it("handles block comments and ignores non-string JSONC handling values", async () => {
    const { config, rendered } = await createConfig();
    const server = new URL(
      config.build.server instanceof URL
        ? config.build.server
        : pathToFileURL(config.build.server),
    );
    await fs.writeFile(
      new URL("wrangler.jsonc", server),
      '{ /* generated */ "assets": { "directory": "../../client assets", "html_handling": true, "not_found_handling": null } }',
    );
    const result = await resolveGeneratedAssets(config, rendered, {});
    expect(result.directory).toBe(
      path.resolve(fileURLToPath(server), "../../client assets"),
    );
    expect(result.htmlHandling).toBe("auto-trailing-slash");
    expect(result.notFoundHandling).toBeUndefined();
  });

  it("reports malformed generated JSONC and non-missing filesystem errors", async () => {
    const { config, rendered } = await createConfig();
    const server = new URL(
      config.build.server instanceof URL
        ? config.build.server
        : pathToFileURL(config.build.server),
    );
    const generatedConfig = fileURLToPath(new URL("wrangler.jsonc", server));
    await fs.writeFile(generatedConfig, "{ not valid jsonc");
    await expect(resolveGeneratedAssets(config, rendered, {})).rejects.toThrow(
      "Could not parse generated Wrangler configuration",
    );

    await fs.rm(generatedConfig);
    vi.spyOn(fs, "readFile").mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    await expect(resolveGeneratedAssets(config, rendered, {})).rejects.toThrow(
      "Could not read generated Wrangler configuration",
    );
  });

  it("rejects modern adapter output outside the known client layout", async () => {
    const { config, rendered } = await createConfig();
    await expect(
      resolveGeneratedAssets(config, rendered, {
        adapterName: "@astrojs/cloudflare",
        adapterVersion: 14,
      }),
    ).rejects.toThrow(
      "Could not safely resolve the Cloudflare asset directory",
    );
  });

  it("finds the installed Cloudflare adapter major version and tolerates unreadable metadata", async () => {
    const { root } = await createConfig();
    const packageDirectory = path.join(
      root,
      "node_modules",
      "@astrojs",
      "cloudflare",
    );
    await fs.mkdir(packageDirectory, { recursive: true });
    await fs.writeFile(path.join(packageDirectory, "index.js"), "export {};\n");
    const packageJson = path.join(packageDirectory, "package.json");
    await fs.writeFile(
      packageJson,
      JSON.stringify({
        name: "@astrojs/cloudflare",
        version: "14.3.3",
        main: "index.js",
      }),
    );
    const rootUrl = pathToFileURL(`${root}${path.sep}`);
    expect(resolveCloudflareVersion(rootUrl, "@astrojs/cloudflare")).toBe(14);
    await fs.writeFile(packageJson, "{ malformed");
    expect(
      resolveCloudflareVersion(rootUrl, "@astrojs/cloudflare"),
    ).toBeUndefined();
    expect(
      resolveCloudflareVersion(rootUrl, "@missing/adapter"),
    ).toBeUndefined();
  });

  it("uses the rendered output directory for non-Cloudflare builds", async () => {
    const { config, rendered } = await createConfig();
    expect((await resolveGeneratedAssets(config, rendered, {})).directory).toBe(
      rendered,
    );
  });

  it("preserves quoted comment markers, escaped quotes and backslashes in JSONC strings", async () => {
    const { config, rendered } = await createConfig();
    const filename = path.join(toPath(config.build.server), "wrangler.jsonc");
    const directory = '../../client // assets /* literal */ "quoted" \\folder';
    const metadata = JSON.stringify({ assets: { directory, not_found_handling: "single-page-application" } });
    await fs.writeFile(filename, `/* a * inside / a block */\n${metadata}\n// final comment without newline`);
    const result = await resolveGeneratedAssets(config, rendered, {});
    expect(result).toEqual({
      directory: path.resolve(path.dirname(filename), directory),
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "single-page-application",
      configPath: filename,
    });
  });

  it.each(["wrangler.json", "wrangler.jsonc", "wrangler.toml"])(
    "looks for %s in outDir when server output has no generated metadata", async (name) => {
      const { config, rendered } = await createConfig();
      const filename = path.join(toPath(config.outDir), name);
      await fs.writeFile(filename, name.endsWith("toml")
        ? "[assets]\ndirectory='../deployed assets'\n"
        : JSON.stringify({ assets: { directory: "../deployed assets" } }));
      expect(await resolveGeneratedAssets(config, rendered, {})).toEqual({
        directory: path.resolve(path.dirname(filename), "../deployed assets"),
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: undefined,
        configPath: filename,
      });
    },
  );

  it("uses rendered metadata after configurations without an assets directory", async () => {
    const { config, rendered } = await createConfig();
    await fs.writeFile(path.join(toPath(config.build.server), "wrangler.json"), '{}');
    await fs.writeFile(path.join(toPath(config.outDir), "wrangler.jsonc"), '{"assets":{"directory":false}}');
    await fs.writeFile(path.join(toPath(config.outDir), "wrangler.toml"), '[vars]\nSOMETHING="value"\n');
    const filename = path.join(rendered, "wrangler.json");
    await fs.writeFile(filename, '{"assets":{"directory":"../public"}}');
    expect((await resolveGeneratedAssets(config, rendered, {}))).toEqual({
      directory: path.resolve(rendered, "../public"),
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: undefined,
      configPath: filename,
    });
  });

  it("prioritizes generated server metadata over output metadata and adapter guesses", async () => {
    const { config, rendered } = await createConfig();
    const server = toPath(config.build.server);
    await fs.writeFile(path.join(server, "wrangler.json"), '{"assets":{"directory":"./deployed"}}');
    await fs.writeFile(path.join(toPath(config.outDir), "wrangler.json"), '{"assets":{"directory":"./other"}}');
    expect((await resolveGeneratedAssets(config, rendered, { adapterName: "@astrojs/cloudflare" })).directory)
      .toBe(path.join(server, "deployed"));
  });

  it.each(["relative", "url"])("accepts a matching %s override without ignoring deployment metadata", async (kind) => {
    const { root, config, rendered } = await createConfig();
    const directory = path.join(root, "deployed");
    const filename = path.join(toPath(config.build.server), "wrangler.json");
    await fs.writeFile(filename, JSON.stringify({ assets: { directory } }));
    const result = await resolveGeneratedAssets(config, rendered, {
      explicitDirectory: kind === "url" ? pathToFileURL(directory) : "deployed/../deployed",
    });
    expect(result.directory).toBe(directory);
    expect(result.configPath).toBe(filename);
  });

  it("rejects a mismatched file URL override", async () => {
    const { root, config, rendered } = await createConfig();
    await fs.writeFile(path.join(toPath(config.build.server), "wrangler.json"), '{"assets":{"directory":"./deployed"}}');
    await expect(resolveGeneratedAssets(config, rendered, { explicitDirectory: pathToFileURL(path.join(root, "wrong")) }))
      .rejects.toThrow("disagrees with the deployment asset directory");
  });

  it.each(["/", "///docs///"])("resolves a modern adapter original client with base %s", async (base) => {
    const { root, config } = await createConfig();
    config.base = base;
    const originalClientDir = path.join(root, "original client");
    const rendered = base === "/" ? originalClientDir : path.join(originalClientDir, "docs");
    const result = await resolveGeneratedAssets(config, rendered, {
      adapterName: "@astrojs/cloudflare", adapterVersion: 13, originalClientDir,
    });
    expect(result.directory).toBe(originalClientDir);
  });

  it("accepts the exact modern client root even when the base is nonempty", async () => {
    const { config } = await createConfig();
    const client = toPath(config.build.client);
    expect((await resolveGeneratedAssets(config, client, { adapterName: "@astrojs/cloudflare", adapterVersion: 13 })).directory)
      .toBe(path.resolve(client));
  });

  it("does not apply Cloudflare layout guesses to other adapters", async () => {
    const { config, rendered } = await createConfig();
    expect((await resolveGeneratedAssets(config, rendered, { adapterName: "@astrojs/node", adapterVersion: 12 })).directory)
      .toBe(rendered);
  });

  it.each(["", "  "])("parses TOML assignments with %j spacing and ignores commented assignments", async (space) => {
    const { config, rendered } = await createConfig();
    const filename = path.join(toPath(config.build.server), "wrangler.toml");
    await fs.writeFile(filename, `[assets]\n# directory = "wrong"\n# html_handling = "wrong"\n# not_found_handling = "wrong"\n  directory${space}=${space}'../../deployed'\n  html_handling${space}=${space}'none'\n  not_found_handling${space}=${space}'404-page'\n`);
    expect(await resolveGeneratedAssets(config, rendered, {})).toEqual({
      directory: path.resolve(path.dirname(filename), "../../deployed"),
      htmlHandling: "none", notFoundHandling: "404-page", configPath: filename,
    });
  });

  it("retains the original parsing and I/O failures as causes", async () => {
    const { config, rendered } = await createConfig();
    await fs.writeFile(path.join(toPath(config.build.server), "wrangler.json"), '{');
    try {
      await resolveGeneratedAssets(config, rendered, {});
      expect.fail("malformed generated metadata must fail");
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFile").mockRejectedValue(failure);
    await expect(resolveGeneratedAssets(config, rendered, {})).rejects.toMatchObject({ cause: failure });
  });

  it("walks from a nested adapter entry past unrelated package metadata", async () => {
    const { root } = await createConfig();
    const directory = path.join(root, "node_modules", "@astrojs", "cloudflare");
    const nested = path.join(directory, "dist", "runtime");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "index.js"), "export {};\n");
    await fs.writeFile(path.join(nested, "package.json"), JSON.stringify({ name: "unrelated", version: "99.0.0" }));
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({
      name: "@astrojs/cloudflare", version: "13.8.2", main: "dist/runtime/index.js",
    }));
    expect(resolveCloudflareVersion(pathToFileURL(`${root}/`), "@astrojs/cloudflare")).toBe(13);
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({
      name: "@astrojs/cloudflare", main: "dist/runtime/index.js",
    }));
    expect(resolveCloudflareVersion(pathToFileURL(`${root}/`), "@astrojs/cloudflare")).toBeUndefined();
  });

  it("normalizes relative strings and decodes file URLs without losing spaces", () => {
    expect(toPath("relative assets/../final assets")).toBe(path.resolve("final assets"));
    const absolute = path.resolve("some assets #1");
    expect(toPath(pathToFileURL(absolute))).toBe(absolute);
  });


  it("removes trailing commas without changing comma/bracket sequences inside strings", async () => {
    const { config, rendered } = await createConfig();
    const filename = path.join(toPath(config.build.server), "wrangler.jsonc");
    const directory = 'assets,]literal, }literal \\"quoted,]"';
    await fs.writeFile(filename, `{
      "ignored": ["value,]", {"quoted": "value,}",},],
      "assets": {
        "directory": ${JSON.stringify(directory)}, // preserve punctuation in directory
        "html_handling": "none", /* trailing comma before closing object */
      },
    }`);
    const result = await resolveGeneratedAssets(config, rendered, {});
    expect(result.directory).toBe(path.resolve(path.dirname(filename), directory));
    expect(result.htmlHandling).toBe("none");
  });

});
