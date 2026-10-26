import fs from 'node:fs/promises';

const astro = process.env.FIXTURE_ASTRO_VERSION;
const adapter = process.env.FIXTURE_ADAPTER_VERSION;
const wrangler = process.env.FIXTURE_WRANGLER_VERSION;
const packageFile = new URL('./package.json', import.meta.url);
const dependencies = {
  astro,
  'astro-cloudflare-pages-headers': 'file:./astro-cloudflare-pages-headers.tgz',
};
if (adapter) dependencies['@astrojs/cloudflare'] = adapter;
await fs.writeFile(new URL('./pnpm-workspace.yaml', import.meta.url), 'allowBuilds:\n  esbuild: true\n  workerd: true\n');
await fs.writeFile(packageFile, `${JSON.stringify({
  name: 'astro-cloudflare-headers-consumer-fixture',
  private: true,
  type: 'module',
  packageManager: 'pnpm@10.29.3',
  scripts: { build: 'astro build' },
  devDependencies: { typescript: '5.9.3', wrangler },
  dependencies,
}, null, 2)}\n`);
