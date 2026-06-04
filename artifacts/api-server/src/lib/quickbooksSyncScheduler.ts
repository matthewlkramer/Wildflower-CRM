import { logger } from "./logger";
import { syncQuickbooks } from "./quickbooksSync";

/**
 * In-process scheduler for the one-way QuickBooks payment pull. Unlike the
 * media-ingest sweep, an incremental QuickBooks pull is cheap (watermark-
 * filtered), so we just run it on a fixed interval throughout the day.
 * Concurrency is guarded inside syncQuickbooks via a pg advisory lock, so
 * overlapping ticks / a manual "sync now" can't collide.
 */

const SYNC_INTERVAL_MS = 30 * 60_000; // every 30 minutes

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const summary = await syncQuickbooks();
    if (summary.ran && (summary.staged > 0 || summary.pulled > 0)) {
      logger.info({ summary }, "QuickBooks sync tick complete");
    }
  } catch (err) {
    // syncQuickbooks already records lastError on the connection row.
    logger.error({ err }, "QuickBooks sync tick failed");
  }
}

export function startQuickbooksSyncScheduler(): void {
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") return;
  if (process.env["DISABLE_QUICKBOOKS_SYNC"] === "1") {
    logger.info(
      "QuickBooks sync scheduler disabled via DISABLE_QUICKBOOKS_SYNC=1",
    );
    return;
  }
  if (timer) return;
  logger.info(
    { intervalMs: SYNC_INTERVAL_MS },
    "Starting QuickBooks sync scheduler",
  );
  timer = setInterval(() => {
    void tick();
  }, SYNC_INTERVAL_MS);
  timer.unref?.();
}

export function stopQuickbooksSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
