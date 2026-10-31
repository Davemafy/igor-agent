import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: "./browser",
  testMatch: /reference-(integrated|twelve|populated)\.e2e\.ts$/,
  workers: 1,
  timeout: 60000,
  outputDir: "../test-results/reference-integrated/raw",
  use: {
    baseURL: "http://127.0.0.1:3580",
    viewport: { width: 1440, height: 900 },
    headless: true,
  },
  webServer: {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    command: "npm start -- --port 3580",
    url: "http://127.0.0.1:3580/",
    timeout: 90000,
    reuseExistingServer: false,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      IGOR_TEST_FIXTURES: "1",
      QLOO_API_KEY: "",
      QLOO_MAX_CALLS: "0",
      IGOR_QLOO_RECORDING: "",
      IGOR_DB_PATH: ".igor/reference-integrated/tasks.sqlite",
      IGOR_AUTH_PATH: ".igor/reference-integrated/auth.sqlite",
      IGOR_OUTCOMES_PATH: ".igor/reference-integrated/outcomes.sqlite",
    },
  },
});
