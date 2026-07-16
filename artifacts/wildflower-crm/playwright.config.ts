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

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
