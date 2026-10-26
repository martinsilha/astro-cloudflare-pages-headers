import assert from "node:assert/strict";
import test from "node:test";
import { assertPublishedConsumerLock, publishedConsumerManifest } from "./published-consumer-manifest.mjs";
for (const version of ["1.7.8", "1.8.0-dev.1"]) {
  test(`published consumer uses exact ${version} dependency`, () => {
    const manifest = publishedConsumerManifest("astro-cloudflare-pages-headers", version);
    assert.equal(manifest.dependencies["astro-cloudflare-pages-headers"], version);
    assert.equal(manifest.dependencies.astro, "7.3.5");
    assert.equal(manifest.dependencies["@astrojs/cloudflare"], "14.3.3");
    assert.equal(manifest.private, true);
  });
}


test("published lock refresh preserves all validated transitive resolutions", () => {
  const original = `importers:
  .:
    dependencies:
      astro-cloudflare-pages-headers:
        specifier: file:./astro-cloudflare-pages-headers.tgz
        version: file:astro-cloudflare-pages-headers.tgz(astro@7.3.5)
      astro:
        specifier: 7.3.5
        version: 7.3.5
packages:
  astro-cloudflare-pages-headers@file:astro-cloudflare-pages-headers.tgz:
    resolution: {tarball: file:astro-cloudflare-pages-headers.tgz}
  '@cloudflare/vite-plugin@1.62.2':
    resolution: {integrity: unchanged}
snapshots:
  astro-cloudflare-pages-headers@file:astro-cloudflare-pages-headers.tgz(astro@7.3.5):
    dependencies:
      astro: 7.3.5
  '@cloudflare/vite-plugin@1.62.2': {}
`;
  const refreshed = original.replaceAll("file:./astro-cloudflare-pages-headers.tgz", "2.0.0-dev.2").replaceAll("file:astro-cloudflare-pages-headers.tgz", "2.0.0-dev.2");
  assert.doesNotThrow(() => assertPublishedConsumerLock(original, refreshed, "astro-cloudflare-pages-headers", "2.0.0-dev.2"));
  assert.throws(() => assertPublishedConsumerLock(original, refreshed.replaceAll("vite-plugin@1.62.2", "vite-plugin@1.65.0"), "astro-cloudflare-pages-headers", "2.0.0-dev.2"), /changed the validated/);
  assert.throws(() => assertPublishedConsumerLock(original, original, "astro-cloudflare-pages-headers", "2.0.0-dev.2"), /exact registry version/);
});
