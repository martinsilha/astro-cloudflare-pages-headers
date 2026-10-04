import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "coverage", "coverage-summary.json");
const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
const failures = [];
const floors = { statements: 90, lines: 90, functions: 90, branches: 85 };
const coverageKeys = new Set(
  Object.keys(report)
    .filter((key) => key !== "total")
    .map((key) => path.resolve(key)),
);

async function collectProductionFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await collectProductionFiles(absolute)));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    )
      files.push(absolute);
  }
  return files;
}

// types.ts contains exported interfaces and aliases only; TypeScript consumer contracts exercise it at compile time.
const justifiedRuntimeExclusions = new Map([
  [
    path.join(root, "src", "types.ts"),
    "type-only declarations have no runtime statements; packed consumers compile both NodeNext and Bundler entrypoints",
  ],
]);
const productionFiles = await collectProductionFiles(path.join(root, "src"));
for (const file of productionFiles) {
  if (justifiedRuntimeExclusions.has(file)) continue;
  if (!coverageKeys.has(file))
    failures.push(
      "No coverage entry for production module " + path.relative(root, file),
    );
}
for (const file of coverageKeys) {
  if (!productionFiles.includes(file))
    failures.push(
      "Coverage report contains an unexpected production file " +
        path.relative(root, file),
    );
}

for (const [file, coverage] of Object.entries(report)) {
  if (file === "total") continue;
  for (const [metric, minimum] of Object.entries(floors)) {
    if (coverage[metric].pct < minimum) {
      failures.push(
        path.relative(root, file) +
          " has " +
          coverage[metric].pct +
          "% " +
          metric +
          " coverage; requires " +
          minimum +
          "%.",
      );
    }
  }
}

if (failures.length) {
  process.stderr.write(
    "Per-file coverage floors failed:\n" +
      failures.map((failure) => " - " + failure).join("\n") +
      "\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Per-file floors passed for " +
      coverageKeys.size +
      " runtime modules (90% statements/lines/functions, 85% branches).\n",
  );
}
