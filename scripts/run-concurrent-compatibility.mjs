import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureRoot = path.join(repositoryRoot, "fixtures", "astro-consumer");
const matrix = JSON.parse(
  await fs.readFile(
    path.join(fixtureRoot, "compatibility-matrix.json"),
    "utf8",
  ),
);
const row = matrix[0];
const tarball = path.resolve(process.env.FIXTURE_PACKAGE_TARBALL ?? "");
if (!process.env.FIXTURE_PACKAGE_TARBALL)
  throw new Error(
    "FIXTURE_PACKAGE_TARBALL is required for the concurrent isolation proof.",
  );
const testId = randomUUID();
const excluded = new Set([
  "node_modules",
  ".astro",
  ".wrangler",
  ".packed",
  "coverage",
  "test-results",
]);
const snapshot = async (directory, relative = "") => {
  const rows = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (
      excluded.has(entry.name) ||
      entry.name.startsWith("output ") ||
      entry.name.endsWith(".tgz")
    )
      continue;
    const absolute = path.join(directory, entry.name);
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) rows.push(...(await snapshot(absolute, name)));
    else if (entry.isFile())
      rows.push([
        name,
        createHash("sha256")
          .update(await fs.readFile(absolute))
          .digest("hex"),
      ]);
  }
  return rows;
};
const before = JSON.stringify(
  (await snapshot(fixtureRoot)).sort(([a], [b]) => a.localeCompare(b)),
);

async function run(index) {
  const runId = "parallel-" + testId + "-" + index;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "run-isolated-compatibility.mjs")],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          FIXTURE_ASTRO_VERSION: row.astro,
          FIXTURE_ADAPTER_VERSION: row.adapter,
          FIXTURE_WRANGLER_VERSION: row.wrangler,
          FIXTURE_PACKAGE_TARBALL: tarball,
          FIXTURE_RUN_ID: runId,
        },
        stdio: "inherit",
        detached: process.platform !== "win32",
      },
    );
    const timer = setTimeout(
      () => {
        if (process.platform === "win32")
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
          }).unref();
        else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
      },
      30 * 60 * 1000,
    );
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(runId);
      else
        reject(
          new Error(
            "Concurrent compatibility run failed with code=" +
              code +
              " signal=" +
              signal +
              ".",
          ),
        );
    });
  });
}

const runs = await Promise.all([run(1), run(2)]);
const after = JSON.stringify(
  (await snapshot(fixtureRoot)).sort(([a], [b]) => a.localeCompare(b)),
);
if (before !== after)
  throw new Error(
    "Concurrent compatibility runs changed tracked or source fixture files.",
  );
const leaseRoot = path.join(os.tmpdir(), "astro-headers-port-leases");
for (const runId of runs) {
  const leftovers = [];
  try {
    for (const name of await fs.readdir(leaseRoot)) {
      const value = await fs.readFile(path.join(leaseRoot, name), "utf8");
      if (value.includes(runId)) leftovers.push(name);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (leftovers.length)
    throw new Error(
      "Concurrent compatibility run left port leases behind: " +
        leftovers.join(", "),
    );
  const matchingDirectories = (await fs.readdir(os.tmpdir())).filter((name) =>
    name.startsWith("astro-headers-" + runId + "-"),
  );
  if (matchingDirectories.length)
    throw new Error(
      "Concurrent compatibility run left temporary workspaces behind: " +
        matchingDirectories.join(", "),
    );
}
process.stdout.write(
  "Two concurrent compatibility suites passed; fixture source, temporary workspaces, and owned port leases are clean.\n",
);
