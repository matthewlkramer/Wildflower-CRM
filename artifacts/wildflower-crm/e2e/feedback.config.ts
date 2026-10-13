import { defineConfig } from "@playwright/test";
import path from "node:path";
export default defineConfig({
  testDir: ".",
  testMatch: "feedback.spec.ts",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:54122",
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    cwd: path.resolve(import.meta.dirname, ".."),
    command:
      "node node_modules/vite/bin/vite.js --config e2e/feedback-vite.config.ts",
    url: "http://127.0.0.1:54122/e2e/fixtures/feedback.html",
    reuseExistingServer: false,
  },
});
