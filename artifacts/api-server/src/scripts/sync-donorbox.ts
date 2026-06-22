/**
 * Manual one-shot Donorbox donation pull.
 *
 *   pnpm --filter @workspace/api-server run sync:donorbox
 *
 * Env overrides:
 *   DONORBOX_FULL_RESYNC=1  ignore the watermark and re-walk the full history,
 *                           refreshing read-only facts on every row (review state
 *                           is always preserved).
 *
 * Goes through `syncDonorbox`, so it takes the same global advisory lock and
 * records run-state — it will never collide with the scheduled run or another
 * manual invocation. Skips cleanly (no-op) when the Donorbox API credentials are
 * not configured.
 */
import { logger } from "../lib/logger";
import { syncDonorbox } from "../lib/donorboxSync";

async function main() {
  const fullResync = process.env["DONORBOX_FULL_RESYNC"] === "1";
  const summary = await syncDonorbox({ fullResync });

  if (!summary.ran) {
    logger.warn(
      "sync:donorbox skipped — not configured or another run holds the lock",
    );
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  logger.info({ summary }, "sync:donorbox complete");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "sync:donorbox failed");
  process.exit(1);
});
