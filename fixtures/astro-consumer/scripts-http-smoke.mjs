import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? "preview";
const port = Number(process.argv[3] ?? (mode === "preview" ? 45731 : 45732));
let origin = `http://127.0.0.1:${port}`;
const major = Number(process.env.FIXTURE_ASTRO_MAJOR);
const command = mode === "preview" ? "preview" : "dev";
const expectRuntimeHeaders = process.env.FIXTURE_RUNTIME !== "false";
let foregroundServer;
let serverOutput = "";

function restartBackgroundServer() {
  try {
    execFileSync("pnpm", ["exec", "astro", command, "stop"], {
      cwd: root,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
  } catch {}
  const output = execFileSync(
    "pnpm",
    [
      "exec",
      "astro",
      command,
      "--background",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  process.stdout.write(output);
  const actualUrl = output
    .match(/https?:\/\/[^\s\"']+/)?.[0]
    ?.replace(/[.,}]+$/, "");
  if (actualUrl) origin = actualUrl;
}

if (major >= 7) {
  restartBackgroundServer();
} else {
  const astroCli = path.join(root, "node_modules", "astro", "bin", "astro.mjs");
  foregroundServer = spawn(
    process.execPath,
    [astroCli, command, "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  foregroundServer.stdout.on("data", (chunk) => {
    serverOutput = `${serverOutput}${chunk}`.slice(-6000);
  });
  foregroundServer.stderr.on("data", (chunk) => {
    serverOutput = `${serverOutput}${chunk}`.slice(-6000);
  });
}

try {
  let response;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      response = await fetch(`${origin}/docs/api.json`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.status === 200) break;
    } catch {}
    if (
      foregroundServer?.exitCode !== null &&
      foregroundServer?.exitCode !== undefined
    ) {
      throw new Error(
        `${mode} exited before serving requests (code ${foregroundServer.exitCode}).\n${serverOutput}`,
      );
    }
    await delay(500);
  }
  if (!response || response.status !== 200)
    throw new Error(
      `${mode} did not serve /docs/api.json on ${origin}.\n${serverOutput}`,
    );
  if (
    expectRuntimeHeaders &&
    response.headers.get("x-fixture-header") !== `astro-${major}`
  )
    throw new Error("Astro response middleware header is missing.");
  if (!expectRuntimeHeaders && response.headers.has("x-fixture-header"))
    throw new Error(
      "runtime: false still applied integration headers to an SSR response.",
    );
  if (
    response.headers.get("content-security-policy") !== "script-src 'nonce-app'"
  )
    throw new Error("Application CSP was not preserved byte-for-byte.");
  if (response.headers.get("x-fixture-app") !== "response")
    throw new Error("Application response header was lost.");
  if (response.headers.get("cache-control") !== "private, no-store")
    throw new Error("Application Cache-Control precedence was not preserved.");
  if ((await response.text()) !== '{"ok":true}')
    throw new Error("Endpoint response body changed.");

  const head = await fetch(`${origin}/docs/api.json`, {
    method: "HEAD",
    signal: AbortSignal.timeout(10000),
  });
  if (
    head.status !== 200 ||
    (expectRuntimeHeaders &&
      head.headers.get("x-fixture-header") !== `astro-${major}`) ||
    (await head.text()) !== ""
  ) {
    throw new Error("HEAD response status, headers, or body are incorrect.");
  }
  const options = await new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL("/docs/api.json", origin),
      { method: "OPTIONS" },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.setTimeout(10000, () =>
      request.destroy(new Error("OPTIONS request timed out.")),
    );
    request.on("error", reject);
    request.end();
  });
  if (options.status !== 204 || options.body !== "") {
    throw new Error(
      `OPTIONS response was status=${options.status}, headers=${JSON.stringify(options.headers)}, body=${JSON.stringify(options.body)}.`,
    );
  }
  if (options.headers.allow === "GET, HEAD, OPTIONS") {
    if (
      expectRuntimeHeaders &&
      options.headers["x-fixture-header"] !== `astro-${major}`
    )
      throw new Error(
        "An Astro-handled OPTIONS response did not receive runtime headers.",
      );
  } else if (options.headers["access-control-allow-methods"]) {
    console.log(
      "Wrangler answered the OPTIONS preflight outside Astro; application OPTIONS headers are not observable through this local server.",
    );
  } else {
    throw new Error(
      `OPTIONS was not handled by the fixture route or Wrangler preflight: ${JSON.stringify(options.headers)}.`,
    );
  }
  const appError = await fetch(`${origin}/docs/api-error`, {
    signal: AbortSignal.timeout(10000),
  });
  if (
    appError.status !== 500 ||
    (expectRuntimeHeaders &&
      appError.headers.get("x-fixture-header") !== `astro-${major}`) ||
    (await appError.text()) !== "application-error"
  ) {
    throw new Error(
      "Application error response did not preserve its status/body and receive runtime headers.",
    );
  }
  const cookies = await fetch(`${origin}/docs/api-cookies`, {
    signal: AbortSignal.timeout(10000),
  });
  const setCookies = cookies.headers.getSetCookie();
  if (
    (expectRuntimeHeaders &&
      cookies.headers.get("x-fixture-header") !== `astro-${major}`) ||
    setCookies.length !== 2 ||
    setCookies[0] !== "first=one; Path=/" ||
    setCookies[1] !== "second=two; Path=/"
  ) {
    throw new Error(
      "Distinct application Set-Cookie headers were not preserved.",
    );
  }

  const missing = await fetch(`${origin}/docs/no-such-page`, {
    signal: AbortSignal.timeout(10000),
  });
  if (
    missing.status !== 404 ||
    (expectRuntimeHeaders &&
      missing.headers.get("x-fixture-header") !== `astro-${major}`)
  ) {
    throw new Error(
      "Astro not-found response did not receive configured headers.",
    );
  }
  await missing.arrayBuffer();

  const redirect = await fetch(`${origin}/docs/api-redirect`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (
    redirect.status !== 307 ||
    (expectRuntimeHeaders &&
      redirect.headers.get("x-fixture-header") !== `astro-${major}`)
  ) {
    throw new Error(
      "Astro redirect response did not receive configured headers.",
    );
  }

  const stream = await fetch(`${origin}/docs/api-stream`, {
    signal: AbortSignal.timeout(10000),
  });
  const reader = stream.body.getReader();
  const first = await reader.read();
  if (new TextDecoder().decode(first.value) !== "first")
    throw new Error("The first streamed chunk was lost or reordered.");
  const second = await reader.read();
  if (new TextDecoder().decode(second.value) !== "second")
    throw new Error("The later streamed chunk was lost or reordered.");

  const rootHtmlPath =
    process.env.FIXTURE_HTML_HANDLING === "none"
      ? "/docs/index.html"
      : process.env.FIXTURE_HTML_HANDLING === "drop-trailing-slash"
        ? "/docs"
        : "/docs/";
  const staticPage = await fetch(`${origin}${rootHtmlPath}`, {
    signal: AbortSignal.timeout(10000),
  });
  const pureSsr = process.env.FIXTURE_PURE_SSR === "true";
  const expectedSharedHeader =
    mode === "dev" || pureSsr ? "configured" : "manual, configured";
  if (
    staticPage.status !== 200 ||
    staticPage.headers.get("x-fixture-header") !== `astro-${major}` ||
    staticPage.headers.get("x-shared-header") !== expectedSharedHeader
  ) {
    throw new Error(
      "HTML route did not receive its expected configured headers.",
    );
  }
  const pageBody = await staticPage.text();
  if (!pageBody.includes("Static route"))
    throw new Error("HTML route body changed.");
  if (process.env.FIXTURE_NATIVE_CSP === "true") {
    if (
      !/<meta\b[^>]*http-equiv=["']content-security-policy["']/i.test(pageBody)
    )
      throw new Error("Astro native CSP meta element is missing.");
    if (
      process.env.FIXTURE_CSP_MODE === "native-only" &&
      staticPage.headers.has("content-security-policy")
    )
      throw new Error(
        "Native CSP without integration CSP gained a response policy.",
      );
  }
  if (
    process.env.FIXTURE_CSP_MODE &&
    process.env.FIXTURE_CSP_MODE !== "native-only"
  ) {
    const { assertCspResponses } = await import("./scripts-csp-assertions.mjs");
    const cspMode =
      process.env.FIXTURE_CSP_MODE === "global" ? "global" : "route";
    await assertCspResponses(origin, cspMode);
    const runtimePage = await fetch(new URL("/docs/api-plain", origin), {
      signal: AbortSignal.timeout(10000),
    });
    const runtimeCsp = runtimePage.headers.get("content-security-policy") ?? "";
    if (
      runtimePage.status !== 200 ||
      !runtimeCsp ||
      runtimeCsp.includes("sha256-")
    )
      throw new Error(
        "Dynamic Worker response inherited static-only CSP hashes.",
      );
  }
  if (mode === "preview") {
    const stylesheet = pageBody.match(/href="([^"]+\.css)"/)?.[1];
    if (!stylesheet)
      throw new Error("Prerendered page did not reference a built CSS asset.");
    const asset = await fetch(new URL(stylesheet, origin), {
      signal: AbortSignal.timeout(10000),
    });
    if (asset.status !== 200)
      throw new Error("Hashed static asset did not load.");
    const cacheControl = asset.headers.get("cache-control") ?? "";
    if (process.env.FIXTURE_CACHE_MODE === "full") {
      if (cacheControl !== "public, max-age=300")
        throw new Error(
          `Full-pattern Cache-Control override was not effective: ${cacheControl}`,
        );
    } else if (!cacheControl.includes("immutable")) {
      throw new Error(
        `Adapter immutable asset caching was lost: ${cacheControl}`,
      );
    }
    await asset.arrayBuffer();
  }
  if (
    process.env.FIXTURE_BROWSER_TESTS === "true" &&
    process.env.FIXTURE_BROWSER_SCENARIO === "routeCsp"
  ) {
    const repositoryRoot = process.env.FIXTURE_REPOSITORY_ROOT;
    if (!repositoryRoot)
      throw new Error(
        "FIXTURE_REPOSITORY_ROOT is required for the Playwright browser suite.",
      );
    execFileSync(
      "pnpm",
      [
        "--dir",
        repositoryRoot,
        "exec",
        "playwright",
        "test",
        "--config",
        path.join(repositoryRoot, "playwright.config.ts"),
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          PLAYWRIGHT_BASE_URL: origin,
          PLAYWRIGHT_PROJECTS: process.env.PLAYWRIGHT_PROJECTS ?? "chromium",
        },
        timeout: 10 * 60 * 1000,
        shell: process.platform === "win32",
      },
    );
  }

  console.log(
    `${mode} HTTP acceptance passed for Astro ${major} at ${origin}.`,
  );
} finally {
  if (foregroundServer && foregroundServer.exitCode === null) {
    foregroundServer.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => foregroundServer.once("exit", resolve)),
      delay(5000),
    ]);
    if (foregroundServer.exitCode === null) foregroundServer.kill("SIGKILL");
  } else if (major >= 7) {
    try {
      execFileSync("pnpm", ["exec", "astro", command, "stop"], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
    } catch {}
  }
}
