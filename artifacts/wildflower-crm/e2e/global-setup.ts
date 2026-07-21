/**
 * Playwright global setup: obtains a Clerk testing token so
 * setupClerkTestingToken can bypass bot protection in specs.
 *
 * Reads CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY from the environment (the
 * same keys the API server already uses).
 */

import { clerkSetup } from "@clerk/testing/playwright";

export default async function globalSetup(): Promise<void> {
  await clerkSetup({
    publishableKey:
      process.env.CLERK_PUBLISHABLE_KEY ??
      process.env.VITE_CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
  });
}
