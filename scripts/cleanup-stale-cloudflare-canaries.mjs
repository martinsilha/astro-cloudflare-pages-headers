import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANARY_RESOURCE_MAX_AGE_MS,
  isStaleCanary,
  kvCanaryCreatedAt,
  pagesCanaryCreatedAt,
  workerCanaryCreatedAt,
} from "./cloudflare-canary-utils.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const projectName = process.env.CF_TEST_PAGES_PROJECT;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const now = Date.now();
const reportDirectory = path.join(repositoryRoot, "test-results", "cloudflare");
const reportPath = path.join(
  reportDirectory,
  "stale-cleanup-" + new Date(now).toISOString().replaceAll(":", "-") + ".json",
);
const report = {
  accountId,
  projectName,
  generatedAt: new Date(now).toISOString(),
  maxAgeHours: 24,
  examined: [],
  deleted: [],
  alreadyGone: [],
  errors: [],
};

if (!apiToken || !accountId || !projectName)
  throw new Error(
    "Stale Cloudflare cleanup requires API token, account ID, and dedicated Pages project.",
  );
if (!/^astro-cloudflare-headers-canary[a-z0-9-]*$/i.test(projectName))
  throw new Error(
    "Refusing stale cleanup outside the dedicated Astro canary Pages project.",
  );

async function api(method, resource) {
  const url = new URL("https://api.cloudflare.com/client/v4" + resource);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + apiToken,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(20000),
  });
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      "Cloudflare API returned invalid JSON for " + method + " " + url.pathname,
      { cause: error },
    );
  }
  if (response.status === 404 && method === "DELETE") return { missing: true };
  if (!response.ok || payload.success === false) {
    throw new Error(
      "Cloudflare API " +
        method +
        " " +
        url.pathname +
        " failed (" +
        response.status +
        "): " +
        JSON.stringify(payload.errors ?? payload),
    );
  }
  return payload;
}

async function listPages(resource, perPage = 100) {
  const result = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL("https://api.cloudflare.com/client/v4" + resource);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));
    const response = await fetch(url, {
      headers: {
        Authorization: "Bearer " + apiToken,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(
        "Cloudflare API returned invalid JSON for GET " + url.pathname,
        { cause: error },
      );
    }
    if (
      !response.ok ||
      payload.success === false ||
      !Array.isArray(payload.result)
    ) {
      throw new Error(
        "Cloudflare API GET " +
          url.pathname +
          " failed (" +
          response.status +
          "): " +
          JSON.stringify(payload.errors ?? payload),
      );
    }
    result.push(...payload.result);
    const totalPages = payload.result_info?.total_pages;
    if (
      totalPages !== undefined
        ? page >= totalPages
        : payload.result.length < perPage
    )
      return result;
  }
  throw new Error(
    "Cloudflare API pagination exceeded the 100-page safety limit for " +
      resource +
      ".",
  );
}

async function remove(type, resource, label) {
  try {
    const result = await api("DELETE", resource);
    (result.missing ? report.alreadyGone : report.deleted).push({
      type,
      label,
    });
  } catch (error) {
    report.errors.push({ type, label, error: error.message });
  }
}

try {
  const workerRows = await listPages(
    "/accounts/" + encodeURIComponent(accountId) + "/workers/scripts",
  );
  for (const worker of workerRows) {
    const name = worker.id ?? worker.name;
    if (
      typeof name !== "string" ||
      !name.startsWith("astro-headers-canary-worker-")
    )
      continue;
    const createdAt = workerCanaryCreatedAt(name);
    report.examined.push({
      type: "worker",
      name,
      createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    });
    if (isStaleCanary(createdAt, now))
      await remove(
        "worker",
        "/accounts/" +
          encodeURIComponent(accountId) +
          "/workers/scripts/" +
          encodeURIComponent(name),
        name,
      );
  }

  const namespaceRows = await listPages(
    "/accounts/" + encodeURIComponent(accountId) + "/storage/kv/namespaces",
    1000,
  );
  for (const namespace of namespaceRows) {
    if (
      typeof namespace.title !== "string" ||
      !namespace.title.startsWith("astro-headers-canary-session-")
    )
      continue;
    const createdAt = kvCanaryCreatedAt(namespace.title);
    report.examined.push({
      type: "kv",
      name: namespace.title,
      id: namespace.id,
      createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    });
    if (namespace.id && isStaleCanary(createdAt, now)) {
      await remove(
        "kv",
        "/accounts/" +
          encodeURIComponent(accountId) +
          "/storage/kv/namespaces/" +
          encodeURIComponent(namespace.id),
        namespace.title,
      );
    }
  }

  const deploymentRows = await listPages(
    "/accounts/" +
      encodeURIComponent(accountId) +
      "/pages/projects/" +
      encodeURIComponent(projectName) +
      "/deployments?env=preview",
  );
  for (const deployment of deploymentRows) {
    const branch =
      deployment.deployment_trigger?.metadata?.branch ?? deployment.branch;
    if (typeof branch !== "string" || !branch.startsWith("canary-")) continue;
    const createdAt = pagesCanaryCreatedAt(branch);
    report.examined.push({
      type: "pages-preview",
      branch,
      id: deployment.id,
      createdAt: createdAt ? new Date(createdAt).toISOString() : null,
    });
    if (deployment.id && isStaleCanary(createdAt, now)) {
      await remove(
        "pages-preview",
        "/accounts/" +
          encodeURIComponent(accountId) +
          "/pages/projects/" +
          encodeURIComponent(projectName) +
          "/deployments/" +
          encodeURIComponent(deployment.id),
        branch,
      );
    }
  }
} catch (error) {
  report.errors.push({ type: "inventory", error: error.message });
} finally {
  await fs.mkdir(reportDirectory, { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}

if (report.errors.length)
  throw new Error(
    "Stale Cloudflare canary cleanup failed; see " + reportPath + ".",
  );
process.stdout.write(
  "Stale Cloudflare cleanup passed: examined " +
    report.examined.length +
    ", deleted " +
    report.deleted.length +
    ", already gone " +
    report.alreadyGone.length +
    ". Evidence: " +
    reportPath +
    "\n",
);
