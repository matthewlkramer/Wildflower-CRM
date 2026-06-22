import { logger } from "./logger";
import { syncDonorbox } from "./donorboxSync";
import { isDonorboxConfigured } from "./donorboxClient";

/**
 * In-process scheduler for the ongoing one-way Donorbox donation pull. Like the
 * Stripe/QuickBooks schedulers, an incremental pull is cheap (watermark + overlap
 * window), so we run it on a fixed interval. Concurrency is guarded inside
 * syncDonorbox via a pg advisory lock (the "donorbox" source tag), so overlapping
 * ticks or a manual "sync now" can't collide.
 */

const SYNC_INTERVAL_MS = 30 * 60_000; // every 30 minutes

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const summary = await syncDonorbox();
    if (summary.ran && summary.upserted > 0) {
      logger.info({ summary }, "Donorbox sync tick complete");
    }
  } catch (err) {
    // syncDonorbox already records lastError on the sync-state row.
    logger.error({ err }, "Donorbox sync tick failed");
  }
}

export function startDonorboxSyncScheduler(): void {
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") return;
  if (process.env["DISABLE_DONORBOX_SYNC"] === "1") {
    logger.info("Donorbox sync scheduler disabled via DISABLE_DONORBOX_SYNC=1");
    return;
  }
  if (!isDonorboxConfigured()) {
    logger.info(
      "Donorbox sync scheduler: no API credentials, not scheduling",
    );
    return;
  }
  if (timer) return;
  logger.info(
    { intervalMs: SYNC_INTERVAL_MS },
    "Starting Donorbox sync scheduler",
  );
  timer = setInterval(() => {
    void tick();
  }, SYNC_INTERVAL_MS);
  timer.unref?.();
}

export function stopDonorboxSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
