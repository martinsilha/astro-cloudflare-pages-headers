import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot =
  process.env.FIXTURE_REPOSITORY_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = process.env.FIXTURE_WORKSPACE_ROOT ?? process.cwd();
const wrangler = path.join(
  fixtureRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const projectName = process.env.CF_TEST_PAGES_PROJECT;
const runId = process.env.FIXTURE_CANARY_RUN_ID;
const major = process.env.FIXTURE_ASTRO_MAJOR;
const version = process.env.FIXTURE_ASTRO_VERSION;
const target = process.argv[2];
const resourcePrefix = "astro-headers-canary-";
const recordDirectory =
  process.env.TEST_RESULTS_DIR ??
  path.join(repositoryRoot, "test-results", "cloudflare");
const recordPath = path.join(
  recordDirectory,
  "resource-" +
    (runId ?? "unidentified") +
    "-" +
    (major ?? "unknown") +
    "-" +
    (target ?? "unknown") +
    ".json",
);
const resources = {
  runId,
  major,
  version,
  target,
  accountId,
  created: [],
  deleted: [],
  status: "running",
};
let primaryError;

if (
  !accountId ||
  !runId ||
  !major ||
  !version ||
  !["worker", "pages"].includes(target)
) {
  throw new Error(
    "Cloudflare canary requires account, fixture, run, and target values.",
  );
}
if (target === "pages" && !projectName)
  throw new Error(
    "CF_TEST_PAGES_PROJECT must name the dedicated Pages test project.",
  );

await fs.mkdir(recordDirectory, { recursive: true });
await writeRecord();

function writeRecord() {
  return fs.writeFile(recordPath, JSON.stringify(resources, null, 2) + "\n");
}

function wranglerCommand(args, cwd = "/tmp") {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd,
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      WRANGLER_SEND_METRICS: "false",
    },
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      "wrangler " +
        args.join(" ") +
        " failed with " +
        result.status +
        ":\n" +
        output,
    );
  return output;
}

function workerName() {
  return (
    resourcePrefix +
    "worker-" +
    major +
    "-" +
    Date.now().toString(36) +
    "-" +
    runId.replace(/[^a-z0-9-]/gi, "").slice(0, 8)
  );
}

function responseEvidence(response) {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

async function runPlaywright(origin, staticPages = false) {
  const projects = process.env.PLAYWRIGHT_PROJECTS ?? "chromium";
  const browserArgs = [
    "--dir",
    repositoryRoot,
    "exec",
    "playwright",
    "test",
    "--config",
    path.join(repositoryRoot, "playwright.config.ts"),
  ];
  if (process.env.PLAYWRIGHT_REPEAT)
    browserArgs.push("--repeat-each=" + process.env.PLAYWRIGHT_REPEAT);
  const result = spawnSync("pnpm", browserArgs, {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_BASE_URL: origin,
      PLAYWRIGHT_PROJECTS: projects,
      PLAYWRIGHT_STATIC_PAGES: String(staticPages),
      PLAYWRIGHT_NATIVE_CSP: String(process.env.FIXTURE_NATIVE_CSP === "true"),
    },
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  process.stdout.write(output);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("Deployed CSP browser checks failed at " + origin + ".");
}

async function checkWorker(origin) {
  const routePaths = ["/docs/", "/docs/index.html", "/"];
  const probes = await Promise.all(
    routePaths.map(async (route) => {
      const response = await fetch(new URL(route, origin), {
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(15000),
      });
      return { route, response };
    }),
  );
  const pageProbe = probes[0];
  const page = pageProbe.response;
  if (
    page.status !== 200 ||
    page.headers.get("x-fixture-header") !== "astro-" + major
  ) {
    const body = (await page.text()).slice(0, 2400);
    const statuses = probes
      .map(
        ({ route, response }) =>
          route +
          "=" +
          response.status +
          ":" +
          (response.headers.get("server") ?? "unknown"),
      )
      .join(", ");
    throw new Error(
      "Deployed Worker static route failed: " +
        statuses +
        ", x-fixture-header=" +
        page.headers.get("x-fixture-header") +
        ", content-type=" +
        page.headers.get("content-type") +
        ", body=" +
        body,
    );
  }
  const pageBody = await page.text();
  if (!pageBody.includes("Static route"))
    throw new Error("Deployed Worker static response body is unexpected.");
  const cspHeader = page.headers.get("content-security-policy") ?? "";
  const cspMetaTag = pageBody.match(
    /<meta\b(?=[^>]*http-equiv=["']content-security-policy["'])[^>]*>/i,
  )?.[0];
  const cspMeta = cspMetaTag?.match(/\bcontent=(["'])([\s\S]*?)\1/i)?.[2] ?? "";
  const csp = cspHeader || cspMeta;
  if (!csp.toLowerCase().includes("script-src") || !csp.includes("sha256-")) {
    resources.worker.httpAssertions = {
      staticPage: responseEvidence(page),
      bodyContainsNativeCspMeta: Boolean(cspMetaTag),
      observedCsp: csp,
    };
    await writeRecord();
    throw new Error(
      "Deployed Worker response is missing generated CSP script hashes in its response header or Astro CSP meta element.",
    );
  }

  const endpoint = await fetch(new URL("/docs/api.json", origin), {
    signal: AbortSignal.timeout(15000),
  });
  const endpointBody = await endpoint.text();
  if (
    endpoint.status !== 200 ||
    endpoint.headers.get("x-fixture-header") !== "astro-" + major ||
    endpointBody !== '{"ok":true}'
  ) {
    throw new Error(
      "Deployed Worker SSR endpoint failed its status, header, or body assertion.",
    );
  }
  const dynamic = await fetch(new URL("/docs/api-plain", origin), {
    signal: AbortSignal.timeout(15000),
  });
  const dynamicCsp = dynamic.headers.get("content-security-policy") ?? "";
  if (dynamic.status !== 200 || dynamicCsp.includes("sha256-"))
    throw new Error(
      "Deployed Worker SSR response inherited static CSP hashes.",
    );
  resources.worker.httpAssertions = {
    staticPage: {
      ...responseEvidence(page),
      cspSource: cspHeader ? "response-header" : "astro-native-meta",
      csp,
    },
    staticPageChecks: [
      "status=200",
      "x-fixture-header=astro-" + major,
      "generated script CSP hash present",
      "expected static fixture body present",
    ],
    ssrJson: { ...responseEvidence(endpoint), body: endpointBody },
    dynamicSsr: { ...responseEvidence(dynamic), cspHashesAbsent: true },
  };
  await writeRecord();
  await runPlaywright(origin);
}

async function deployWorker() {
  const unique =
    Date.now().toString(36) +
    "-" +
    runId.replace(/[^a-z0-9-]/gi, "").slice(0, 8);
  const name = resourcePrefix + "worker-" + major + "-" + unique;
  const sessionName =
    resourcePrefix + "session-" + major + "-" + Date.now() + "-" + unique;
  resources.worker = { name, sessionNamespaceName: sessionName };
  await writeRecord();

  wranglerCommand(["kv", "namespace", "create", sessionName]);
  const namespaceRows = JSON.parse(
    wranglerCommand(["kv", "namespace", "list"]),
  );
  const namespace = (
    Array.isArray(namespaceRows) ? namespaceRows : (namespaceRows.result ?? [])
  ).find((row) => row.title === sessionName);
  if (!namespace?.id)
    throw new Error(
      "Could not identify the newly created canary KV namespace by its unique title.",
    );
  const namespaceId = namespace.id;
  resources.worker.sessionNamespaceId = namespaceId;
  resources.created.push({ type: "kv", name: sessionName, id: namespaceId });
  await writeRecord();

  const outputRoot = path.join(fixtureRoot, "output " + major + "-workers");
  const configs = [];
  async function findConfig(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await findConfig(absolute);
      else if (/^wrangler\.jsonc?$/.test(entry.name)) configs.push(absolute);
    }
  }
  await findConfig(outputRoot);
  if (configs.length !== 1)
    throw new Error(
      "Expected exactly one generated Wrangler config for the Astro " +
        major +
        " Worker output.",
    );
  const originalConfigPath = configs[0];
  const config = JSON.parse(await fs.readFile(originalConfigPath, "utf8"));
  config.name = name;
  config.topLevelName = name;
  config.workers_dev = true;
  config.preview_urls = true;
  if (config.assets?.directory)
    config.assets.directory = path.resolve(
      path.dirname(originalConfigPath),
      config.assets.directory,
    );
  resources.worker.assetDirectory = config.assets?.directory;
  config.kv_namespaces = (config.kv_namespaces ?? []).map((binding) =>
    binding.binding === "SESSION" ? { ...binding, id: namespaceId } : binding,
  );
  if (config.previews?.kv_namespaces) {
    config.previews.kv_namespaces = config.previews.kv_namespaces.map(
      (binding) =>
        binding.binding === "SESSION"
          ? { ...binding, id: namespaceId }
          : binding,
    );
  }
  const configPath = originalConfigPath.replace(
    /\.jsonc?$/,
    ".canary-" + unique + ".json",
  );
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  resources.worker.config = configPath;
  await writeRecord();

  try {
    const deployment = wranglerCommand(
      [
        "deploy",
        "--config",
        configPath,
        "--name",
        name,
        "--message",
        "Astro compatibility canary " + version,
      ],
      fixtureRoot,
    );
    resources.worker.deployed = true;
    resources.worker.deployOutput = deployment.slice(-4000);
    resources.created.push({ type: "worker", name });
    resources.worker.url = deployment.match(
      /https:\/\/[a-z0-9.-]+\.workers\.dev/i,
    )?.[0];
    resources.worker.workersDevEnabled = config.workers_dev;
    resources.worker.previewUrlsEnabled = config.preview_urls;
    resources.worker.routeStabilizationWaitMs = 10000;
    resources.worker.generatedHeaders = await fs.readFile(
      path.join(config.assets.directory, "_headers"),
      "utf8",
    );
    await writeRecord();
    if (!resources.worker.url)
      throw new Error(
        "Wrangler did not report a workers.dev URL for " + name + ".",
      );
    process.stdout.write(
      "Waiting 10 seconds for the newly deployed workers.dev route to settle.\n",
    );
    await new Promise((resolve) =>
      setTimeout(resolve, resources.worker.routeStabilizationWaitMs),
    );
    await checkWorker(resources.worker.url);
    resources.status = "passed";
    await writeRecord();
  } finally {
    await fs.rm(configPath, { force: true });
  }
}

async function deploymentRows() {
  const output = wranglerCommand([
    "pages",
    "deployment",
    "list",
    "--project-name=" + projectName,
    "--environment=preview",
    "--json",
  ]);
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

function pagesDeploymentId(row) {
  return row.id ?? row.Id;
}

function pagesDeploymentBranch(row) {
  return row.branch ?? row.Branch ?? row.deployment_trigger?.metadata?.branch;
}

function pagesDeploymentUrl(row) {
  return row.url ?? row.deployment ?? row.Deployment;
}

function pagesDeploymentAliases(row) {
  return row.aliases ?? row.Aliases ?? [];
}

async function deployPages() {
  const unique =
    Date.now().toString(36) +
    "-" +
    runId.replace(/[^a-z0-9-]/gi, "").slice(0, 8);
  const branch =
    "canary-" +
    new Date().toISOString().slice(0, 10).replaceAll("-", "") +
    "-" +
    unique;
  resources.pages = {
    project: projectName,
    branch,
    routeStabilizationWaitMs: 10000,
  };
  await writeRecord();

  const staticOutput = path.join(fixtureRoot, "output " + major + "-pages");
  resources.pages.generatedHeaders = await fs.readFile(
    path.join(staticOutput, "_headers"),
    "utf8",
  );
  const deploymentOutput = path.join(
    fixtureRoot,
    "cloudflare-pages-canary-output",
  );
  const siteRoot = path.join(deploymentOutput, "docs");
  await fs.rm(deploymentOutput, { recursive: true, force: true });
  await fs.mkdir(siteRoot, { recursive: true });
  for (const entry of await fs.readdir(staticOutput, { withFileTypes: true })) {
    const source = path.join(staticOutput, entry.name);
    if (entry.name === "_headers" || entry.name === ".assetsignore") {
      await fs.copyFile(source, path.join(deploymentOutput, entry.name));
      continue;
    }
    await fs.cp(source, path.join(siteRoot, entry.name), { recursive: true });
  }
  resources.pages.deployDirectory = deploymentOutput;
  await writeRecord();
  const deployment = wranglerCommand([
    "pages",
    "deploy",
    deploymentOutput,
    "--project-name=" + projectName,
    "--branch=" + branch,
  ]);
  resources.pages.deployOutput = deployment.slice(-4000);
  resources.pages.url = deployment.match(
    /https:\/\/[a-z0-9.-]+\.pages\.dev/i,
  )?.[0];
  await writeRecord();
  if (!resources.pages.url)
    throw new Error("Wrangler did not report a pages.dev preview URL.");

  process.stdout.write(
    "Waiting 10 seconds for the new Pages preview to settle.\n",
  );
  await new Promise((resolve) =>
    setTimeout(resolve, resources.pages.routeStabilizationWaitMs),
  );
  const rows = await deploymentRows();
  const deploymentRow = rows.find(
    (row) => pagesDeploymentBranch(row) === branch,
  );
  const deploymentId = deploymentRow && pagesDeploymentId(deploymentRow);
  if (!deploymentId)
    throw new Error(
      "Could not identify the unique Pages preview deployment after upload.",
    );
  resources.pages.deploymentId = deploymentId;
  resources.created.push({
    type: "pages-deployment",
    id: deploymentId,
    branch,
  });
  await writeRecord();

  const response = await fetch(new URL("/docs/", resources.pages.url), {
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.text();
  resources.pages.httpAssertions = {
    staticPage: responseEvidence(response),
    bodyExcerpt: body.slice(0, 1000),
  };
  await writeRecord();
  if (
    response.status !== 200 ||
    response.headers.get("x-fixture-header") !== "astro-" + major
  ) {
    throw new Error(
      "Deployed Pages route failed its status or generated-header assertion.",
    );
  }
  if (!body.includes("Static route"))
    throw new Error("Deployed Pages HTML content is unexpected.");
  resources.pages.httpAssertions.staticPageChecks = [
    "status=200",
    "x-fixture-header=astro-" + major,
    "expected static fixture body present",
  ];
  await writeRecord();
  await runPlaywright(resources.pages.url, true);
  resources.status = "passed";
  await writeRecord();
}

async function cleanup() {
  const errors = [];
  if (resources.pages?.branch) {
    try {
      const rows = await deploymentRows();
      const deployment = rows.find((row) => {
        const aliases = pagesDeploymentAliases(row);
        return (
          pagesDeploymentId(row) === resources.pages.deploymentId ||
          pagesDeploymentUrl(row) === resources.pages.url ||
          pagesDeploymentBranch(row) === resources.pages.branch ||
          aliases.some((alias) => alias.startsWith(resources.pages.branch))
        );
      });
      const deploymentId =
        resources.pages.deploymentId ??
        (deployment && pagesDeploymentId(deployment));
      if (deploymentId) {
        wranglerCommand([
          "pages",
          "deployment",
          "delete",
          deploymentId,
          "--project-name=" + resources.pages.project,
          "--force",
        ]);
        resources.deleted.push({ type: "pages-deployment", id: deploymentId });
      } else {
        errors.push(
          "Could not identify the unique Pages preview deployment for cleanup.",
        );
      }
    } catch (error) {
      errors.push("Pages cleanup failed: " + error.message);
    }
  }
  if (resources.worker?.name) {
    try {
      wranglerCommand(["delete", resources.worker.name, "--force"]);
      resources.deleted.push({ type: "worker", name: resources.worker.name });
    } catch (error) {
      if (!/not found|does not exist/i.test(error.message))
        errors.push("Worker cleanup failed: " + error.message);
    }
  }
  if (resources.worker?.sessionNamespaceName) {
    try {
      let namespaceId = resources.worker.sessionNamespaceId;
      if (!namespaceId) {
        const output = wranglerCommand(["kv", "namespace", "list"]);
        const rows = JSON.parse(output);
        const namespaces = Array.isArray(rows) ? rows : (rows.result ?? []);
        namespaceId = namespaces.find(
          (row) => row.title === resources.worker.sessionNamespaceName,
        )?.id;
      }
      if (namespaceId) {
        wranglerCommand([
          "kv",
          "namespace",
          "delete",
          "--namespace-id=" + namespaceId,
          "--skip-confirmation",
        ]);
        resources.deleted.push({ type: "kv", id: namespaceId });
      }
    } catch (error) {
      errors.push("Canary session KV cleanup failed: " + error.message);
    }
  }
  resources.cleanupErrors = errors;
  resources.cleanup = errors.length ? "failed" : "passed";
  if (resources.status === "running") resources.status = "failed";
  await writeRecord();
  if (errors.length) throw new Error(errors.join("\n"));
}

try {
  if (target === "worker") await deployWorker();
  else await deployPages();
} catch (error) {
  primaryError = error;
  resources.error = error.message;
  resources.status = "failed";
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    if (!primaryError) primaryError = cleanupError;
    else
      primaryError = new Error(
        primaryError.message + "\n" + cleanupError.message,
        { cause: primaryError },
      );
  }
}

if (primaryError) throw primaryError;
process.stdout.write(
  "Cloudflare " +
    target +
    " canary passed and all per-run resources were deleted. Evidence: " +
    recordPath +
    "\n",
);
