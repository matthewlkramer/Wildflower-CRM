// One-shot, re-runnable promotion of imported bank evidence into the
// bank-spine derived tables and payout matches.
//
// Usage (dev):  DATABASE_URL=postgresql://... pnpm --filter @workspace/scripts run recompute:bank-spine
// For prod, a human runs it pointing at the $PROD_DATABASE_URL secret
// (never $DATABASE_URL, which is dev):
//   DATABASE_URL="$PROD_DATABASE_URL" pnpm --filter @workspace/scripts run recompute:bank-spine
//
// recomputeBankSpine is fill-only and idempotent. It never overwrites human
// resolutions, so this command is safe to re-run after importing bank rows.

import path from "node:path";
import { pool } from "@workspace/db";

async function diagnostics(): Promise<{
  bankDeposits: number;
  unmatchedPaidPositivePayouts: number;
}> {
  const result = await pool.query<{
    bank_deposits: number;
    unmatched_paid_positive_payouts: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM bank_deposits) AS bank_deposits,
      (
        SELECT count(*)::int
        FROM stripe_payouts
        WHERE status = 'paid'
          AND amount > 0
          AND bank_deposit_id IS NULL
      ) AS unmatched_paid_positive_payouts
  `);
  return {
    bankDeposits: result.rows[0].bank_deposits,
    unmatchedPaidPositivePayouts: result.rows[0].unmatched_paid_positive_payouts,
  };
}

async function main(): Promise<void> {
  const before = await diagnostics();
  console.log("bank-spine before:", before);

  const modulePath = path.resolve(
    import.meta.dirname,
    "../../artifacts/api-server/src/lib/bankSpineRecompute.ts",
  );
  const { recomputeBankSpine } = (await import(modulePath)) as {
    recomputeBankSpine: () => Promise<void>;
  };
  await recomputeBankSpine();

  const after = await diagnostics();
  console.log("bank-spine after:", after);
  await pool.end();
}

main().catch(async (error) => {
  console.error("bank-spine recompute failed:", error);
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
