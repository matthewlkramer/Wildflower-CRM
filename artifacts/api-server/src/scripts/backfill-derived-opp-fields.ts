/**
 * One-shot backfill: recompute the derived fields (status, writtenPledge,
 * stage auto-advance) on every existing opportunities_and_pledges row
 * by calling the same applyDerivedOppFields helper the write paths use.
 *
 * Idempotent — safe to re-run. Prints a progress dot every 100 rows
 * and a final summary.
 *
 * Run with: pnpm --filter @workspace/api-server run backfill:derived-opps
 */
import { db } from "@workspace/db";
import { opportunitiesAndPledges } from "@workspace/db/schema";
import { applyDerivedOppFields } from "../lib/pledgeStage";

async function main(): Promise<void> {
  const rows = await db
    .select({ id: opportunitiesAndPledges.id })
    .from(opportunitiesAndPledges);
  console.log(`Backfilling derived fields on ${rows.length} opportunities…`);

  let done = 0;
  for (const { id } of rows) {
    await applyDerivedOppFields(id);
    done++;
    if (done % 100 === 0) process.stdout.write(".");
  }
  console.log(`\nDone. Processed ${done} rows.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
