import { execSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for Wildflower CRM end-to-end tests.
 *
 * Auth: Tests use @clerk/testing's setupClerkTestingToken to sign in
 * programmatically. This requires CLERK_SECRET_KEY to be set (same key the
 * API server already uses). The token is injected via the Clerk Testing
 * infrastructure so no real sign-in UI is driven.
 *
 * BaseURL: In the Replit dev environment the app proxy sits at localhost:80
 * (shared reverse-proxy) and is also reachable at the REPLIT_DEV_DOMAIN https
 * origin. Both resolve to the same running Vite dev server.
 */

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:80";

// On NixOS (the Replit environment) the Playwright-downloaded Chromium can't
// load its shared libraries; use the Nix-provided system Chromium instead
// (absolute path resolved from PATH). Override with PLAYWRIGHT_CHROMIUM_PATH;
// on conventional hosts (neither set) the default Playwright download is used.
function systemChromium(): string | undefined {
  try {
    return execSync("which chromium", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? systemChromium();

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    ...(chromiumPath
      ? { launchOptions: { executablePath: chromiumPath } }
      : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
