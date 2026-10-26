import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceFixture = path.join(repositoryRoot, "fixtures", "astro-consumer");
const matrix = JSON.parse(
  await fs.readFile(
    path.join(sourceFixture, "compatibility-matrix.json"),
    "utf8",
  ),
);
const packageTarballs = (await fs.readdir(sourceFixture)).filter(
  (name) =>
    name.startsWith("astro-cloudflare-pages-headers-") && name.endsWith(".tgz"),
);
const suppliedTarball = process.env.FIXTURE_PACKAGE_TARBALL
  ? path.resolve(process.env.FIXTURE_PACKAGE_TARBALL)
  : packageTarballs.length === 1
    ? path.join(sourceFixture, packageTarballs[0])
    : undefined;
if (packageTarballs.length > 1 && !process.env.FIXTURE_PACKAGE_TARBALL) {
  throw new Error(
    "Expected one downloaded release candidate in fixtures/astro-consumer, found " +
      packageTarballs.length +
      ".",
  );
}
if (suppliedTarball) await fs.access(suppliedTarball);
const astro = process.env.FIXTURE_ASTRO_VERSION;
const adapter = process.env.FIXTURE_ADAPTER_VERSION;
const wrangler = process.env.FIXTURE_WRANGLER_VERSION;
const row = matrix.find(
  (candidate) =>
    candidate.astro === astro &&
    candidate.adapter === adapter &&
    candidate.wrangler === wrangler,
);
if (!row)
  throw new Error(
    "Compatibility tuple " +
      astro +
      "/" +
      adapter +
      "/" +
      wrangler +
      " is not in fixtures/astro-consumer/compatibility-matrix.json.",
  );

const runId = process.env.FIXTURE_RUN_ID ?? randomUUID();
const isolationRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "astro-headers-" + runId + "-"),
);
const fixtureRoot = path.join(isolationRoot, "fixture");
const leaseRoot = path.join(os.tmpdir(), "astro-headers-port-leases");
const logRoot =
  process.env.TEST_RESULTS_DIR ??
  path.join(repositoryRoot, "test-results", "compatibility");
const logPath = path.join(logRoot, astro + "-" + runId + ".log");
const leases = [];
let child;
let output;
let finished = false;
let timer;

async function reservePort() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const leasePath = path.join(leaseRoot, String(port));
    try {
      await fs.writeFile(leasePath, process.pid + ":" + runId, { flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    const probe = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", resolve);
      });
      await new Promise((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
      leases.push(leasePath);
      return port;
    } catch {
      await fs.rm(leasePath, { force: true });
    }
  }
  throw new Error(
    "Could not reserve a unique local port for the compatibility suite.",
  );
}

function terminateTree(signal) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
    killer.unref();
  } else {
    try {
      process.kill(-child.pid, signal ?? "SIGTERM");
    } catch {}
  }
}

async function cleanup() {
  clearTimeout(timer);
  for (const lease of leases) await fs.rm(lease, { force: true });
  await fs.rm(isolationRoot, { recursive: true, force: true });
}

function onSignal(signal) {
  terminateTree(signal);
}

process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  await fs.mkdir(leaseRoot, { recursive: true });
  await fs.mkdir(logRoot, { recursive: true });
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
      ].includes(path.basename(source)) &&
      !path.basename(source).endsWith(".tgz"),
  });
  if (suppliedTarball) {
    const isolatedTarball = path.join(
      fixtureRoot,
      "astro-cloudflare-pages-headers.tgz",
    );
    await fs.copyFile(suppliedTarball, isolatedTarball);
    process.env.FIXTURE_PACKAGE_TARBALL = isolatedTarball;
  }
  const portNames = [
    "workerd",
    "preview",
    "dev",
    "manual",
    "full",
    "integration",
    "optOut",
    "routeCsp",
    "pureSsr",
    "htmlForce",
    "htmlDrop",
    "htmlNone",
    "fileFormat",
    "global",
    "native",
    "browser",
  ];
  const ports = Object.fromEntries(
    await Promise.all(
      portNames.map(async (name) => [name, await reservePort()]),
    ),
  );
  output = await fs.open(logPath, "w");
  await output.writeFile(
    "run=" +
      runId +
      "\nastro=" +
      astro +
      "\nadapter=" +
      adapter +
      "\nwrangler=" +
      wrangler +
      "\nports=" +
      JSON.stringify(ports) +
      "\n",
  );

  child = spawn(
    process.execPath,
    [path.join(fixtureRoot, "run-compatibility.mjs")],
    {
      cwd: fixtureRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        FIXTURE_ISOLATED: "true",
        FIXTURE_REPOSITORY_ROOT: repositoryRoot,
        FIXTURE_CANARY_RUN_ID: process.env.FIXTURE_CANARY_RUN_ID ?? runId,
        FIXTURE_PORTS: JSON.stringify(ports),
        FIXTURE_ASTRO_VERSION: astro,
        FIXTURE_ADAPTER_VERSION: adapter,
        FIXTURE_WRANGLER_VERSION: wrangler,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const writeChunk = async (stream, chunk) => {
    const value = chunk.toString();
    (stream === "stdout" ? process.stdout : process.stderr).write(value);
    await output.appendFile("[" + stream + "] " + value);
  };
  child.stdout.on("data", (chunk) => {
    void writeChunk("stdout", chunk);
  });
  child.stderr.on("data", (chunk) => {
    void writeChunk("stderr", chunk);
  });
  child.once("error", (error) => {
    process.stderr.write((error.stack ?? error) + "\n");
  });

  const result = await new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    timer = setTimeout(
      () => {
        process.stderr.write(
          "Compatibility suite exceeded its 45-minute process limit.\n",
        );
        terminateTree("SIGKILL");
      },
      45 * 60 * 1000,
    );
    timer.unref();
  });
  finished = true;
  await output.appendFile(
    "\nexit=" +
      (result.code ?? "null") +
      " signal=" +
      (result.signal ?? "none") +
      "\n",
  );
  await output.close();
  if (result.code !== 0)
    throw new Error(
      "Isolated compatibility run failed; log retained at " + logPath + ".",
    );
  process.stdout.write(
    "Isolated compatibility run passed; log: " + logPath + "\n",
  );
} finally {
  if (!finished) terminateTree("SIGKILL");
  if (output) await output.close().catch(() => {});
  await cleanup();
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
