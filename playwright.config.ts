import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config — runs E2E tests against the local mock server.
 * In CI (GitHub Actions), the mock server is started as a background
 * job before tests run. Locally, set up `webServer` so `npx playwright test`
 * auto-starts and tears down the server.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : "list",

  use: {
    baseURL: "http://localhost:4321",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  webServer: {
    command: "node scripts/serve-mock.js 4321",
    url: "http://localhost:4321",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
