import { defineConfig } from "@playwright/test";
import path from "node:path";
export default defineConfig({
  testDir: ".",
  testMatch: "conference-document-import.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:54121",
    headless: true,
    ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL }
      : {}),
  },
  webServer: {
    cwd: path.resolve(import.meta.dirname, ".."),
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1",
    url: "http://127.0.0.1:54121/e2e/fixtures/conference-import.html",
    reuseExistingServer: false,
    env: { PORT: "54121", BASE_PATH: "/" },
  },
  timeout: 60000,
});
