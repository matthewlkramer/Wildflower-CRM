import { logger } from "./logger";
import { syncFy27CodingForm } from "./codingFormIngest";
import { isGoogleSheetsConfigured } from "./googleSheetsCsv";

/**
 * In-process scheduler for the FY27 coding-form sheet ingest. Same pattern as
 * the Donorbox scheduler: run once shortly after startup, then on a fixed
 * interval (daily — the form gets a handful of responses a week). Concurrency
 * is guarded inside syncFy27CodingForm via the shared pg advisory sync lock,
 * so overlapping ticks or multiple server instances can't collide. Failures
 * are logged and never crash the server; the next tick retries without a
 * restart.
 */

const SYNC_INTERVAL_MS = 24 * 60 * 60_000; // once a day
const STARTUP_DELAY_MS = 30_000; // let the server settle first

let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const summary = await syncFy27CodingForm();
    if (summary.ran) {
      logger.info({ summary }, "FY27 coding-form sync tick complete");
    }
  } catch (err) {
    logger.error({ err }, "FY27 coding-form sync tick failed");
  }
}

export function startCodingFormSyncScheduler(): void {
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") return;
  if (process.env["DISABLE_CODING_FORM_SYNC"] === "1") {
    logger.info(
      "FY27 coding-form sync scheduler disabled via DISABLE_CODING_FORM_SYNC=1",
    );
    return;
  }
  if (!isGoogleSheetsConfigured()) {
    logger.info(
      "FY27 coding-form sync scheduler: Google connector unavailable, not scheduling",
    );
    return;
  }
  if (timer) return;
  logger.info(
    { intervalMs: SYNC_INTERVAL_MS, startupDelayMs: STARTUP_DELAY_MS },
    "Starting FY27 coding-form sync scheduler",
  );
  startupTimer = setTimeout(() => {
    void tick();
  }, STARTUP_DELAY_MS);
  startupTimer.unref?.();
  timer = setInterval(() => {
    void tick();
  }, SYNC_INTERVAL_MS);
  timer.unref?.();
}

export function stopCodingFormSyncScheduler(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
