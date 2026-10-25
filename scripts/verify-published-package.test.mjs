import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));

test("published consumer CLI installs the exact version and records successful inherited-stdio install", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "published-consumer-test-"));
  try {
    const scripts = path.join(root, "scripts");
    const bin = path.join(root, "bin");
    await fs.mkdir(scripts);
    await fs.mkdir(bin);
    await fs.mkdir(path.join(root, "fixtures", "astro-consumer"), { recursive: true });
    for (const name of ["verify-published-package.mjs", "published-consumer-manifest.mjs"]) {
      await fs.copyFile(path.join(scriptsRoot, name), path.join(scripts, name));
    }
    const locks = path.join(root, "fixtures", "astro-consumer", "locks");
    await fs.mkdir(locks);
    await fs.copyFile(path.join(scriptsRoot, "..", "fixtures", "astro-consumer", "locks", "astro-7.3.5.yaml"), path.join(locks, "astro-7.3.5.yaml"));
    const manifestPath = path.join(root, "observed-manifest.json");
    const commandsPath = path.join(root, "commands.jsonl");
    const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_COMMANDS, JSON.stringify({ command: path.basename(process.argv[1]), args }) + '\\n');
if (args[0] === 'install') {
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (manifest.dependencies['astro-cloudflare-pages-headers'] !== process.env.FIXTURE_PACKAGE_VERSION) process.exit(41);
  fs.writeFileSync(process.env.TEST_MANIFEST, JSON.stringify(manifest));
  const workspace = fs.readFileSync('pnpm-workspace.yaml', 'utf8');
  if (!workspace.includes('esbuild: true') || !workspace.includes('workerd: true')) process.exit(42);
  if (args.includes('--lockfile-only')) {
    const lock = fs.readFileSync('pnpm-lock.yaml', 'utf8').replaceAll('file:./astro-cloudflare-pages-headers.tgz', process.env.FIXTURE_PACKAGE_VERSION).replaceAll('file:astro-cloudflare-pages-headers.tgz', process.env.FIXTURE_PACKAGE_VERSION);
    fs.writeFileSync('pnpm-lock.yaml', lock);
  }
}
if (args[0] === 'list') process.stdout.write(JSON.stringify([{ dependencies: { 'astro-cloudflare-pages-headers': { version: '1.8.0-dev.1' } } }]));
`;
    for (const command of ["pnpm", "node"]) {
      await fs.writeFile(path.join(bin, command), stub, { mode: 0o755 });
    }
    const result = spawnSync(process.execPath, [path.join(scripts, "verify-published-package.mjs"), "1.8.0-dev.1"], {
      cwd: root,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEST_MANIFEST: manifestPath, TEST_COMMANDS: commandsPath },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.equal(manifest.dependencies["astro-cloudflare-pages-headers"], "1.8.0-dev.1");
    const report = JSON.parse(await fs.readFile(path.join(root, ".release-artifacts", "published-consumer-report.json"), "utf8"));
    assert.equal(report.installCompleted, true);
    assert.equal(report.toolchainFrozen, true);
    assert.equal(report.version, "1.8.0-dev.1");
    assert.equal(report.resolved[0].dependencies["astro-cloudflare-pages-headers"].version, "1.8.0-dev.1");
    const commands = (await fs.readFile(commandsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(commands.map(({ args }) => args), [
      ["install", "--lockfile-only", "--no-frozen-lockfile"],
      ["install", "--frozen-lockfile"],
      ["list", "--depth=0", "--json"],
      ["exec", "tsc", "-p", "tsconfig.json"],
      ["exec", "tsc", "-p", "tsconfig.nodenext.json"],
      ["exec", "astro", "build"],
      ["scripts-smoke-output.mjs"],
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
