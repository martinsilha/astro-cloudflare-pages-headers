import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertReleaseCredentials,
  verifyReleaseEvidence,
} from "./semantic-release-exact-artifact.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
assertReleaseCredentials(process.env);
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
const evidence = await verifyReleaseEvidence(
  path.join(repositoryRoot, ".release-evidence"),
  matrix,
);
process.stdout.write(
  "Release preflight passed: " +
    evidence.runs.length +
    " pinned compatibility artifacts and the 95/90 coverage gate are present.\n",
);
