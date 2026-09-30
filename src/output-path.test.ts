import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGeneratedAssets, toPath, type AssetLayoutConfig } from './output-path.js';

const roots: string[] = [];

async function createConfig(): Promise<{ root: string; config: AssetLayoutConfig; rendered: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astro-assets space-'));
  roots.push(root);
  const outDir = path.join(root, 'output dir');
  const server = path.join(outDir, 'server bundle');
  const client = path.join(root, 'client assets');
  const rendered = path.join(outDir, 'rendered html');
  await Promise.all([outDir, server, client, rendered].map((directory) => fs.mkdir(directory, { recursive: true })));
  return {
    root,
    rendered,
    config: {
      root: pathToFileURL(`${root}${path.sep}`),
      outDir: pathToFileURL(`${outDir}${path.sep}`),
      base: '/docs/',
      build: {
        server: pathToFileURL(`${server}${path.sep}`),
        client: pathToFileURL(`${client}${path.sep}`),
        assets: '_astro',
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('generated Cloudflare asset path resolution', () => {
  it('uses generated Wrangler metadata with comments, trailing commas, spaces, and HTML handling', async () => {
    const { config, rendered } = await createConfig();
    const server = new URL(config.build.server instanceof URL ? config.build.server : pathToFileURL(config.build.server));
    const filename = new URL('wrangler.jsonc', server);
    await fs.writeFile(filename, '{\n  // Generated for deployment\n  "assets": { "directory": "../../client assets", "html_handling": "drop-trailing-slash", },\n}\n');
    const result = await resolveGeneratedAssets(config, rendered, {});
    expect(result.directory).toBe(path.resolve(path.dirname(fileURLToPath(filename)), '../../client assets'));
    expect(result.htmlHandling).toBe('drop-trailing-slash');
    expect(result.configPath).toBe(fileURLToPath(filename));
  });

  it('resolves relative, absolute, and file-URL overrides and rejects known-path conflicts', async () => {
    const { root, config, rendered } = await createConfig();
    const relative = await resolveGeneratedAssets(config, rendered, { explicitDirectory: 'custom assets' });
    expect(relative.directory).toBe(path.join(root, 'custom assets'));
    const absolute = path.join(root, 'absolute assets');
    expect((await resolveGeneratedAssets(config, rendered, { explicitDirectory: absolute })).directory).toBe(absolute);
    expect((await resolveGeneratedAssets(config, rendered, { explicitDirectory: pathToFileURL(`${absolute}${path.sep}`) })).directory).toBe(absolute);

    const server = new URL(config.build.server instanceof URL ? config.build.server : pathToFileURL(config.build.server));
    await fs.writeFile(new URL('wrangler.json', server), JSON.stringify({ assets: { directory: '../../client assets' } }));
    await expect(resolveGeneratedAssets(config, rendered, { explicitDirectory: 'custom assets' })).rejects.toThrow('disagrees with the deployment asset directory');
  });

  it('uses known legacy and modern adapter layouts without guessing unknown Cloudflare layouts', async () => {
    const { config, rendered } = await createConfig();
    expect((await resolveGeneratedAssets(config, rendered, { adapterName: '@astrojs/cloudflare', adapterVersion: 12 })).directory)
      .toBe(path.resolve(toPath(config.outDir)));
    const modernClient = path.resolve(toPath(config.build.client));
    expect((await resolveGeneratedAssets(config, path.join(modernClient, 'docs'), {
      adapterName: '@astrojs/cloudflare', adapterVersion: 13,
    })).directory).toBe(modernClient);
    await expect(resolveGeneratedAssets(config, rendered, { adapterName: '@astrojs/cloudflare' })).rejects.toThrow('Set assetsDirectory');
  });

  it('ignores a source Wrangler configuration outside generated build outputs', async () => {
    const { root, config } = await createConfig();
    const output = toPath(config.outDir);
    await fs.writeFile(path.join(root, 'wrangler.jsonc'), '{ "assets": { "directory": "source-assets" } }');
    expect((await resolveGeneratedAssets(config, output, {})).directory).toBe(path.resolve(output));
  });

  it('uses the rendered output directory for non-Cloudflare builds', async () => {
    const { config, rendered } = await createConfig();
    expect((await resolveGeneratedAssets(config, rendered, {})).directory).toBe(rendered);
  });
});
