import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const matrix = JSON.parse(
  await fs.readFile(
    path.join(
      repositoryRoot,
      "fixtures",
      "astro-consumer",
      "compatibility-matrix.json",
    ),
    "utf8",
  ),
);
const tarballPath = path.resolve(process.argv[2] ?? "");
if (!process.argv[2])
  throw new Error("Pass the exact versioned release candidate tarball path.");
const runId = randomUUID();
const concurrency = Number(process.env.RELEASE_MATRIX_CONCURRENCY ?? 2);
const results = [];
let nextIndex = 0;
let failed = false;

async function runRow(row) {
  return await new Promise((resolve, reject) => {
    const rowId = row.astro.replaceAll(".", "-") + "-" + runId.slice(0, 8);
    const browser =
      row.http === true && (row.major === "6" || row.major === "7");
    const canary = row.astro === "6.4.8" || row.astro === "7.3.5";
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
          FIXTURE_PACKAGE_TARBALL: tarballPath,
          FIXTURE_RUN_ID: "candidate-" + rowId,
          FIXTURE_BROWSER_TESTS: String(browser),
          PLAYWRIGHT_PROJECTS:
            process.env.PLAYWRIGHT_PROJECTS ?? "chromium,firefox,webkit",
          FIXTURE_CLOUDFLARE_CANARY: String(canary),
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
      45 * 60 * 1000,
    );
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ astro: row.astro, code });
      else
        reject(
          new Error(
            "Exact-candidate Astro " +
              row.astro +
              " run failed with code=" +
              code +
              " signal=" +
              signal +
              ".",
          ),
        );
    });
  });
}

async function worker() {
  while (!failed) {
    const index = nextIndex++;
    if (index >= matrix.length) return;
    const row = matrix[index];
    try {
      const result = await runRow(row);
      results.push(result);
    } catch (error) {
      failed = true;
      throw error;
    }
  }
}

const outcomes = await Promise.allSettled(
  Array.from({ length: Math.min(concurrency, matrix.length) }, () => worker()),
);
const failure = outcomes.find((outcome) => outcome.status === "rejected");
if (failure) throw failure.reason;
results.sort((a, b) =>
  a.astro.localeCompare(b.astro, undefined, { numeric: true }),
);
const reportDirectory = path.join(repositoryRoot, ".release-artifacts");
await fs.mkdir(reportDirectory, { recursive: true });
await fs.writeFile(
  path.join(reportDirectory, "candidate-matrix.json"),
  JSON.stringify(
    {
      versionedCandidate: tarballPath,
      runId,
      results,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  "Exact versioned candidate passed all " +
    results.length +
    " pinned Astro rows.\n",
);
