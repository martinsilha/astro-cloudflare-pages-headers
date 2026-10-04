import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rows = JSON.parse(
  await fs.readFile(
    path.join(root, "fixtures", "astro-consumer", "compatibility-matrix.json"),
    "utf8",
  ),
);
const matrix = JSON.stringify({ include: rows });
if (process.env.GITHUB_OUTPUT)
  await fs.appendFile(process.env.GITHUB_OUTPUT, "matrix=" + matrix + "\n");
else process.stdout.write(matrix + "\n");
