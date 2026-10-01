export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: {
    configFile: "vitest.config.ts",
    related: true,
  },
  mutate: [
    "src/headers-config.ts",
    "src/headers-file.ts",
    "src/integration.ts",
    "src/output-path.ts",
    "src/runtime-core.ts",
    "src/runtime.ts",
  ],
  reporters: ["clear-text", "html"],
  coverageAnalysis: "perTest",
  concurrency: 2,
  timeoutMS: 20000,
  thresholds: {
    high: 85,
    low: 85,
    break: 85,
  },
};
