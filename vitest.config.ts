import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/properties/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/types.ts"],
      reporter: ["text", "json", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 95,
        lines: 95,
        functions: 95,
        branches: 90,
      },
    },
  },
});
