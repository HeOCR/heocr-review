import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:18787", trace: "retain-on-failure" },
  webServer: { command: "sh test/e2e/start.sh", url: "http://127.0.0.1:18787/api/config", timeout: 120_000, reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
});
