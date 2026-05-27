import { db } from "@workspace/db";
import { opportunitiesAndPledges, giftsAndPayments } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

// When a pledge's recorded payments cover its full awarded amount,
// advance its stage from `written_commitment` to `cash_in` automatically.
// Intentionally conservative:
//   - Only acts when status='won' (pledges, not open opps) AND
//     stage='written_commitment'. We never downgrade or skip stages.
//   - Only acts when awardedAmount > 0 (zero/null pledges are ignored —
//     "paid >= 0" would otherwise advance every empty record).
//   - Runs as a single UPDATE … WHERE so concurrent writers can't race.
// Returns true when the row was advanced, false otherwise.
export async function maybeAdvancePledgeStage(
  pledgeId: string | null | undefined,
): Promise<boolean> {
  if (!pledgeId) return false;
  const rows = await db
    .update(opportunitiesAndPledges)
    .set({ stage: "cash_in", updatedAt: new Date() })
    .where(
      sql`${opportunitiesAndPledges.id} = ${pledgeId}
          AND ${opportunitiesAndPledges.status} = 'won'
          AND ${opportunitiesAndPledges.stage} = 'written_commitment'
          AND ${opportunitiesAndPledges.awardedAmount} IS NOT NULL
          AND ${opportunitiesAndPledges.awardedAmount}::numeric > 0
          AND (
            SELECT COALESCE(SUM(gp.amount), 0)
            FROM ${giftsAndPayments} gp
            WHERE gp.payment_on_pledge_id = ${pledgeId}
          ) >= ${opportunitiesAndPledges.awardedAmount}::numeric`,
    )
    .returning({ id: opportunitiesAndPledges.id });
  return rows.length > 0;
}

// Convenience wrapper for write paths that may touch two pledges
// (e.g. a PATCH that re-points a payment from pledge A to pledge B —
// B should advance if newly covered, A is unchanged on the upside).
export async function maybeAdvancePledgeStages(
  ...ids: Array<string | null | undefined>
): Promise<void> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      await maybeAdvancePledgeStage(id);
    }
  }
}
