import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", timeout: 45_000, expect: { timeout: 10_000 }, workers: 2,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: process.env.RETURNS_DESK_BASE_URL ?? "http://127.0.0.1:8787", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) } }],
  ...(process.env.RETURNS_DESK_BASE_URL ? {} : { webServer: { command: "node scripts/local-preview.mjs", url: "http://127.0.0.1:8787/api/v1/health", reuseExistingServer: !process.env.CI, timeout: 120_000 } }),
});

