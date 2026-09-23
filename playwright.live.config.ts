import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./live-e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 180_000,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium-live", use: { ...devices["Desktop Chrome"] } }],
});
