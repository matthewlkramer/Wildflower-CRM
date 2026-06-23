/**
 * Manual one-shot Airtable → schools sync.
 *
 *   pnpm --filter @workspace/api-server run sync:schools
 *
 * Env overrides:
 *   SCHOOL_SYNC_MAX_PAGES   cap pages walked from Airtable (default: 1000)
 *   SCHOOL_SYNC_PAGE_SIZE   page size, 1..100 (default: 100)
 *
 * Forces an immediate run (bypasses the daily-due check and the off-hours
 * window) but goes through `runSchoolSyncIfDue`, so it takes the same global
 * advisory lock and records run-state — it will never collide with the
 * scheduled run or another manual invocation. Fails loudly when Airtable is
 * not configured (no AIRTABLE_TOKEN and connector not bound).
 */
import { logger } from "../lib/logger";
import { runSchoolSyncIfDue } from "../lib/schoolSyncScheduler";

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    logger.warn({ name, raw }, "ignoring invalid env override");
    return undefined;
  }
  return Math.floor(n);
}

async function main() {
  const maxPages = intEnv("SCHOOL_SYNC_MAX_PAGES");
  const pageSize = intEnv("SCHOOL_SYNC_PAGE_SIZE");

  const summary = await runSchoolSyncIfDue({
    force: true,
    ...(maxPages != null ? { maxPages } : {}),
    ...(pageSize != null ? { pageSize } : {}),
  });

  if (summary == null) {
    logger.warn("sync:schools skipped — another run holds the global lock");
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({ skipped: true, reason: "lock_contended" }, null, 2),
    );
    process.exit(0);
  }

  logger.info(
    {
      schoolsFetched: summary.schoolsFetched,
      schoolsUpserted: summary.schoolsUpserted,
      staleInDb: summary.stale.length,
    },
    "sync:schools complete",
  );
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "sync:schools failed");
  process.exit(1);
});
