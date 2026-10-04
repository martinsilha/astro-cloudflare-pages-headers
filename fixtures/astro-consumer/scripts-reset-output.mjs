import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('.', import.meta.url);
const major = Number(process.env.FIXTURE_ASTRO_MAJOR);
const variant = process.env.FIXTURE_WITH_ADAPTER === 'true' ? 'workers' : 'pages';
const paths = [
  `output ${major}-${variant}`,
  'dist',
  `client ${major}`,
  `server ${major}`,
];
await Promise.all(paths.map((path) => fs.rm(new URL(path, root), { recursive: true, force: true })));
