import { defineConfig } from "@playwright/test";

const projects = (process.env.PLAYWRIGHT_PROJECTS ?? "chromium")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  outputDir: "test-results/playwright",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:45731",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: projects.map((name) => ({
    name,
    use: { browserName: name as "chromium" | "firefox" | "webkit" },
  })),
});
