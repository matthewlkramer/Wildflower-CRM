import { db } from "@workspace/db";
import { opportunitiesAndPledges, giftsAndPayments } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

// Stages that, once reached, mark a row as "ever was a pledge" for the
// purposes of the Pledges page filter (wasPledge sticky-true).
const PLEDGE_STAGES = new Set([
  "conditional_commitment",
  "verbal_commitment",
  "written_commitment",
]);

/**
 * Recompute the derived fields on a single opportunity/pledge row.
 *
 *   was_pledge: sticky-true. Flips false→true when stage hits any of
 *     conditional/verbal/written or when a grant letter is on file.
 *     Never auto-flipped back to false (users can clear it via PATCH).
 *
 *   status: auto-derived EXCEPT when current value is 'dormant' or
 *     'lost' (those are sticky user overrides — only cleared when the
 *     user explicitly picks a non-sticky value via PATCH).
 *       fully paid (paid≥awarded) OR stage='cash_in' → 'cash_in'
 *       stage ∈ (verbal, written)                    → 'pledge'
 *       everything else                              → 'open'
 *
 *   stage: when fully paid and currently 'written_commitment', advance
 *     to 'cash_in'. Never moves backwards or skips stages otherwise.
 *
 * Run after any mutation that touches stage, awardedAmount, status,
 * grantLetterUrl, or after a payment is recorded against this pledge.
 * Idempotent — only writes when a derived field actually changes.
 */
export async function applyDerivedOppFields(
  id: string | null | undefined,
): Promise<void> {
  if (!id) return;
  const row = await db
    .select()
    .from(opportunitiesAndPledges)
    .where(eq(opportunitiesAndPledges.id, id))
    .then((r) => r[0]);
  if (!row) return;

  const [{ paid } = { paid: "0" }] = await db
    .select({
      paid: sql<string>`COALESCE(SUM(${giftsAndPayments.amount}), 0)::text`,
    })
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.paymentOnPledgeId, id));

  const paidNum = Number(paid);
  const awardedNum = Number(row.awardedAmount ?? 0);
  const fullyPaid = awardedNum > 0 && paidNum >= awardedNum;

  // was_pledge: sticky-true
  let wasPledge = row.wasPledge;
  if (
    !wasPledge &&
    ((row.stage && PLEDGE_STAGES.has(row.stage)) || !!row.grantLetterUrl)
  ) {
    wasPledge = true;
  }

  // status: derive unless current is sticky (dormant/lost)
  let status = row.status;
  if (status !== "dormant" && status !== "lost") {
    if (fullyPaid || row.stage === "cash_in") {
      status = "cash_in";
    } else if (
      row.stage === "verbal_commitment" ||
      row.stage === "written_commitment"
    ) {
      status = "pledge";
    } else {
      status = "open";
    }
  }

  // stage: only the written_commitment→cash_in auto-advance
  let stage = row.stage;
  if (fullyPaid && stage === "written_commitment") {
    stage = "cash_in";
  }

  if (
    status !== row.status ||
    wasPledge !== row.wasPledge ||
    stage !== row.stage
  ) {
    await db
      .update(opportunitiesAndPledges)
      .set({ status, wasPledge, stage, updatedAt: new Date() })
      .where(eq(opportunitiesAndPledges.id, id));
  }
}

// Convenience wrapper for write paths that may touch two pledges (e.g.
// a PATCH that re-points a payment from pledge A to pledge B — both
// need their derived fields recomputed).
export async function applyDerivedOppFieldsMany(
  ...ids: Array<string | null | undefined>
): Promise<void> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      await applyDerivedOppFields(id);
    }
  }
}
