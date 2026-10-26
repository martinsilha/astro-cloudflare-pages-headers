import test from "node:test";
import assert from "node:assert/strict";
import {
  CANARY_RESOURCE_MAX_AGE_MS,
  isStaleCanary,
  kvCanaryCreatedAt,
  pagesCanaryCreatedAt,
  workerCanaryCreatedAt,
} from "./cloudflare-canary-utils.mjs";

test("parses only names owned by the canary suite", () => {
  const timestamp = 1790827556822;
  assert.equal(
    workerCanaryCreatedAt(
      "astro-headers-canary-worker-6-" + timestamp.toString(36) + "-run-123",
    ),
    timestamp,
  );
  assert.equal(
    pagesCanaryCreatedAt(
      "canary-20260930-" + timestamp.toString(36) + "-run-123",
    ),
    timestamp,
  );
  assert.equal(
    kvCanaryCreatedAt(
      "astro-headers-canary-session-7-" + timestamp + "-run-123",
    ),
    timestamp,
  );
  assert.equal(workerCanaryCreatedAt("customer-worker"), undefined);
  assert.equal(pagesCanaryCreatedAt("main"), undefined);
  assert.equal(kvCanaryCreatedAt("customer-session"), undefined);
});

test("stale boundary keeps recent canaries and selects resources at 24 hours", () => {
  const now = 2_000_000_000_000;
  assert.equal(isStaleCanary(now - CANARY_RESOURCE_MAX_AGE_MS + 1, now), false);
  assert.equal(isStaleCanary(now - CANARY_RESOURCE_MAX_AGE_MS, now), true);
  assert.equal(isStaleCanary(undefined, now), false);
  assert.equal(isStaleCanary(Number.NaN, now), false);
});
