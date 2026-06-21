/**
 * One-shot backfill: recompute and persist `quickbooks_tie_status` on every
 * existing gifts_and_payments row by calling the same applyGiftQbTieMany helper
 * the write paths use (INV-2 / INV-3 / INV-10).
 *
 * Idempotent — safe to re-run. Batches the recompute and prints a progress dot
 * every 500 rows plus a final summary.
 *
 * Run with: pnpm --filter @workspace/api-server run backfill:gift-qb-tie
 */
import { db } from "@workspace/db";
import { giftsAndPayments } from "@workspace/db/schema";
import { applyGiftQbTieMany } from "../lib/giftQbTie";

const BATCH = 200;

async function main(): Promise<void> {
  const rows = await db
    .select({ id: giftsAndPayments.id })
    .from(giftsAndPayments);
  console.log(`Backfilling QuickBooks tie status on ${rows.length} gifts…`);

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => r.id);
    await applyGiftQbTieMany(...batch);
    done += batch.length;
    if (done % 500 < BATCH) process.stdout.write(".");
  }
  console.log(`\nDone. Processed ${done} rows.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
