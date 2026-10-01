import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addReleaseChannel,
  getReleaseChannel,
  inspectReleaseTarball,
  publishExactArtifact,
  verifyReleaseEvidence,
} from "./semantic-release-exact-artifact.mjs";

const credentials = {
  NPM_TOKEN: "test-npm-token",
  CLOUDFLARE_API_TOKEN: "test-cloudflare-token",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  CF_TEST_PAGES_PROJECT: "astro-cloudflare-headers-canary",
};
const matrix = [{ astro: "4.0.0" }, { astro: "7.3.5" }];

async function setup() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "astro-release-plugin-"));
  const packageRoot = path.join(cwd, "package");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "astro-cloudflare-pages-headers",
      version: "1.2.3",
    }),
  );
  const tarballPath = path.join(
    cwd,
    "astro-cloudflare-pages-headers-1.2.3.tgz",
  );
  execFileSync("tar", ["-czf", tarballPath, "-C", cwd, "package"]);

  const evidenceRoot = path.join(cwd, ".release-evidence");
  await fs.mkdir(path.join(evidenceRoot, "coverage-report"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(evidenceRoot, "coverage-report", "coverage-summary.json"),
    JSON.stringify({
      total: {
        statements: { pct: 96 },
        lines: { pct: 96 },
        functions: { pct: 100 },
        branches: { pct: 92 },
      },
    }),
  );
  for (const row of matrix) {
    const directory = path.join(
      evidenceRoot,
      "compatibility-" + row.astro + "-reports",
      "test-results",
      "compatibility",
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, row.astro + "-run.log"),
      "exit=0 signal=none\n",
    );
  }
  return { cwd, tarballPath, evidenceRoot };
}

test("selects semantic-release dist channels for prerelease and stable releases", () => {
  assert.equal(getReleaseChannel({ channel: "dev" }), "dev");
  assert.equal(getReleaseChannel({ channel: undefined }), "latest");
});

test("rejects missing tarballs, checksum mismatches, and missing compatibility evidence", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.cwd, { recursive: true, force: true }));
  await assert.rejects(
    inspectReleaseTarball({ version: "1.2.3" }),
    /did not provide a tarball path/,
  );
  await assert.rejects(
    inspectReleaseTarball({
      tarballPath: fixture.tarballPath + ".missing",
      version: "1.2.3",
    }),
    /tarball is missing/,
  );
  await assert.rejects(
    inspectReleaseTarball({
      tarballPath: fixture.tarballPath,
      version: "1.2.3",
      expectedSha256: "wrong",
    }),
    /SHA-256 mismatch/,
  );
  const evidence = await fs.readFile(
    path.join(fixture.evidenceRoot, "coverage-report", "coverage-summary.json"),
    "utf8",
  );
  await fs.rm(path.join(fixture.evidenceRoot, "compatibility-4.0.0-reports"), {
    recursive: true,
  });
  await assert.rejects(
    verifyReleaseEvidence(fixture.evidenceRoot, matrix),
    /Compatibility evidence is missing for Astro 4.0.0/,
  );
  await fs.writeFile(
    path.join(fixture.evidenceRoot, "coverage-report", "coverage-summary.json"),
    evidence,
  );
});

test("checks tarball package name and version before publication", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.cwd, { recursive: true, force: true }));
  await assert.rejects(
    inspectReleaseTarball({
      tarballPath: fixture.tarballPath,
      version: "1.2.4",
    }),
    /does not match semantic-release version/,
  );
});

test("canaries and publishes the exact candidate file with scripts disabled and the dev tag", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.cwd, { recursive: true, force: true }));
  const order = [];
  const candidate = await inspectReleaseTarball({
    tarballPath: fixture.tarballPath,
    version: "1.2.3",
  });
  const result = await publishExactArtifact({
    ...fixture,
    version: "1.2.3",
    channel: "dev",
    env: credentials,
    matrix,
    runCanaries: async (candidatePath) => {
      assert.equal(candidatePath, fixture.tarballPath);
      order.push("canary");
    },
    commandRunner: async (command, args) => {
      assert.equal(command, "npm");
      order.push(args[0]);
      if (args[0] === "view") return JSON.stringify(candidate.integrity);
      assert.equal(args[0], "publish");
      assert.equal(args[1], fixture.tarballPath);
      assert.ok(args.includes("--ignore-scripts"));
      assert.ok(
        args.includes("--tag") && args[args.indexOf("--tag") + 1] === "dev",
      );
      return "";
    },
  });
  assert.deepEqual(order, ["canary", "publish", "view"]);
  assert.equal(result.version, "1.2.3");
  assert.equal(result.channel, "dev");
  const evidence = JSON.parse(
    await fs.readFile(
      path.join(fixture.cwd, ".release-artifacts", "release-evidence.json"),
      "utf8",
    ),
  );
  assert.equal(evidence.published, true);
  assert.equal(evidence.sha256, result.sha256);
  assert.ok(evidence.stages.includes("cloudflare-canaries-passed"));
});

test("blocks when evidence is missing before running canaries or publishing", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.cwd, { recursive: true, force: true }));
  let called = false;
  await fs.rm(
    path.join(fixture.evidenceRoot, "coverage-report", "coverage-summary.json"),
  );
  await assert.rejects(
    publishExactArtifact({
      ...fixture,
      version: "1.2.3",
      channel: "latest",
      env: credentials,
      matrix,
      runCanaries: async () => {
        called = true;
      },
      commandRunner: async () => {
        called = true;
      },
    }),
    /coverage evidence is missing/,
  );
  assert.equal(called, false);
});

test("does not convert npm authentication errors into successful publication", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.cwd, { recursive: true, force: true }));
  const commands = [];
  await assert.rejects(
    publishExactArtifact({
      ...fixture,
      version: "1.2.3",
      channel: "latest",
      env: credentials,
      matrix,
      runCanaries: async () => {},
      commandRunner: async (command, args) => {
        commands.push(args[0]);
        if (args[0] === "publish")
          throw Object.assign(new Error("E401 authentication failed"), {
            code: "E401",
          });
        throw new Error("registry read authentication failed");
      },
    }),
    /registry state could not be verified/,
  );
  assert.deepEqual(commands, ["publish", "view"]);
  assert.equal(commands.includes("unpublish"), false);
});

test("recovers a duplicate version only when npm reports the exact tarball integrity", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.cwd, { recursive: true, force: true }));
  const candidate = await inspectReleaseTarball({
    tarballPath: fixture.tarballPath,
    version: "1.2.3",
  });
  const commands = [];
  const result = await publishExactArtifact({
    ...fixture,
    version: "1.2.3",
    channel: "latest",
    env: credentials,
    matrix,
    runCanaries: async () => {},
    commandRunner: async (_command, args) => {
      commands.push(args[0]);
      if (args[0] === "publish")
        throw new Error("cannot publish over existing version");
      return JSON.stringify(candidate.integrity);
    },
  });
  assert.equal(result.recoveredDuplicate, true);
  assert.deepEqual(commands, ["publish", "view", "view"]);
  assert.equal(commands.includes("unpublish"), false);
});

test("records post-publication smoke failures without unpublishing", async (context) => {
  const fixture = await setup();
  context.after(() => fs.rm(fixture.cwd, { recursive: true, force: true }));
  const candidate = await inspectReleaseTarball({
    tarballPath: fixture.tarballPath,
    version: "1.2.3",
  });
  const commands = [];
  await assert.rejects(
    publishExactArtifact({
      ...fixture,
      version: "1.2.3",
      channel: "latest",
      env: credentials,
      matrix,
      runCanaries: async () => {},
      postPublishSmoke: async () => {
        throw new Error("consumer smoke injected failure");
      },
      commandRunner: async (_command, args) => {
        commands.push(args[0]);
        return args[0] === "view" ? JSON.stringify(candidate.integrity) : "";
      },
    }),
    /published, but release verification failed afterward/,
  );
  assert.deepEqual(commands, ["publish", "view"]);
  assert.equal(commands.includes("unpublish"), false);
  const report = JSON.parse(
    await fs.readFile(
      path.join(fixture.cwd, ".release-artifacts", "release-evidence.json"),
      "utf8",
    ),
  );
  assert.equal(report.published, true);
  assert.equal(report.postPublicationVerification, "failed");
});

test("adds a stable dist tag with the same registry authentication", async () => {
  const calls = [];
  const result = await addReleaseChannel({
    name: "astro-cloudflare-pages-headers",
    version: "1.2.3",
    channel: "latest",
    env: credentials,
    cwd: process.cwd(),
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, options });
    },
  });
  assert.deepEqual(calls[0].args.slice(0, 4), [
    "dist-tag",
    "add",
    "astro-cloudflare-pages-headers@1.2.3",
    "latest",
  ]);
  assert.equal(calls[0].options.env.NODE_AUTH_TOKEN, credentials.NPM_TOKEN);
  assert.equal(result.channel, "latest");
});
