/**
 * Manual one-shot NON-destructive QuickBooks full re-pull (field enrichment).
 *
 *   pnpm --filter @workspace/api-server run resync:quickbooks
 *
 * Ignores the sync watermark to re-fetch the entire QuickBooks back-catalog and
 * re-enrich every existing staged row with the extended QB capture fields
 * (payer type, payment method, raw JSON, etc.). Unlike the destructive cutover
 * this PRESERVES ALL review state — status, donor match, exclusion and grouping
 * are never touched (the upsert refreshes only read-only QB facts). Goes through
 * `syncQuickbooks`, so it takes the same global sync lock and advances the
 * watermark; it will never collide with the scheduled run.
 */
import { logger } from "../lib/logger";
import { syncQuickbooks } from "../lib/quickbooksSync";

async function main() {
  const summary = await syncQuickbooks({ fullResync: true });

  if (!summary.ran) {
    logger.warn("resync:quickbooks skipped — no active connection or lock held");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ skipped: true, ...summary }, null, 2));
    process.exit(0);
  }

  logger.info({ summary }, "resync:quickbooks complete");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "resync:quickbooks failed");
  process.exit(1);
});
