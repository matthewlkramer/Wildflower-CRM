import { db } from "@workspace/db";
import { settlementLinks, stripePayouts } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Plane-1 settlement-link dual-write (docs/reconciliation-design.md §4.3).
 *
 * Phase-4 rollout is ADDITIVE dual-write: the payout reconciliation choke points
 * (proposal pass, human confirm/revert, mint/link commit) still write the legacy
 * `stripe_payouts.qb_reconciliation_status` + pointer columns AS the source of
 * truth, and then call {@link syncSettlementLinkFromPayout} to MIRROR that state
 * into `settlement_links`. Reads are NOT flipped to `settlement_links` yet (that
 * read cutover is a later, prod-parity-gated step). Keeping the mirror derived
 * from the payout's post-write legacy state (rather than hand-writing lifecycle at
 * each of ~11 sites) means the mapping lives in exactly ONE place and stays in
 * lockstep with the 0089 backfill by construction.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

type SettlementLinkSource = {
  qbReconciliationStatus: string | null;
  proposedQbStagedPaymentId: string | null;
  matchedQbStagedPaymentId: string | null;
  qbConflictStagedPaymentId: string | null;
  qbReconciliationConfirmedByUserId: string | null;
  qbReconciliationConfirmedAt: Date | null;
  updatedAt: Date;
};

export type SettlementLinkFields = {
  lifecycle: "proposed" | "confirmed" | "exempt";
  provenance: "system" | "system_confirmed" | "human";
  depositStagedPaymentId: string;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
};

/**
 * Pure mapping from a payout's legacy reconciliation state to the settlement link
 * that should mirror it. Returns `null` when NO link should exist (the payout is
 * `unmatched`, in an unknown state, or has no resolvable QB deposit pointer).
 *
 * MUST mirror the backfill in `lib/db/migrations/0089_settlement_links.sql`
 * (load-bearing fields — lifecycle / provenance / deposit / confirmedBy / at). The
 * `note` column is intentionally NOT set here: it is reserved for the backfill's
 * `legacy <status>` provenance markers + future human annotations, and the parity
 * gate ignores it.
 */
export function deriveSettlementLinkFields(
  p: SettlementLinkSource,
): SettlementLinkFields | null {
  const status = p.qbReconciliationStatus;
  if (!status || status === "unmatched") return null;

  const isProposedFamily =
    status === "proposed" || status === "conflict_approved";
  const isConfirmedFamily = status.startsWith("confirmed_");
  if (!isProposedFamily && !isConfirmedFamily) return null;

  let depositId: string | null;
  if (status === "proposed") {
    depositId = p.proposedQbStagedPaymentId;
  } else if (status === "conflict_approved") {
    depositId = p.qbConflictStagedPaymentId ?? p.proposedQbStagedPaymentId;
  } else {
    depositId =
      p.matchedQbStagedPaymentId ??
      p.qbConflictStagedPaymentId ??
      p.proposedQbStagedPaymentId;
  }
  if (!depositId) return null;

  if (isProposedFamily) {
    return {
      lifecycle: "proposed",
      provenance: "system",
      depositStagedPaymentId: depositId,
      confirmedByUserId: null,
      confirmedAt: null,
    };
  }
  return {
    lifecycle: "confirmed",
    provenance: p.qbReconciliationConfirmedByUserId ? "human" : "system_confirmed",
    depositStagedPaymentId: depositId,
    confirmedByUserId: p.qbReconciliationConfirmedByUserId,
    confirmedAt: p.qbReconciliationConfirmedAt ?? p.updatedAt,
  };
}

/**
 * Mirror a payout's current legacy reconciliation state into `settlement_links`.
 * Re-reads the payout under the caller's connection/transaction, derives the
 * intended link, and upserts it (deterministic id `sl_<payoutId>`) — or deletes
 * any existing mirror when no link should exist (payout back to `unmatched`).
 *
 * Idempotent + self-healing: it always converges on the payout's post-write state,
 * so it is safe to call unconditionally after any payout reconciliation mutation.
 * At every runtime write site the resolved deposit is a freshly-read / row-locked
 * staged payment that exists, so the FK is satisfied without a redundant existence
 * probe (the 0089 backfill guards dangling historic pointers instead).
 */
export async function syncSettlementLinkFromPayout(
  dbi: DbLike,
  payoutId: string,
): Promise<void> {
  const [payout] = await dbi
    .select({
      qbReconciliationStatus: stripePayouts.qbReconciliationStatus,
      proposedQbStagedPaymentId: stripePayouts.proposedQbStagedPaymentId,
      matchedQbStagedPaymentId: stripePayouts.matchedQbStagedPaymentId,
      qbConflictStagedPaymentId: stripePayouts.qbConflictStagedPaymentId,
      qbReconciliationConfirmedByUserId:
        stripePayouts.qbReconciliationConfirmedByUserId,
      qbReconciliationConfirmedAt: stripePayouts.qbReconciliationConfirmedAt,
      updatedAt: stripePayouts.updatedAt,
    })
    .from(stripePayouts)
    .where(eq(stripePayouts.id, payoutId))
    .limit(1);
  if (!payout) return;

  const id = `sl_${payoutId}`;
  const fields = deriveSettlementLinkFields(payout);

  if (!fields) {
    await dbi.delete(settlementLinks).where(eq(settlementLinks.id, id));
    return;
  }

  await dbi
    .insert(settlementLinks)
    .values({
      id,
      payoutId,
      depositStagedPaymentId: fields.depositStagedPaymentId,
      lifecycle: fields.lifecycle,
      provenance: fields.provenance,
      confirmedByUserId: fields.confirmedByUserId,
      confirmedAt: fields.confirmedAt,
    })
    .onConflictDoUpdate({
      target: settlementLinks.id,
      set: {
        depositStagedPaymentId: fields.depositStagedPaymentId,
        lifecycle: fields.lifecycle,
        provenance: fields.provenance,
        confirmedByUserId: fields.confirmedByUserId,
        confirmedAt: fields.confirmedAt,
        updatedAt: sql`now()`,
      },
    });
}
