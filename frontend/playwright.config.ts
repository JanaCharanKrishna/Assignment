import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: process.env.UI_BASE_URL || "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5173",
    url: process.env.UI_BASE_URL || "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 120000,
  },
  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],
});
