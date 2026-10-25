import assert from "node:assert/strict";
import test from "node:test";
import { publishedConsumerManifest } from "./published-consumer-manifest.mjs";
for (const version of ["1.7.8", "1.8.0-dev.1"]) {
  test(`published consumer uses exact ${version} dependency`, () => {
    const manifest = publishedConsumerManifest("astro-cloudflare-pages-headers", version);
    assert.equal(manifest.dependencies["astro-cloudflare-pages-headers"], version);
    assert.equal(manifest.dependencies.astro, "7.3.5");
    assert.equal(manifest.dependencies["@astrojs/cloudflare"], "14.3.3");
    assert.equal(manifest.private, true);
  });
}
