export const CANARY_RESOURCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function workerCanaryCreatedAt(name) {
  const match = /^astro-headers-canary-worker-(?:6|7)-([0-9a-z]+)-/i.exec(name);
  if (!match) return undefined;
  const timestamp = Number.parseInt(match[1], 36);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

export function pagesCanaryCreatedAt(branch) {
  const match = /^canary-[0-9]{8}-([0-9a-z]+)-/i.exec(branch);
  if (!match) return undefined;
  const timestamp = Number.parseInt(match[1], 36);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

export function kvCanaryCreatedAt(title) {
  const match = /^astro-headers-canary-session-(?:6|7)-([0-9]{13})-/i.exec(
    title,
  );
  if (!match) return undefined;
  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

export function isStaleCanary(
  createdAt,
  now = Date.now(),
  maxAge = CANARY_RESOURCE_MAX_AGE_MS,
) {
  return Number.isSafeInteger(createdAt) && createdAt <= now - maxAge;
}
