/**
 * Manual one-shot Flodesk unsubscribe reconcile (Flodesk → CRM).
 *
 *   pnpm --filter @workspace/api-server run sync:flodesk
 *
 * Env overrides:
 *   FLODESK_RECONCILE_MAX_PAGES  cap pages scanned (default: 100)
 *   FLODESK_RECONCILE_PER_PAGE   page size, 1..100 (default: 100)
 *
 * Forces an immediate run (bypasses the daily-due check and the off-hours
 * window) but goes through `runFlodeskSyncIfDue`, so it takes the same global
 * advisory lock and records run-state — it will never collide with the
 * scheduled run or another manual invocation. Fails loudly when the Flodesk
 * API key / segment id are not configured.
 */
import { logger } from "../lib/logger";
import { runFlodeskSyncIfDue } from "../lib/flodeskSyncScheduler";

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
  const maxPages = intEnv("FLODESK_RECONCILE_MAX_PAGES");
  const perPage = intEnv("FLODESK_RECONCILE_PER_PAGE");

  const summary = await runFlodeskSyncIfDue({
    force: true,
    ...(maxPages != null ? { maxPages } : {}),
    ...(perPage != null ? { perPage } : {}),
  });

  if (summary == null) {
    logger.warn("sync:flodesk skipped — another run holds the global lock");
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({ skipped: true, reason: "lock_contended" }, null, 2),
    );
    process.exit(0);
  }

  logger.info({ summary }, "sync:flodesk complete");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "sync:flodesk failed");
  process.exit(1);
});
