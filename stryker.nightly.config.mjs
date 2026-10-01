import base from "./stryker.config.mjs";

export default {
  ...base,
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.d.ts"],
  concurrency: 2,
};
