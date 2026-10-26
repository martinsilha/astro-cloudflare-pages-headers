import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot =
  process.env.FIXTURE_REPOSITORY_ROOT ?? path.resolve(root, "../..");
const astroVersion = process.env.FIXTURE_ASTRO_VERSION;
const adapterVersion = process.env.FIXTURE_ADAPTER_VERSION;
const astroMajor = Number(astroVersion?.split(".")[0]);
const wranglerVersion = process.env.FIXTURE_WRANGLER_VERSION;
const ports = JSON.parse(process.env.FIXTURE_PORTS ?? "{}");
const port = (name) => String(ports[name] ?? 45731);
if (
  !astroVersion ||
  !adapterVersion ||
  !wranglerVersion ||
  ![4, 5, 6, 7].includes(astroMajor)
) {
  throw new Error(
    "Set FIXTURE_ASTRO_VERSION, FIXTURE_ADAPTER_VERSION, and FIXTURE_WRANGLER_VERSION to one of the pinned Astro 4–7 compatibility rows.",
  );
}
const matrix = JSON.parse(
  await fs.readFile(path.join(root, "compatibility-matrix.json"), "utf8"),
);
if (
  !matrix.some(
    (row) =>
      row.astro === astroVersion &&
      row.adapter === adapterVersion &&
      row.wrangler === wranglerVersion,
  )
) {
  throw new Error(
    "The requested Astro, adapter, and Wrangler versions are not in the shared compatibility matrix.",
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    timeout: 15 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function clean(withAdapter, layout = "custom") {
  const env = {
    ...process.env,
    FIXTURE_ASTRO_MAJOR: String(astroMajor),
    FIXTURE_WITH_ADAPTER: String(withAdapter),
    FIXTURE_LAYOUT: layout,
  };
  if (run("node", ["scripts-reset-output.mjs"], { cwd: root, env }) !== 0)
    throw new Error("Could not clear the prior fixture output.");
}

async function build(withAdapter, extraEnv = {}, layout = "custom") {
  const env = {
    ...process.env,
    ...extraEnv,
    FIXTURE_ASTRO_MAJOR: String(astroMajor),
    FIXTURE_WITH_ADAPTER: String(withAdapter),
    FIXTURE_LAYOUT: layout,
  };
  await clean(withAdapter, layout);
  if (run("node", ["scripts-set-rendering-mode.mjs"], { cwd: root, env }) !== 0)
    throw new Error("Could not set the fixture rendering mode.");
  return run("pnpm", ["exec", "astro", "build"], { cwd: root, env });
}

async function buildCaptured(withAdapter, extraEnv = {}, layout = "custom") {
  const env = {
    ...process.env,
    ...extraEnv,
    FIXTURE_ASTRO_MAJOR: String(astroMajor),
    FIXTURE_WITH_ADAPTER: String(withAdapter),
    FIXTURE_LAYOUT: layout,
  };
  await clean(withAdapter, layout);
  if (run("node", ["scripts-set-rendering-mode.mjs"], { cwd: root, env }) !== 0)
    throw new Error("Could not set the fixture rendering mode.");
  const result = spawnSync("pnpm", ["exec", "astro", "build"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  return { status: result.status ?? 1, output };
}

let tarball = process.env.FIXTURE_PACKAGE_TARBALL;
if (!tarball) {
  const candidates = (await fs.readdir(root)).filter(
    (name) =>
      name.endsWith(".tgz") && name !== "astro-cloudflare-pages-headers.tgz",
  );
  if (candidates.length === 1) tarball = path.join(root, candidates[0]);
}
if (!tarball) {
  const packageDirectory = path.join(root, ".packed");
  await fs.rm(packageDirectory, { recursive: true, force: true });
  await fs.mkdir(packageDirectory, { recursive: true });
  const status = run("pnpm", ["pack", "--pack-destination", packageDirectory], {
    cwd: repositoryRoot,
  });
  if (status !== 0) throw new Error("Could not pack the integration.");
  const candidates = (await fs.readdir(packageDirectory)).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (candidates.length !== 1)
    throw new Error(
      "Expected one packed integration tarball in the temporary package directory.",
    );
  tarball = path.join(packageDirectory, candidates[0]);
}
const localTarball = path.join(root, "astro-cloudflare-pages-headers.tgz");
if (path.resolve(tarball) !== localTarball)
  await fs.copyFile(tarball, localTarball);

const fixtureEnv = {
  ...process.env,
  FIXTURE_ASTRO_VERSION: astroVersion,
  FIXTURE_ADAPTER_VERSION: adapterVersion,
  FIXTURE_WRANGLER_VERSION: wranglerVersion,
};
if (
  run("node", ["scripts-prepare-fixture.mjs"], {
    cwd: root,
    env: fixtureEnv,
  }) !== 0
)
  throw new Error("Could not prepare fixture dependencies.");
const lockfile = path.join(root, "locks", `astro-${astroVersion}.yaml`);
try {
  await fs.copyFile(lockfile, path.join(root, "pnpm-lock.yaml"));
} catch (error) {
  throw new Error(
    `No committed compatibility lockfile exists for Astro ${astroVersion}: ${lockfile}`,
    { cause: error },
  );
}
const packageLockPath = path.join(root, "pnpm-lock.yaml");
const pinnedLock = await fs.readFile(packageLockPath, "utf8");
if (
  run("pnpm", ["install", "--lockfile-only", "--no-frozen-lockfile"], {
    cwd: root,
    env: fixtureEnv,
  }) !== 0
) {
  throw new Error(
    "Could not refresh local candidate tarball metadata in the pinned compatibility lockfile.",
  );
}
const refreshedLock = await fs.readFile(packageLockPath, "utf8");
function withoutLocalArchiveEntries(lock) {
  const output = [];
  let skipping = false;
  for (const line of lock.split("\n")) {
    if (
      /^  astro-cloudflare-pages-headers@file:astro-cloudflare-pages-headers\.tgz(?:\(|:)/.test(
        line,
      )
    )
      skipping = true;
    else if (skipping && /^  \S/.test(line)) skipping = false;
    if (!skipping) output.push(line);
  }
  return output.join("\n");
}
if (
  withoutLocalArchiveEntries(pinnedLock) !==
  withoutLocalArchiveEntries(refreshedLock)
) {
  throw new Error(
    "Refreshing the local candidate changed pinned Astro, adapter, Wrangler, or transitive package resolutions.",
  );
}
if (
  run("pnpm", ["install", "--frozen-lockfile"], {
    cwd: root,
    env: fixtureEnv,
  }) !== 0
)
  throw new Error("Could not install the frozen compatibility pair.");
console.log(
  `Compatibility fixture: Node ${process.version}, Astro ${astroVersion}, @astrojs/cloudflare ${adapterVersion}, Wrangler ${wranglerVersion}`,
);
if (
  run("pnpm", ["exec", "astro", "--version"], {
    cwd: root,
    env: fixtureEnv,
  }) !== 0 ||
  run("pnpm", ["exec", "wrangler", "--version"], {
    cwd: root,
    env: fixtureEnv,
  }) !== 0 ||
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
    cwd: root,
    env: fixtureEnv,
  }) !== 0 ||
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.nodenext.json"], {
    cwd: root,
    env: fixtureEnv,
  }) !== 0
) {
  throw new Error(
    "Could not report fixture versions or compile both Bundler and NodeNext package consumers.",
  );
}
if (
  (astroMajor === 6 && astroVersion === "6.4.8") ||
  (astroMajor === 7 && astroVersion === "7.3.5")
) {
  if (
    run("node", ["scripts-workerd-runtime-smoke.mjs"], {
      cwd: root,
      env: { ...fixtureEnv, FIXTURE_WORKER_PORT: port("workerd") },
    }) !== 0
  ) {
    throw new Error("Packed middleware local workerd HTTP checks failed.");
  }
}

for (const layout of ["default", "custom"]) {
  if ((await build(true, {}, layout)) !== 0)
    throw new Error(`Cloudflare adapter build failed for ${layout} output.`);
  const adapterEnv = {
    ...fixtureEnv,
    FIXTURE_ASTRO_MAJOR: String(astroMajor),
    FIXTURE_WITH_ADAPTER: "true",
    FIXTURE_LAYOUT: layout,
  };
  if (
    run("node", ["scripts-smoke-output.mjs"], {
      cwd: root,
      env: adapterEnv,
    }) !== 0
  )
    throw new Error(`Adapter output verification failed for ${layout} output.`);
  if (
    layout === "custom" &&
    ((astroMajor === 6 && astroVersion === "6.4.8") ||
      (astroMajor === 7 && astroVersion === "7.3.5"))
  ) {
    for (const [mode, portNumber] of [
      ["preview", port("preview")],
      ["dev", port("dev")],
    ]) {
      if (
        run("node", ["scripts-http-smoke.mjs", mode, portNumber], {
          cwd: root,
          env: adapterEnv,
        }) !== 0
      )
        throw new Error(`Local ${mode} HTTP checks failed.`);
    }
  }

  if ((await build(false, {}, layout)) !== 0)
    throw new Error(`Static Pages build failed for ${layout} output.`);
  const staticEnv = {
    ...fixtureEnv,
    FIXTURE_ASTRO_MAJOR: String(astroMajor),
    FIXTURE_WITH_ADAPTER: "false",
    FIXTURE_LAYOUT: layout,
  };
  if (
    run("node", ["scripts-smoke-output.mjs"], { cwd: root, env: staticEnv }) !==
    0
  )
    throw new Error(`Static output verification failed for ${layout} output.`);

  if (astroMajor >= 6) {
    if ((await build(true, { FIXTURE_OUTPUT_MODE: "static" }, layout)) !== 0)
      throw new Error(
        `Astro ${astroMajor} static-with-adapter build failed for ${layout} output.`,
      );
    const staticAdapterEnv = {
      ...fixtureEnv,
      FIXTURE_ASTRO_MAJOR: String(astroMajor),
      FIXTURE_WITH_ADAPTER: "true",
      FIXTURE_LAYOUT: layout,
      FIXTURE_OUTPUT_MODE: "static",
    };
    if (
      run("node", ["scripts-smoke-output.mjs"], {
        cwd: root,
        env: staticAdapterEnv,
      }) !== 0
    )
      throw new Error(
        `Astro ${astroMajor} static-with-adapter output verification failed.`,
      );
  }
}

if (astroMajor === 7 && astroVersion === "7.3.5") {
  const manualCacheEnv = { ...fixtureEnv, FIXTURE_CACHE_MODE: "manual" };
  if ((await build(true, manualCacheEnv, "custom")) !== 0)
    throw new Error("Manual immutable cache-rule build failed.");
  const manualAdapterEnv = {
    ...manualCacheEnv,
    FIXTURE_ASTRO_MAJOR: "7",
    FIXTURE_WITH_ADAPTER: "true",
    FIXTURE_LAYOUT: "custom",
  };
  if (
    run("node", ["scripts-smoke-output.mjs"], {
      cwd: root,
      env: manualAdapterEnv,
    }) !== 0
  )
    throw new Error("Manual immutable cache-rule output verification failed.");
  if (
    run("node", ["scripts-http-smoke.mjs", "preview", port("manual")], {
      cwd: root,
      env: manualAdapterEnv,
    }) !== 0
  )
    throw new Error("Manual immutable cache-rule HTTP check failed.");

  const fullEnv = { ...fixtureEnv, FIXTURE_CACHE_MODE: "full" };
  if ((await build(true, fullEnv, "custom")) !== 0)
    throw new Error("Full-pattern cache override build failed.");
  if (
    run("node", ["scripts-smoke-output.mjs"], {
      cwd: root,
      env: {
        ...fullEnv,
        FIXTURE_ASTRO_MAJOR: "7",
        FIXTURE_WITH_ADAPTER: "true",
      },
    }) !== 0
  )
    throw new Error("Full-pattern output verification failed.");
  if (
    run("node", ["scripts-http-smoke.mjs", "preview", port("full")], {
      cwd: root,
      env: {
        ...fullEnv,
        FIXTURE_ASTRO_MAJOR: "7",
        FIXTURE_WITH_ADAPTER: "true",
      },
    }) !== 0
  )
    throw new Error("Full-pattern cache HTTP check failed.");

  const narrowEnv = { ...fixtureEnv, FIXTURE_CACHE_MODE: "narrow" };
  const narrowStatus = await build(true, narrowEnv);
  if (narrowStatus === 0)
    throw new Error(
      "The narrow asset cache conflict unexpectedly built successfully.",
    );
  console.log("Narrow asset cache conflict failed as expected.");

  const integrationCacheEnv = {
    ...fixtureEnv,
    FIXTURE_CACHE_MODE: "integration",
  };
  if ((await build(true, integrationCacheEnv, "custom")) !== 0)
    throw new Error("Cache rule from another integration failed to build.");
  const secondIntegrationEnv = {
    ...integrationCacheEnv,
    FIXTURE_ASTRO_MAJOR: "7",
    FIXTURE_WITH_ADAPTER: "true",
    FIXTURE_LAYOUT: "custom",
  };
  if (
    run("node", ["scripts-smoke-output.mjs"], {
      cwd: root,
      env: secondIntegrationEnv,
    }) !== 0
  )
    throw new Error(
      "Cache rule from another integration was lost or duplicated.",
    );
  if (
    run("node", ["scripts-http-smoke.mjs", "preview", port("integration")], {
      cwd: root,
      env: secondIntegrationEnv,
    }) !== 0
  )
    throw new Error(
      "Cache rule from another integration failed local HTTP verification.",
    );

  const lateLimit = await buildCaptured(
    true,
    { ...fixtureEnv, FIXTURE_LIMIT_RULES: "98" },
    "custom",
  );
  if (lateLimit.status === 0 || !/101 rules/.test(lateLimit.output))
    throw new Error(
      "The build did not reject a 101-rule final output after adapter additions.",
    );
  console.log(
    "Final Workers _headers limit correctly counted adapter additions beyond the 100-rule boundary.",
  );
}

if ((await build(false)) !== 0) throw new Error("Static Pages build failed.");
if (
  run("node", ["scripts-smoke-output.mjs"], {
    cwd: root,
    env: {
      ...fixtureEnv,
      FIXTURE_ASTRO_MAJOR: String(astroMajor),
      FIXTURE_WITH_ADAPTER: "false",
    },
  }) !== 0
) {
  throw new Error("Static output verification failed.");
}
if (astroMajor === 7 && astroVersion === "7.3.5") {
  const optOutEnv = { ...fixtureEnv, FIXTURE_RUNTIME: "false" };
  if ((await build(true, optOutEnv, "custom")) !== 0)
    throw new Error("runtime: false Cloudflare build failed.");
  if (
    run("node", ["scripts-smoke-output.mjs"], {
      cwd: root,
      env: {
        ...optOutEnv,
        FIXTURE_ASTRO_MAJOR: "7",
        FIXTURE_WITH_ADAPTER: "true",
      },
    }) !== 0
  )
    throw new Error("runtime: false static output verification failed.");
  if (
    run("node", ["scripts-http-smoke.mjs", "preview", port("optOut")], {
      cwd: root,
      env: {
        ...optOutEnv,
        FIXTURE_ASTRO_MAJOR: "7",
        FIXTURE_WITH_ADAPTER: "true",
      },
    }) !== 0
  )
    throw new Error("runtime: false Worker HTTP checks failed.");
}

if (
  (astroMajor === 4 && astroVersion === "4.16.19") ||
  (astroMajor === 5 && astroVersion === "5.18.2")
) {
  if (
    run("node", ["scripts-pages-smoke.mjs"], {
      cwd: root,
      env: { ...fixtureEnv, FIXTURE_ASTRO_MAJOR: String(astroMajor) },
    }) !== 0
  ) {
    throw new Error("Wrangler Pages HTTP checks failed.");
  }
}

if (
  (astroMajor === 6 && astroVersion === "6.4.8") ||
  (astroMajor === 7 && astroVersion === "7.3.5")
) {
  const routeCspEnv = {
    ...fixtureEnv,
    FIXTURE_CSP_MODE: "route",
    ...(astroMajor === 7
      ? { FIXTURE_NATIVE_CSP: "true", FIXTURE_CSP_MIXED_CASE: "true" }
      : {}),
  };
  if ((await build(true, routeCspEnv, "custom")) !== 0)
    throw new Error("Route-mode CSP Worker build failed.");
  if (
    run("node", ["scripts-smoke-output.mjs"], {
      cwd: root,
      env: {
        ...routeCspEnv,
        FIXTURE_ASTRO_MAJOR: String(astroMajor),
        FIXTURE_WITH_ADAPTER: "true",
        FIXTURE_LAYOUT: "custom",
      },
    }) !== 0
  )
    throw new Error("Route-mode CSP Worker output checks failed.");
  const routeCspHttpEnv = {
    ...routeCspEnv,
    FIXTURE_BROWSER_SCENARIO: "routeCsp",
    FIXTURE_ASTRO_MAJOR: String(astroMajor),
    FIXTURE_WITH_ADAPTER: "true",
    FIXTURE_LAYOUT: "custom",
  };
  if (
    run("node", ["scripts-http-smoke.mjs", "preview", port("routeCsp")], {
      cwd: root,
      env: routeCspHttpEnv,
    }) !== 0
  )
    throw new Error("Route-mode CSP Worker HTTP checks failed.");
  if (process.env.FIXTURE_CLOUDFLARE_CANARY === "true") {
    if (
      run(
        "node",
        [
          path.join(repositoryRoot, "scripts", "cloudflare-canary.mjs"),
          "worker",
        ],
        {
          cwd: root,
          env: {
            ...routeCspHttpEnv,
            FIXTURE_REPOSITORY_ROOT: repositoryRoot,
            FIXTURE_WORKSPACE_ROOT: root,
          },
        },
      ) !== 0
    )
      throw new Error(
        "Deployed Astro " + astroMajor + " Workers canary failed.",
      );
  }
  if (astroMajor === 7) {
    const pureSsrEnv = {
      ...routeCspEnv,
      FIXTURE_PURE_SSR: "true",
      FIXTURE_NATIVE_CSP: "false",
    };
    if ((await build(true, pureSsrEnv, "custom")) !== 0)
      throw new Error("Pure-SSR route-mode CSP Worker build failed.");
    const pureSsrAdapterEnv = {
      ...pureSsrEnv,
      FIXTURE_ASTRO_MAJOR: "7",
      FIXTURE_WITH_ADAPTER: "true",
      FIXTURE_LAYOUT: "custom",
    };
    if (
      run("node", ["scripts-smoke-output.mjs"], {
        cwd: root,
        env: pureSsrAdapterEnv,
      }) !== 0
    )
      throw new Error("Pure-SSR output verification failed.");
    if (
      run("node", ["scripts-http-smoke.mjs", "preview", port("pureSsr")], {
        cwd: root,
        env: pureSsrAdapterEnv,
      }) !== 0
    )
      throw new Error("Pure-SSR route-mode CSP HTTP checks failed.");
  }
  if (astroMajor === 7) {
    for (const [htmlHandling, portNumber] of [
      ["force-trailing-slash", port("htmlForce")],
      ["drop-trailing-slash", port("htmlDrop")],
      ["none", port("htmlNone")],
    ]) {
      const handlingEnv = {
        ...routeCspEnv,
        FIXTURE_HTML_HANDLING: htmlHandling,
      };
      if ((await build(true, handlingEnv, "custom")) !== 0)
        throw new Error(
          `Route-mode CSP build failed for html_handling=${htmlHandling}.`,
        );
      const adapterEnv = {
        ...handlingEnv,
        FIXTURE_ASTRO_MAJOR: "7",
        FIXTURE_WITH_ADAPTER: "true",
        FIXTURE_LAYOUT: "custom",
      };
      if (
        run("node", ["scripts-smoke-output.mjs"], {
          cwd: root,
          env: adapterEnv,
        }) !== 0
      )
        throw new Error(
          `CSP output verification failed for html_handling=${htmlHandling}.`,
        );
      if (
        run("node", ["scripts-http-smoke.mjs", "preview", portNumber], {
          cwd: root,
          env: adapterEnv,
        }) !== 0
      )
        throw new Error(
          `Route-mode CSP HTTP checks failed for html_handling=${htmlHandling}.`,
        );
    }
    const fileFormatEnv = { ...routeCspEnv, FIXTURE_BUILD_FORMAT: "file" };
    if ((await build(true, fileFormatEnv, "custom")) !== 0)
      throw new Error("Route-mode CSP file-format build failed.");
    const fileFormatAdapterEnv = {
      ...fileFormatEnv,
      FIXTURE_ASTRO_MAJOR: "7",
      FIXTURE_WITH_ADAPTER: "true",
      FIXTURE_LAYOUT: "custom",
    };
    if (
      run("node", ["scripts-smoke-output.mjs"], {
        cwd: root,
        env: fileFormatAdapterEnv,
      }) !== 0
    )
      throw new Error("CSP file-format output verification failed.");
    if (
      run("node", ["scripts-http-smoke.mjs", "preview", port("fileFormat")], {
        cwd: root,
        env: fileFormatAdapterEnv,
      }) !== 0
    )
      throw new Error("Route-mode CSP file-format HTTP checks failed.");
  }
}

if (astroMajor === 7 && astroVersion === "7.3.5") {
  const routePagesEnv = {
    ...fixtureEnv,
    FIXTURE_CSP_MODE: "route",
    FIXTURE_CSP_MIXED_CASE: "true",
  };
  if ((await build(false, routePagesEnv, "custom")) !== 0)
    throw new Error("Route-mode CSP Pages build failed.");
  if (
    run("node", ["scripts-smoke-output.mjs"], {
      cwd: root,
      env: {
        ...routePagesEnv,
        FIXTURE_ASTRO_MAJOR: "7",
        FIXTURE_WITH_ADAPTER: "false",
        FIXTURE_LAYOUT: "custom",
      },
    }) !== 0
  )
    throw new Error("Route-mode CSP Pages output checks failed.");
  if (
    run("node", ["scripts-pages-smoke.mjs"], {
      cwd: root,
      env: {
        ...routePagesEnv,
        FIXTURE_ASTRO_MAJOR: "7",
        FIXTURE_WITH_ADAPTER: "false",
        FIXTURE_LAYOUT: "custom",
      },
    }) !== 0
  )
    throw new Error("Route-mode CSP Pages HTTP checks failed.");
  if (process.env.FIXTURE_CLOUDFLARE_CANARY === "true") {
    if (
      run(
        "node",
        [
          path.join(repositoryRoot, "scripts", "cloudflare-canary.mjs"),
          "pages",
        ],
        {
          cwd: root,
          env: {
            ...routePagesEnv,
            FIXTURE_ASTRO_MAJOR: "7",
            FIXTURE_WITH_ADAPTER: "false",
            FIXTURE_LAYOUT: "custom",
            FIXTURE_REPOSITORY_ROOT: repositoryRoot,
            FIXTURE_WORKSPACE_ROOT: root,
          },
        },
      ) !== 0
    )
      throw new Error("Deployed Astro 7 Pages canary failed.");
  }

  const globalCspEnv = {
    ...fixtureEnv,
    FIXTURE_CSP_MODE: "global",
    FIXTURE_CSP_MIXED_CASE: "true",
  };
  if ((await build(true, globalCspEnv, "custom")) !== 0)
    throw new Error("Global-mode CSP Worker build failed.");
  if (
    run("node", ["scripts-http-smoke.mjs", "preview", port("global")], {
      cwd: root,
      env: {
        ...globalCspEnv,
        FIXTURE_ASTRO_MAJOR: "7",
        FIXTURE_WITH_ADAPTER: "true",
        FIXTURE_LAYOUT: "custom",
      },
    }) !== 0
  )
    throw new Error("Global-mode CSP Worker HTTP checks failed.");

  const nativeCspEnv = {
    ...fixtureEnv,
    FIXTURE_CSP_MODE: "native-only",
    FIXTURE_NATIVE_CSP: "true",
  };
  if ((await build(true, nativeCspEnv, "custom")) !== 0)
    throw new Error("Native-only CSP Worker build failed.");
  if (
    run("node", ["scripts-http-smoke.mjs", "preview", port("native")], {
      cwd: root,
      env: {
        ...nativeCspEnv,
        FIXTURE_ASTRO_MAJOR: "7",
        FIXTURE_WITH_ADAPTER: "true",
        FIXTURE_LAYOUT: "custom",
      },
    }) !== 0
  )
    throw new Error("Native-only CSP Worker HTTP checks failed.");
}

await clean(false, "custom");
const cleanupEnv = {
  ...process.env,
  FIXTURE_ASTRO_MAJOR: String(astroMajor),
  FIXTURE_WITH_ADAPTER: "false",
  FIXTURE_LAYOUT: "custom",
};
if (
  run("node", ["scripts-set-rendering-mode.mjs"], {
    cwd: root,
    env: cleanupEnv,
  }) !== 0
)
  throw new Error("Could not clean generated endpoint fixtures.");
