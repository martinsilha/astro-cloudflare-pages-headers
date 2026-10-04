import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "astro-cloudflare-pages-headers";
const REQUIRED_CLOUD_ENV = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_TEST_PAGES_PROJECT",
];

export function getReleaseChannel(nextRelease) {
  return nextRelease.channel || "latest";
}

export function assertReleaseCredentials(env) {
  const missing = ["NPM_TOKEN", ...REQUIRED_CLOUD_ENV].filter(
    (name) => !env[name],
  );
  if (missing.length)
    throw new Error(
      "Release is blocked because required credentials/configuration are missing: " +
        missing.join(", ") +
        ".",
    );
}

export async function inspectReleaseTarball({
  tarballPath,
  version,
  expectedSha256,
}) {
  if (!tarballPath)
    throw new Error(
      "The semantic-release npm prepare hook did not provide a tarball path.",
    );
  const absolutePath = path.resolve(tarballPath);
  let archive;
  try {
    archive = await fs.readFile(absolutePath);
  } catch (error) {
    throw new Error(
      "Release candidate tarball is missing at " + absolutePath + ".",
      { cause: error },
    );
  }
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new Error(
      "Release candidate SHA-256 mismatch: expected " +
        expectedSha256 +
        ", received " +
        sha256 +
        ".",
    );
  }
  let metadata;
  try {
    const result = await execFileAsync(
      "tar",
      ["-xOzf", absolutePath, "package/package.json"],
      { maxBuffer: 1024 * 1024 },
    );
    metadata = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      "Could not read package/package.json from release candidate tarball.",
      { cause: error },
    );
  }
  if (metadata.name !== PACKAGE_NAME)
    throw new Error(
      "Release candidate has unexpected package name " +
        String(metadata.name) +
        ".",
    );
  if (metadata.version !== version)
    throw new Error(
      "Release candidate version " +
        String(metadata.version) +
        " does not match semantic-release version " +
        version +
        ".",
    );
  return {
    path: absolutePath,
    name: metadata.name,
    version: metadata.version,
    sha256,
    integrity:
      "sha512-" + createHash("sha512").update(archive).digest("base64"),
  };
}

export async function verifyReleaseEvidence(evidenceRoot, matrix) {
  const coveragePath = path.join(
    evidenceRoot,
    "coverage-report",
    "coverage-summary.json",
  );
  let summary;
  try {
    summary = JSON.parse(await fs.readFile(coveragePath, "utf8"));
  } catch (error) {
    throw new Error(
      "Required passing coverage evidence is missing at " + coveragePath + ".",
      { cause: error },
    );
  }
  const total = summary.total;
  if (
    !total ||
    total.statements.pct < 95 ||
    total.lines.pct < 95 ||
    total.functions.pct < 95 ||
    total.branches.pct < 90
  ) {
    throw new Error(
      "Downloaded coverage evidence does not meet the global release thresholds.",
    );
  }

  const runs = [];
  for (const row of matrix) {
    const directory = path.join(
      evidenceRoot,
      "compatibility-" + row.astro + "-reports",
      "test-results",
      "compatibility",
    );
    let logs;
    try {
      logs = (await fs.readdir(directory)).filter((name) =>
        name.endsWith(".log"),
      );
    } catch (error) {
      throw new Error(
        "Compatibility evidence is missing for Astro " + row.astro + ".",
        { cause: error },
      );
    }
    if (logs.length !== 1)
      throw new Error(
        "Expected exactly one compatibility log for Astro " +
          row.astro +
          ", found " +
          logs.length +
          ".",
      );
    const content = await fs.readFile(path.join(directory, logs[0]), "utf8");
    if (!/exit=0 signal=none/.test(content))
      throw new Error(
        "Astro " +
          row.astro +
          " compatibility evidence does not show a clean first-attempt pass.",
      );
    runs.push({ astro: row.astro, log: path.join(directory, logs[0]) });
  }
  return { coveragePath, runs };
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    return result.stdout.trim();
  } catch (error) {
    const output = [error.stdout, error.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    const failure = new Error(
      command +
        " " +
        args.join(" ") +
        " failed" +
        (output ? ":\n" + output : "."),
      { cause: error },
    );
    failure.code = error.code;
    failure.output = output;
    throw failure;
  }
}

async function existingRegistryIntegrity(
  name,
  version,
  env,
  cwd,
  commandRunner,
) {
  const output = await commandRunner(
    "npm",
    [
      "view",
      name + "@" + version,
      "dist.integrity",
      "--json",
      "--registry=https://registry.npmjs.org/",
    ],
    {
      cwd,
      env: { ...env, NODE_AUTH_TOKEN: env.NPM_TOKEN },
    },
  );
  return output.replace(/^"|"$/g, "");
}

export async function publishExactArtifact({
  tarballPath,
  version,
  channel,
  env,
  cwd,
  evidenceRoot,
  matrix,
  expectedSha256,
  runCanaries,
  postPublishSmoke = async () => {},
  commandRunner = run,
}) {
  assertReleaseCredentials(env);
  const evidence = await verifyReleaseEvidence(evidenceRoot, matrix);
  const candidate = await inspectReleaseTarball({
    tarballPath,
    version,
    expectedSha256,
  });
  const evidenceDirectory = path.join(cwd, ".release-artifacts");
  await fs.mkdir(evidenceDirectory, { recursive: true });
  const reportPath = path.join(evidenceDirectory, "release-evidence.json");
  const report = {
    package: candidate.name,
    version: candidate.version,
    channel,
    tarball: path.relative(cwd, candidate.path),
    sha256: candidate.sha256,
    integrity: candidate.integrity,
    coverageEvidence: path.relative(cwd, evidence.coveragePath),
    compatibilityRows: evidence.runs.map(({ astro }) => astro),
    stages: ["candidate-validated"],
    published: false,
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

  await runCanaries(candidate.path, {
    version,
    channel,
    env,
    cwd,
    evidenceRoot,
  });
  report.stages.push("cloudflare-canaries-passed");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

  const publishArgs = [
    "publish",
    candidate.path,
    "--ignore-scripts",
    "--provenance",
    "--access",
    "public",
    "--tag",
    channel,
    "--registry=https://registry.npmjs.org/",
  ];
  const publishEnv = { ...env, NODE_AUTH_TOKEN: env.NPM_TOKEN };
  let recoveredDuplicate = false;
  try {
    await commandRunner("npm", publishArgs, { cwd, env: publishEnv });
  } catch (publishError) {
    let remoteIntegrity;
    try {
      remoteIntegrity = await existingRegistryIntegrity(
        candidate.name,
        version,
        publishEnv,
        cwd,
        commandRunner,
      );
    } catch (registryError) {
      throw new Error(
        "npm publication failed and registry state could not be verified. The package may have been published; do not unpublish automatically.",
        { cause: registryError },
      );
    }
    if (remoteIntegrity !== candidate.integrity) {
      throw new Error(
        "npm publication failed and registry contains no identical candidate. The package may have been published; do not unpublish automatically.",
        { cause: publishError },
      );
    }
    recoveredDuplicate = true;
  }

  report.stages.push(
    recoveredDuplicate ? "identical-registry-version-recovered" : "published",
  );
  report.published = true;
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  try {
    const registryIntegrity = await existingRegistryIntegrity(
      candidate.name,
      version,
      publishEnv,
      cwd,
      commandRunner,
    );
    if (registryIntegrity !== candidate.integrity)
      throw new Error(
        "Published registry integrity does not match the release tarball.",
      );
    await postPublishSmoke(candidate.name, version);
    report.stages.push("registry-integrity-and-consumer-smoke-passed");
    report.postPublicationVerification = "passed";
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    report.postPublicationVerification = "failed";
    report.postPublicationError = error.message;
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    throw new Error(
      "The package was published, but release verification failed afterward. Do not unpublish automatically.",
      { cause: error },
    );
  }
  return {
    name: candidate.name,
    version: candidate.version,
    channel,
    integrity: candidate.integrity,
    sha256: candidate.sha256,
    recoveredDuplicate,
  };
}

export async function addReleaseChannel({
  name,
  version,
  channel,
  env,
  cwd,
  commandRunner = run,
}) {
  assertReleaseCredentials(env);
  await commandRunner(
    "npm",
    [
      "dist-tag",
      "add",
      name + "@" + version,
      channel,
      "--registry=https://registry.npmjs.org/",
    ],
    {
      cwd,
      env: { ...env, NODE_AUTH_TOKEN: env.NPM_TOKEN },
    },
  );
  return { name, version, channel };
}

export async function verifyConditions(_pluginConfig, context) {
  assertReleaseCredentials(context.env);
}

export async function publish(pluginConfig, context) {
  const matrixPath = path.resolve(
    context.cwd,
    pluginConfig.matrixPath ??
      "fixtures/astro-consumer/compatibility-matrix.json",
  );
  const matrix = JSON.parse(await fs.readFile(matrixPath, "utf8"));
  const version = context.nextRelease.version;
  const tarballName = PACKAGE_NAME + "-" + version + ".tgz";
  const tarballPath = path.resolve(
    context.cwd,
    pluginConfig.tarballDir ?? ".release-artifacts",
    tarballName,
  );
  const evidenceRoot = path.resolve(
    context.cwd,
    pluginConfig.evidenceRoot ?? ".release-evidence",
  );

  return publishExactArtifact({
    tarballPath,
    version,
    channel: getReleaseChannel(context.nextRelease),
    env: context.env,
    cwd: context.cwd,
    evidenceRoot,
    matrix,
    expectedSha256: context.env.RELEASE_EXPECTED_SHA256,
    runCanaries: async (artifactPath) => {
      await run(
        "node",
        ["scripts/run-release-candidate-matrix.mjs", artifactPath],
        {
          cwd: context.cwd,
          env: context.env,
        },
      );
    },
    postPublishSmoke: async (_name, version) => {
      await run("node", ["scripts/verify-published-package.mjs", version], {
        cwd: context.cwd,
        env: context.env,
      });
    },
  });
}

export async function addChannel(pluginConfig, context) {
  return addReleaseChannel({
    name: context.nextRelease.name ?? PACKAGE_NAME,
    version: context.nextRelease.version,
    channel: getReleaseChannel(context.nextRelease),
    env: context.env,
    cwd: context.cwd,
  });
}
