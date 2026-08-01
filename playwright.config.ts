import { defineConfig, devices } from "@playwright/test";

const localBaseUrl = "http://127.0.0.1:3210";
const externalBaseUrl = process.env.E2E_BASE_URL?.trim();

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: externalBaseUrl || localBaseUrl,
    locale: "en-US",
    timezoneId: "America/New_York",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "npm run e2e:serve",
        url: localBaseUrl,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          DATABASE_URL: "./data/e2e.db",
          ATTACHMENTS_DIR: "./data/e2e-attachments",
          NODE_ENV: "test",
          REGISTRATION_MODE: "open",
        },
      },
});
