import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceFixture = path.join(repositoryRoot, "fixtures", "astro-consumer");
const reportDirectory = path.join(
  repositoryRoot,
  "test-results",
  "dependency-drift",
);
const tempRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "astro-headers-drift-"),
);
const fixtureRoot = path.join(tempRoot, "fixture");
const tarballCandidates = (await fs.readdir(sourceFixture)).filter((name) =>
  name.endsWith(".tgz"),
);
const tarball =
  process.env.FIXTURE_PACKAGE_TARBALL ??
  (tarballCandidates.length === 1
    ? path.join(sourceFixture, tarballCandidates[0])
    : undefined);
if (!tarball)
  throw new Error("Dependency drift requires the packed package artifact.");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? fixtureRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    timeout: options.timeout ?? 20 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      command + " " + args.join(" ") + " failed with " + result.status + ".",
    );
  return result;
}

try {
  await fs.mkdir(reportDirectory, { recursive: true });
  await fs.cp(sourceFixture, fixtureRoot, {
    recursive: true,
    filter: (source) =>
      ![
        "node_modules",
        ".astro",
        ".wrangler",
        ".packed",
        "dist",
        "coverage",
        "test-results",
        "locks",
      ].includes(path.basename(source)) &&
      !path.basename(source).endsWith(".tgz") &&
      path.basename(source) !== "pnpm-lock.yaml",
  });
  await fs.copyFile(
    tarball,
    path.join(fixtureRoot, "astro-cloudflare-pages-headers.tgz"),
  );
  const manifest = {
    name: "astro-cloudflare-headers-dependency-drift",
    private: true,
    type: "module",
    packageManager: "pnpm@10.29.3",
    dependencies: {
      astro: "^7.0.0",
      "@astrojs/cloudflare": "^14.0.0",
      "astro-cloudflare-pages-headers":
        "file:./astro-cloudflare-pages-headers.tgz",
    },
    devDependencies: { typescript: "^5.9.0", wrangler: "^4.0.0" },
  };
  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const env = {
    ...process.env,
    FIXTURE_ASTRO_MAJOR: "7",
    FIXTURE_WITH_ADAPTER: "true",
    FIXTURE_LAYOUT: "custom",
  };
  run("pnpm", ["install", "--no-frozen-lockfile"], { env });
  const resolved = run("pnpm", ["list", "--depth=0", "--json"], {
    env,
    stdio: "pipe",
  });
  const versions = JSON.parse(resolved.stdout);
  const report = {
    generatedAt: new Date().toISOString(),
    ranges: manifest.dependencies,
    resolutions: versions,
  };
  await fs.writeFile(
    path.join(reportDirectory, "resolved-versions.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], { env });
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.nodenext.json"], { env });
  run("pnpm", ["exec", "astro", "build"], { env });
  run("node", ["scripts-smoke-output.mjs"], { env });
  process.stdout.write(
    "Dependency drift resolved versions recorded at " +
      path.join(reportDirectory, "resolved-versions.json") +
      ".\n",
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
