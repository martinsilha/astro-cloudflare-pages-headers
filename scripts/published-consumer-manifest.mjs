export function publishedConsumerManifest(packageName, version) {
  return {
    name: "astro-published-package-smoke",
    private: true,
    type: "module",
    packageManager: "pnpm@10.29.3",
    dependencies: {
      astro: "7.3.5",
      "@astrojs/cloudflare": "14.3.3",
      [packageName]: version,
    },
    devDependencies: { typescript: "5.9.3", wrangler: "4.144.0" },
  };
}
