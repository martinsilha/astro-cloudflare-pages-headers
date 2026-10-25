import { assertPublishedConsumerLock, publishedConsumerManifest } from "./published-consumer-manifest.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "astro-cloudflare-pages-headers";
const version = process.argv[2];
if (!version) throw new Error("Pass the published package version.");
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceFixture = path.join(repositoryRoot, "fixtures", "astro-consumer");
const tempRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "astro-published-consumer-"),
);
const fixtureRoot = path.join(tempRoot, "fixture");
const reportRoot = path.join(repositoryRoot, ".release-artifacts");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: fixtureRoot,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout ?? 20 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: options.capture ? "utf8" : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      command + " " + args.join(" ") + " failed with " + result.status + ".",
    );
  return result.stdout;
}

try {
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
  const manifest = publishedConsumerManifest(packageName, version);
  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await fs.writeFile(path.join(fixtureRoot, "pnpm-workspace.yaml"), "allowBuilds:\n  esbuild: true\n  workerd: true\n");
  const lockPath = path.join(fixtureRoot, "pnpm-lock.yaml");
  const pinnedLock = await fs.readFile(path.join(sourceFixture, "locks", "astro-7.3.5.yaml"), "utf8");
  await fs.writeFile(lockPath, pinnedLock);
  run("pnpm", ["install", "--lockfile-only", "--no-frozen-lockfile"], {
    env: { FIXTURE_PACKAGE_VERSION: version },
  });
  assertPublishedConsumerLock(pinnedLock, await fs.readFile(lockPath, "utf8"), packageName, version);
  run("pnpm", ["install", "--frozen-lockfile"], {
    env: { FIXTURE_PACKAGE_VERSION: version },
  });
  const resolved = run("pnpm", ["list", "--depth=0", "--json"], {
    capture: true,
  });
  const packages = JSON.parse(resolved);
  if (!packages.some(pkg => pkg.dependencies?.[packageName]?.version === version))
    throw new Error("Published consumer did not install the exact requested version.");
  await fs.mkdir(reportRoot, { recursive: true });
  await fs.writeFile(
    path.join(reportRoot, "published-consumer-report.json"),
    JSON.stringify(
      {
        package: packageName,
        version,
        astro: "7.3.5",
        adapter: "14.3.3",
        resolved: packages,
        installCompleted: true,
        toolchainFrozen: true,
        toolchainLock: "fixtures/astro-consumer/locks/astro-7.3.5.yaml",
      },
      null,
      2,
    ) + "\n",
  );
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"]);
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.nodenext.json"]);
  const env = {
    FIXTURE_ASTRO_MAJOR: "7",
    FIXTURE_WITH_ADAPTER: "true",
    FIXTURE_LAYOUT: "custom",
  };
  run("pnpm", ["exec", "astro", "build"], { env });
  run("node", ["scripts-smoke-output.mjs"], { env });
  process.stdout.write(
    "Published package " +
      packageName +
      "@" +
      version +
      " passed clean consumer import, type, and Astro build smoke checks.\n",
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
