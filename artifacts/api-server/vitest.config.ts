import { defineConfig } from "vitest/config";

// The suite is DB-bound, not CPU-bound: each test file seeds its own
// run-prefixed rows and spends most wall time awaiting Postgres. So we run
// more test files in parallel than the container has CPUs.
export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 6,
    // Provisions <devdb>_test (create + schema push when changed) and points
    // DATABASE_URL at it before any worker forks — tests never touch the live
    // dev DB the API server's schedulers run against.
    globalSetup: ["./src/test/global-setup.ts"],
    projects: [
      {
        test: {
          name: "unit",
          pool: "forks",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts", "**/node_modules/**"],
        },
      },
      {
        test: {
          name: "integration",
          pool: "forks",
          include: ["src/**/*.integration.test.ts"],
          exclude: ["**/node_modules/**"],
          // Integration files boot their own server on port 0 and seed
          // unique-prefixed rows, so they can run concurrently against the
          // dedicated test DB (see global-setup.ts).
          // 6 files hammering Postgres at once makes individual queries
          // slower than in isolation; the vitest default 5s timeout produced
          // false failures under full parallelism.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
