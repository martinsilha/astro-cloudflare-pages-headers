import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureRoot = path.join(repositoryRoot, "fixtures", "astro-consumer");
const directory = process.argv[2] ? path.resolve(process.argv[2]) : fixtureRoot;
const candidates = (await fs.readdir(directory)).filter(
  (name) =>
    name.startsWith("astro-cloudflare-pages-headers-") && name.endsWith(".tgz"),
);
if (candidates.length !== 1)
  throw new Error(
    "Expected exactly one package tarball in " +
      directory +
      ", found " +
      candidates.length +
      ".",
  );
const absolute = path.join(directory, candidates[0]);
if (process.env.GITHUB_OUTPUT)
  await fs.appendFile(process.env.GITHUB_OUTPUT, "tarball=" + absolute + "\n");
else process.stdout.write(absolute + "\n");
