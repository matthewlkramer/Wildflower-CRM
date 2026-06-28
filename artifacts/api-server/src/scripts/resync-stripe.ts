/**
 * Manual one-shot NON-destructive Stripe full re-pull (historical backfill).
 *
 *   pnpm --filter @workspace/api-server run resync:stripe
 *
 * Lifts the per-account watermark floor to re-walk the entire Stripe payout
 * back-catalogue and backfill the payout + charge records the ongoing sync never
 * pulled (the first-ever run seeds the watermark to "now", so anything before
 * the sync was first switched on — e.g. 2019–2021 payouts — was never staged).
 * PRESERVES ALL review state — status, donor match, exclusion and grouping are
 * never touched (the upsert refreshes only read-only Stripe facts). Goes through
 * `syncStripe`, so it takes the same per-account advisory lock and will never
 * collide with the scheduled run.
 *
 * After it completes, run the historical proposal pass
 * (POST /stripe/reconciliation/propose-historical, or the "Propose historical
 * matches" admin button) to tie the freshly-pulled payouts to their QB deposits.
 */
import { logger } from "../lib/logger";
import { syncStripe } from "../lib/stripeSync";

async function main() {
  const summary = await syncStripe({ fullResync: true });

  if (!summary.ran) {
    logger.warn("resync:stripe skipped — no Stripe connection or lock held");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ skipped: true, ...summary }, null, 2));
    process.exit(0);
  }

  logger.info({ summary }, "resync:stripe complete");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "resync:stripe failed");
  process.exit(1);
});
