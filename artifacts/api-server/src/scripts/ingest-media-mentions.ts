/**
 * Manual one-shot GDELT media-mention ingestion.
 *
 *   pnpm --filter @workspace/api-server run ingest:media
 *
 * Env overrides:
 *   MEDIA_INGEST_MAX_ENTITIES   cap entities processed (default: all)
 *   MEDIA_INGEST_TIMESPAN_DAYS  lookback window in days (default: 2)
 *   MEDIA_INGEST_THROTTLE_MS    delay between GDELT calls (default: 1500)
 *
 * Forces an immediate run (bypasses the daily-due check and the off-hours
 * window) but goes through `runMediaIngestIfDue`, so it takes the same global
 * advisory lock and records run-state — it will never collide with the
 * scheduled run or another manual invocation.
 */
import { logger } from "../lib/logger";
import { runMediaIngestIfDue } from "../lib/mediaIngestScheduler";

/** Parse a positive-integer env override, ignoring blank/invalid values. */
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
  const maxEntities = intEnv("MEDIA_INGEST_MAX_ENTITIES");
  const timespanDays = intEnv("MEDIA_INGEST_TIMESPAN_DAYS");
  const throttleMs = intEnv("MEDIA_INGEST_THROTTLE_MS");

  const summary = await runMediaIngestIfDue({
    force: true,
    ...(maxEntities != null ? { maxEntities } : {}),
    ...(timespanDays != null ? { timespanDays } : {}),
    ...(throttleMs != null ? { throttleMs } : {}),
  });

  if (summary == null) {
    logger.warn("ingest:media skipped — another run holds the global lock");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ skipped: true, reason: "lock_contended" }, null, 2));
    process.exit(0);
  }

  logger.info({ summary }, "ingest:media complete");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "ingest:media failed");
  process.exit(1);
});
