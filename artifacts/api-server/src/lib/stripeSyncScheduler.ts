import { logger } from "./logger";
import { syncStripe } from "./stripeSync";
import { stripeConfigured } from "./stripeClient";

/**
 * In-process scheduler for the ongoing one-way Stripe payout pull. Like the
 * QuickBooks scheduler, an incremental pull is cheap (watermark-filtered), so we
 * run it on a fixed interval. Concurrency is guarded inside syncStripe via a pg
 * advisory lock (per Stripe account), so overlapping ticks / a manual "sync now"
 * can't collide.
 */

const SYNC_INTERVAL_MS = 30 * 60_000; // every 30 minutes

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const summary = await syncStripe();
    if (summary.ran && (summary.staged > 0 || summary.payouts > 0)) {
      logger.info({ summary }, "Stripe sync tick complete");
    }
  } catch (err) {
    // syncStripe already records lastError on the sync-state row.
    logger.error({ err }, "Stripe sync tick failed");
  }
}

export function startStripeSyncScheduler(): void {
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") return;
  if (process.env["DISABLE_STRIPE_SYNC"] === "1") {
    logger.info("Stripe sync scheduler disabled via DISABLE_STRIPE_SYNC=1");
    return;
  }
  // Neither a restricted key nor a connector in this environment → nothing to
  // pull; stay a no-op.
  if (!stripeConfigured()) {
    logger.info(
      "Stripe sync scheduler: no restricted key or connector, not scheduling",
    );
    return;
  }
  if (timer) return;
  logger.info(
    { intervalMs: SYNC_INTERVAL_MS },
    "Starting Stripe sync scheduler",
  );
  timer = setInterval(() => {
    void tick();
  }, SYNC_INTERVAL_MS);
  timer.unref?.();
}

export function stopStripeSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
