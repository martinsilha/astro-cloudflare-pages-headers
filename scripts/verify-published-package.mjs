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
  const manifest = {
    name: "astro-published-package-smoke",
    private: true,
    type: "module",
    packageManager: "pnpm@10.29.3",
    dependencies: {
      astro: "7.3.5",
      "@astrojs/cloudflare": "14.3.3",
      [packageName]: packageName + "@" + version,
    },
    devDependencies: { typescript: "5.9.3", wrangler: "4.144.0" },
  };
  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const install = run("pnpm", ["install", "--no-frozen-lockfile"], {
    env: { FIXTURE_PACKAGE_VERSION: version },
  });
  const resolved = run("pnpm", ["list", "--depth=0", "--json"], {
    capture: true,
  });
  const packages = JSON.parse(resolved);
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
        installCompleted: Boolean(install),
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
