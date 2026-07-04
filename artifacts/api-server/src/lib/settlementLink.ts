import { db } from "@workspace/db";
import { settlementLinks } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Plane-1 settlement-link primitives (docs/reconciliation-design.md §4.3).
 *
 * `settlement_links` is now the AUTHORITATIVE store: every payout reconciliation
 * choke point (proposal pass, human confirm/revert, mint/link commit) expresses
 * its INTENT as the `settlement_links` row it wants (via `settlementWriter.ts`)
 * and reverse-derives the legacy `stripe_payouts.qb_reconciliation_status` +
 * pointer columns from it, so those columns stay a perfect mirror until they are
 * retired (Phase-6). `deriveSettlementLinkFields` is the pure legacy→link mapping
 * retained ONLY for the forward parity gate (`parity:settlement-links`) and the
 * 0089/0092 backfills; `upsertSettlementLink` / `deleteSettlementLink` are the
 * low-level physical writes shared with the authoritative writer.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

type SettlementLinkSource = {
  qbReconciliationStatus: string | null;
  proposedQbStagedPaymentId: string | null;
  matchedQbStagedPaymentId: string | null;
  qbConflictStagedPaymentId: string | null;
  qbConflictGiftId: string | null;
  qbReconciliationConfirmedByUserId: string | null;
  qbReconciliationConfirmedAt: Date | null;
  updatedAt: Date;
};

export type SettlementLinkFields = {
  lifecycle: "proposed" | "confirmed" | "exempt";
  provenance: "system" | "system_confirmed" | "human";
  depositStagedPaymentId: string;
  // The already-approved QB gift the proposal collided with (legacy
  // `conflict_approved`) — mirrors `stripe_payouts.qb_conflict_gift_id`. Non-null
  // on a proposed link marks a conflict; retained on the resulting confirmed link
  // as the revert-of-keep discriminator. Null for a clean proposal / confirm.
  conflictGiftId: string | null;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
};

/**
 * Pure mapping from a payout's legacy reconciliation state to the settlement link
 * that should mirror it. Returns `null` when NO link should exist (the payout is
 * `unmatched`, in an unknown state, or has no resolvable QB deposit pointer).
 *
 * MUST mirror the backfills in `lib/db/migrations/0089_settlement_links.sql` and
 * `0092_settlement_links_conflict_gift_id.sql` (load-bearing fields — lifecycle /
 * provenance / deposit / conflictGift / confirmedBy / at). The `note` column is
 * intentionally NOT set here: it is reserved for the backfill's `legacy <status>`
 * provenance markers + future human annotations, and the parity gate ignores it.
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
      conflictGiftId: p.qbConflictGiftId,
      confirmedByUserId: null,
      confirmedAt: null,
    };
  }
  return {
    lifecycle: "confirmed",
    provenance: p.qbReconciliationConfirmedByUserId ? "human" : "system_confirmed",
    depositStagedPaymentId: depositId,
    conflictGiftId: p.qbConflictGiftId,
    confirmedByUserId: p.qbReconciliationConfirmedByUserId,
    confirmedAt: p.qbReconciliationConfirmedAt ?? p.updatedAt,
  };
}

/**
 * Read-side inverse of {@link deriveSettlementLinkFields}: the legacy payout
 * reconciliation status enum a settlement link REPRESENTS. Used by readers that
 * have been flipped off the legacy `stripe_payouts.qb_reconciliation_status`
 * column onto `settlement_links` (Phase-4 read cut-over) but still expose / gate
 * on the enum shape.
 *
 * Mirrors {@link reverseSettlementLink}'s status mapping over the only four states
 * the authoritative writer produces, but NEVER throws: it is a read path, so an
 * `exempt` link (which no payout link is in this model) degrades to `unmatched`
 * rather than 500-ing an evidence view.
 */
export function payoutStatusFromLink(
  link: { lifecycle: SettlementLinkFields["lifecycle"]; conflictGiftId: string | null } | null,
): "unmatched" | "proposed" | "conflict_approved" | "confirmed_reconciled" {
  if (!link) return "unmatched";
  if (link.lifecycle === "confirmed") return "confirmed_reconciled";
  if (link.lifecycle === "proposed") {
    return link.conflictGiftId ? "conflict_approved" : "proposed";
  }
  return "unmatched";
}

/**
 * Physical upsert of ONE settlement link from explicit fields (deterministic id
 * `sl_<payoutId>`). The single low-level write used by the Phase-4 authoritative
 * writer (`settlementWriter.ts`), which builds the fields from explicit
 * human/system intent and reverse-maps the legacy enum + pointer columns from them.
 */
export async function upsertSettlementLink(
  dbi: DbLike,
  payoutId: string,
  fields: SettlementLinkFields,
): Promise<void> {
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
}

/** Remove the settlement link for a payout (no-op if absent). */
export async function deleteSettlementLink(
  dbi: DbLike,
  payoutId: string,
): Promise<void> {
  await dbi
    .delete(settlementLinks)
    .where(eq(settlementLinks.id, `sl_${payoutId}`));
}
