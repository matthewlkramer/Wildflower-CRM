import { db } from "@workspace/db";
import { settlementLinks } from "@workspace/db/schema";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { applySettlementSupersedeForDeposits } from "./settlementSupersede";

/**
 * Plane-1 settlement-link primitives (docs/reconciliation-design.md §4.3).
 *
 * `settlement_links` is the authoritative payout↔deposit store. Every physical
 * mutation also recomputes Plane-2 settlement supersession for both the prior
 * and resulting deposit anchors. This keeps the coarse QBO application counted
 * only while confirmed Stripe charge applications do not cover it.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

export type SettlementLinkFields = {
  lifecycle: "proposed" | "confirmed" | "exempt";
  provenance: "system" | "system_confirmed" | "human";
  depositStagedPaymentId: string;
  conflictGiftId: string | null;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
};

export function payoutStatusFromLink(
  link: {
    lifecycle: SettlementLinkFields["lifecycle"];
    conflictGiftId: string | null;
  } | null,
): "unmatched" | "proposed" | "conflict_approved" | "confirmed_reconciled" {
  if (!link) return "unmatched";
  if (link.lifecycle === "confirmed") return "confirmed_reconciled";
  if (link.lifecycle === "proposed") {
    return link.conflictGiftId ? "conflict_approved" : "proposed";
  }
  return "unmatched";
}

export const payoutStatusLabelSql = sql`CASE
  WHEN sl.lifecycle = 'confirmed' THEN 'confirmed_reconciled'
  WHEN sl.lifecycle = 'proposed' AND sl.conflict_gift_id IS NOT NULL THEN 'conflict_approved'
  WHEN sl.lifecycle = 'proposed' THEN 'proposed'
  ELSE 'unmatched'
END`;

async function currentDepositForPayout(
  dbi: DbLike,
  payoutId: string,
): Promise<string | null> {
  const [row] = await dbi
    .select({ depositId: settlementLinks.depositStagedPaymentId })
    .from(settlementLinks)
    .where(eq(settlementLinks.payoutId, payoutId))
    .limit(1);
  return row?.depositId ?? null;
}

const uniqueDeposits = (
  ...ids: Array<string | null | undefined>
): string[] => [...new Set(ids.filter((id): id is string => !!id))];

/**
 * Physical upsert of one settlement link. Recomputes supersession for the old
 * and new deposit in the same transaction/DB context so moving a payout cannot
 * leave either deposit in a stale counted/corroborating state.
 */
export async function upsertSettlementLink(
  dbi: DbLike,
  payoutId: string,
  fields: SettlementLinkFields,
): Promise<void> {
  const previousDepositId = await currentDepositForPayout(dbi, payoutId);
  const id = `sl_${payoutId}`;
  await dbi
    .insert(settlementLinks)
    .values({
      id,
      payoutId,
      depositStagedPaymentId: fields.depositStagedPaymentId,
      conflictGiftId: fields.conflictGiftId,
      lifecycle: fields.lifecycle,
      provenance: fields.provenance,
      confirmedByUserId: fields.confirmedByUserId,
      confirmedAt: fields.confirmedAt,
    })
    .onConflictDoUpdate({
      target: settlementLinks.id,
      set: {
        depositStagedPaymentId: fields.depositStagedPaymentId,
        conflictGiftId: fields.conflictGiftId,
        lifecycle: fields.lifecycle,
        provenance: fields.provenance,
        confirmedByUserId: fields.confirmedByUserId,
        confirmedAt: fields.confirmedAt,
        updatedAt: sql`now()`,
      },
    });

  await applySettlementSupersedeForDeposits(
    dbi,
    uniqueDeposits(previousDepositId, fields.depositStagedPaymentId),
  );
}

/** Remove the settlement link and restore any QBO application it superseded. */
export async function deleteSettlementLink(
  dbi: DbLike,
  payoutId: string,
): Promise<void> {
  const previousDepositId = await currentDepositForPayout(dbi, payoutId);
  await dbi
    .delete(settlementLinks)
    .where(eq(settlementLinks.id, `sl_${payoutId}`));

  await applySettlementSupersedeForDeposits(
    dbi,
    uniqueDeposits(previousDepositId),
  );
}

/**
 * Guarded state transition of an existing settlement link. A successful
 * transition recomputes both deposit anchors; a failed optimistic-lock update
 * makes no other changes.
 */
export async function transitionSettlementLink(
  dbi: DbLike,
  payoutId: string,
  expectedStatus: "proposed" | "conflict_approved" | "confirmed_reconciled",
  fields: SettlementLinkFields,
): Promise<boolean> {
  const previousDepositId = await currentDepositForPayout(dbi, payoutId);
  const guard =
    expectedStatus === "confirmed_reconciled"
      ? eq(settlementLinks.lifecycle, "confirmed")
      : expectedStatus === "conflict_approved"
        ? and(
            eq(settlementLinks.lifecycle, "proposed"),
            isNotNull(settlementLinks.conflictGiftId),
          )
        : and(
            eq(settlementLinks.lifecycle, "proposed"),
            isNull(settlementLinks.conflictGiftId),
          );

  const updated = await dbi
    .update(settlementLinks)
    .set({
      depositStagedPaymentId: fields.depositStagedPaymentId,
      conflictGiftId: fields.conflictGiftId,
      lifecycle: fields.lifecycle,
      provenance: fields.provenance,
      confirmedByUserId: fields.confirmedByUserId,
      confirmedAt: fields.confirmedAt,
      updatedAt: sql`now()`,
    })
    .where(and(eq(settlementLinks.payoutId, payoutId), guard))
    .returning({ id: settlementLinks.id });

  if (updated.length === 0) return false;

  await applySettlementSupersedeForDeposits(
    dbi,
    uniqueDeposits(previousDepositId, fields.depositStagedPaymentId),
  );
  return true;
}
