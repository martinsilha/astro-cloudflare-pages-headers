import { createHash } from 'node:crypto';

function inlineScriptHash(html) {
  const match = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Expected an inline script in the CSP fixture page.');
  const digest = createHash('sha256').update(match[1], 'utf8').digest('base64');
  return "'sha256-" + digest + "'";
}

function splitPolicies(value) {
  return value.split(/,\s*(?=[a-z][a-z0-9-]*\s)/i);
}

function assertPolicies(response, expectedHashes, label) {
  const value = response.headers.get('content-security-policy') ?? '';
  if (!value) throw new Error(label + ' response is missing Content-Security-Policy.');
  const policies = splitPolicies(value);
  if (policies.length !== 2) throw new Error(label + ' should preserve both CSP policies: ' + value);
  if (!policies[0].toLowerCase().includes("default-src 'self'") || !policies[1].toLowerCase().includes("default-src 'none'")) {
    throw new Error(label + ' lost an original CSP policy: ' + value);
  }
  for (const hash of expectedHashes) {
    if (!policies.every((policy) => policy.includes(hash))) throw new Error(label + ' policy did not independently allow ' + hash + ': ' + value);
  }
  return value;
}

export async function assertCspResponses(origin, mode) {
  const handling = process.env.FIXTURE_HTML_HANDLING ?? 'auto-trailing-slash';
  const fileFormat = process.env.FIXTURE_BUILD_FORMAT === 'file';
  const paths = fileFormat
    ? handling === 'none'
      ? ['/docs/index.html', '/docs/about.html', '/docs/plain.html']
      : handling === 'force-trailing-slash'
        ? ['/docs/', '/docs/about/', '/docs/plain/']
        : ['/docs/', '/docs/about', '/docs/plain']
    : handling === 'none'
      ? ['/docs/index.html', '/docs/about/index.html', '/docs/plain/index.html']
      : handling === 'drop-trailing-slash'
        ? ['/docs', '/docs/about', '/docs/plain']
        : ['/docs/', '/docs/about/', '/docs/plain/'];
  const [index, about, plain] = await Promise.all(paths.map((pathname) => fetch(new URL(pathname, origin))));
  if ([index, about, plain].some((response) => response.status !== 200)) {
    throw new Error('CSP route responses were not all served: ' + [index.status, about.status, plain.status].join(', ') + '.');
  }
  const [indexBody, aboutBody, plainBody] = await Promise.all([index.text(), about.text(), plain.text()]);
  const indexHash = inlineScriptHash(indexBody);
  const aboutHash = inlineScriptHash(aboutBody);
  if (indexHash === aboutHash) throw new Error('CSP fixture pages unexpectedly share an inline script hash.');

  const pureSsr = process.env.FIXTURE_PURE_SSR === 'true';
  const indexCsp = assertPolicies(index, pureSsr ? [] : mode === 'global' ? [indexHash, aboutHash] : [indexHash], 'index');
  const aboutCsp = assertPolicies(about, pureSsr ? [] : mode === 'global' ? [indexHash, aboutHash] : [aboutHash], 'about');
  const plainCsp = assertPolicies(plain, mode === 'global' ? [indexHash, aboutHash] : [], 'plain');
  if (pureSsr && [indexCsp, aboutCsp, plainCsp].some((value) => value.includes('sha256-'))) {
    throw new Error('Pure SSR runtime CSP inherited hashes from static HTML expansion.');
  }
  if (!pureSsr && mode === 'route' && (indexCsp.includes(aboutHash) || aboutCsp.includes(indexHash))) {
    throw new Error('Route-mode CSP leaked hashes from a different HTML page.');
  }
  if (plainBody.includes('cspFixture')) throw new Error('The plain route unexpectedly contains inline script content.');
  if (mode === 'route' && plainCsp.includes('sha256-')) throw new Error('A hash-free page did not retain only the wildcard baseline policy.');

  // Route mode writes one exact override with the resolved configured order.
  // Global mode leaves wildcard and exact _headers rules separate for the host
  // to combine, so their effective response order is host-defined.
  if (mode === 'route' && about.headers.get('x-csp-order') !== 'exact, general') {
    throw new Error('Exact and wildcard non-CSP header order changed: ' + about.headers.get('x-csp-order'));
  }

  const stylesheet = indexBody.match(/href="([^"]+\.css)"/)?.[1];
  if (!stylesheet) throw new Error('CSP fixture page did not reference its stylesheet.');
  const asset = await fetch(new URL(stylesheet, origin));
  if (asset.status !== 200) throw new Error('CSP fixture stylesheet was not served.');
  const assetCsp = asset.headers.get('content-security-policy') ?? '';
  if (mode === 'route' && assetCsp.includes('sha256-')) throw new Error('Route-mode page hashes leaked to a static asset.');
  if (mode === 'route' && splitPolicies(assetCsp).length !== 2) throw new Error('Static asset did not retain both wildcard CSP policies.');

  const missing = await fetch(new URL('/docs/csp-unmatched', origin));
  if (missing.status !== 404) throw new Error('Expected a 404 for unmatched CSP URL, received ' + missing.status + '.');
  const missingCsp = missing.headers.get('content-security-policy') ?? '';
  if (!missingCsp || (mode === 'route' && missingCsp.includes('sha256-'))) {
    throw new Error('Unmatched URL did not retain the original wildcard CSP policy.');
  }
  console.log('Local CSP HTTP checks passed in ' + mode + ' mode at ' + origin + '.');
}
