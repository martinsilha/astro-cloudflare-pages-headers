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

export function assertPublishedConsumerLock(pinnedLock, refreshedLock, packageName, version) {
  function withoutIntegration(lock) {
    const output = [];
    let skippedIndent;
    for (const line of lock.replaceAll("\r\n", "\n").split("\n")) {
      if (line.startsWith(`  ${packageName}@`) || line.startsWith(`  '${packageName}@`)) {
        skippedIndent = 2;
        continue;
      }
      if (line === `      ${packageName}:`) {
        skippedIndent = 6;
        continue;
      }
      if (skippedIndent !== undefined && line.trim() && line.search(/\S/) <= skippedIndent) skippedIndent = undefined;
      if (skippedIndent === undefined) output.push(line);
    }
    return output.join("\n");
  }
  if (withoutIntegration(pinnedLock) !== withoutIntegration(refreshedLock)) {
    throw new Error("Published consumer refresh changed the validated Astro, adapter, Wrangler, or transitive resolutions.");
  }
  const importer = refreshedLock.replaceAll("\r\n", "\n").split(`      ${packageName}:\n`)[1]?.split(/(?=^      \S)|(?=^    \S)/m)[0] ?? "";
  if (!importer.includes(`        specifier: ${version}\n`) || !importer.split("\n").some(line => line === `        version: ${version}` || line.startsWith(`        version: ${version}(`))) {
    throw new Error("Published consumer lock does not resolve the exact registry version.");
  }
}
