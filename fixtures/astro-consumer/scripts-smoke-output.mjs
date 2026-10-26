import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const major = Number(process.env.FIXTURE_ASTRO_MAJOR);
const withAdapter = process.env.FIXTURE_WITH_ADAPTER !== 'false';
const variant = withAdapter ? 'workers' : 'pages';
const output = path.join(root, process.env.FIXTURE_LAYOUT === 'default' ? 'dist' : `output ${major}-${variant}`);

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function ruleFields(content, pattern) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === pattern && !line.startsWith('#'));
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && (!lines[end] || /^\s/.test(lines[end]) || lines[end].startsWith('#'))) end += 1;
  return lines.slice(start + 1, end).join('\n');
}

if (!withAdapter) {
  const headers = path.join(output, '_headers');
  if (!await exists(headers)) throw new Error(`Expected static _headers at ${headers}`);
  const body = await fs.readFile(headers, 'utf8');
  if (!body.includes(`X-Fixture-Header: astro-${major}`)) throw new Error('Generated headers are missing from static output.');
  const wildcardRule = ruleFields(body, '/*');
  if (!wildcardRule.includes('X-Manual-Header: preserve') || wildcardRule.match(/X-Manual-Header: preserve/g)?.length !== 1) throw new Error('Manual public/_headers content was lost or duplicated within its wildcard rule in static output.');
  if (!body.includes('X-Shared-Header: manual') || !body.includes('X-Shared-Header: configured')) throw new Error('Manual and generated same-path headers were not merged in static output.');
  const keeps = await findNamedFiles(output, 'keep.txt');
  if (keeps.length === 0 || (await fs.readFile(keeps[0], 'utf8')) !== 'fixture file remains untouched\n') throw new Error('Unrelated public file was changed or missing in static output.');
  console.log(`Static Pages output verified: ${headers}`);
  process.exit(0);
}

async function findWrangler(directory) {
  if (!await exists(directory)) return [];
  const matches = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...await findWrangler(full));
    else if (/^wrangler\.(jsonc?|toml)$/.test(entry.name)) matches.push(full);
  }
  return matches;
}

const configs = await findWrangler(output);
const destinations = [];
for (const configPath of configs) {
  const source = await fs.readFile(configPath, 'utf8');
  const match = source.match(/"directory"\s*:\s*"([^"]+)"/) ?? source.match(/^\s*directory\s*=\s*["']([^"']+)["']/m);
  if (match) destinations.push(path.resolve(path.dirname(configPath), match[1]));
}
destinations.push(output, path.join(root, `client ${major}`), path.join(root, `client ${major}`, 'docs'));
const found = [];
for (const destination of new Set(destinations)) {
  const headers = path.join(destination, '_headers');
  if (await exists(headers)) found.push(headers);
}
if (found.length === 0) throw new Error(`Could not find generated _headers in adapter output. Wrangler configs: ${configs.join(', ')}`);
const contents = await Promise.all(found.map((filename) => fs.readFile(filename, 'utf8')));
const deploymentHeaders = path.join(path.dirname(found[0]), '_headers');
const deploymentContent = await fs.readFile(deploymentHeaders, 'utf8');
const layout = process.env.FIXTURE_LAYOUT ?? 'custom';
const assetPattern = layout === 'default' ? '/_astro/*' : '/docs/_astro/*';
const assetFields = ruleFields(deploymentContent, assetPattern);
const [adapterMajor, adapterMinor] = (process.env.FIXTURE_ADAPTER_VERSION ?? '').split('.').map(Number);
const adapterInjectsCache = adapterMajor > 13 || (adapterMajor === 13 && adapterMinor >= 7);
const verifyAdapterCache = process.env.FIXTURE_CACHE_MODE === 'manual' || process.env.FIXTURE_CACHE_MODE === 'full' || adapterInjectsCache || !process.env.FIXTURE_ADAPTER_VERSION;
if (process.env.FIXTURE_CACHE_MODE === 'integration') {
  if (!deploymentContent.includes('# Added by another fixture integration')) throw new Error('The second integration did not contribute its cache rule to the deployable assets.');
  if (assetFields.split(/\r?\n/).filter((line) => line.trim() === 'Cache-Control: public, max-age=31536000, immutable').length !== 1) {
    throw new Error(`The identical cache rule from another integration was not preserved and deduplicated: ${deploymentHeaders}`);
  }
}
if (verifyAdapterCache) {
  const expectedCacheControl = process.env.FIXTURE_CACHE_MODE === 'full' ? 'public, max-age=300' : 'public, max-age=31536000, immutable';
  if (assetFields.split(/\r?\n/).filter((line) => line.trim() === `Cache-Control: ${expectedCacheControl}`).length !== 1) {
    throw new Error(`Expected one ${expectedCacheControl} cache policy for ${assetPattern}: ${deploymentHeaders}`);
  }
}
if (!deploymentContent.includes(`X-Fixture-Header: astro-${major}`)) {
  throw new Error(`Deployable asset root lacks configured headers: ${deploymentHeaders}`);
}
const wildcardRule = deploymentContent.match(/^\/\*[ \t]*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] ?? '';
if (!wildcardRule.includes('X-Manual-Header: preserve') || wildcardRule.match(/X-Manual-Header: preserve/g)?.length !== 1) {
  throw new Error(`Manual public/_headers content was lost or duplicated within its wildcard rule: ${deploymentHeaders}`);
}
if (!deploymentContent.includes('X-Shared-Header: manual') || !deploymentContent.includes('X-Shared-Header: configured')) {
  throw new Error(`Manual and generated same-path headers were not merged: ${deploymentHeaders}`);
}
const serverRoot = path.join(root, layout === 'default' ? 'dist/server' : `server ${major}`);
for (const nested of await findNamedFiles(serverRoot, '_headers')) {
  throw new Error(`Generated _headers was written into the server bundle: ${nested}`);
}
const keeps = [];
for (const destination of new Set(destinations)) keeps.push(...await findNamedFiles(destination, 'keep.txt'));
if (keeps.length === 0) throw new Error('Unrelated public file was not copied into the deployable asset tree.');
for (const keep of keeps) {
  if ((await fs.readFile(keep, 'utf8')) !== 'fixture file remains untouched\n') throw new Error(`Unrelated public file changed: ${keep}`);
}
console.log(`Cloudflare adapter output verified: ${deploymentHeaders}`);

async function findNamedFiles(directory, name) {
  if (!await exists(directory)) return [];
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findNamedFiles(full, name));
    else if (entry.isFile() && entry.name === name) found.push(full);
  }
  return found;
}
