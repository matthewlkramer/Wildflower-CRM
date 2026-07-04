import { db } from "@workspace/db";
import { settlementLinks } from "@workspace/db/schema";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

/**
 * Plane-1 settlement-link primitives (docs/reconciliation-design.md §4.3).
 *
 * `settlement_links` is the AUTHORITATIVE store AND the optimistic-lock surface:
 * every payout reconciliation choke point (proposal pass, human confirm/revert,
 * mint/link commit) expresses its INTENT as the `settlement_links` row it wants
 * (built in `settlementWriter.ts`) and persists it here. The reconciliation status
 * enum a link represents is derived on read by {@link payoutStatusFromLink} /
 * {@link payoutStatusLabelSql}. `upsertSettlementLink` / `transitionSettlementLink`
 * / `deleteSettlementLink` are the low-level physical writes shared with the
 * authoritative writer. The legacy `stripe_payouts.qb_reconciliation_status` +
 * pointer mirror columns this store replaced have been dropped.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

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
 * The reconciliation status enum a settlement link REPRESENTS, for readers that
 * expose / gate on the enum shape (all now sourced from `settlement_links`, never
 * the retired legacy `stripe_payouts.qb_reconciliation_status` mirror).
 *
 * Emits only the four states the authoritative writer produces and NEVER throws:
 * it is a read path, so an `exempt` link (which no payout link is in this model)
 * degrades to `unmatched` rather than 500-ing an evidence view.
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
 * SQL twin of {@link payoutStatusFromLink}: the legacy reconciliation status enum
 * a payout's settlement link REPRESENTS, computed inline for the raw-SQL evidence
 * readers (the reconciliation bundle-anchor list + card evidence expression) that
 * have been flipped off `stripe_payouts.qb_reconciliation_status`.
 *
 * REQUIRES the surrounding query to alias `settlement_links` as `sl`. A missing
 * link (LEFT JOIN → all-null `sl`) falls through to `'unmatched'`, exactly like
 * the null branch of {@link payoutStatusFromLink}. It emits ONLY the four live
 * values the authoritative writer produces and MUST stay in lockstep with that
 * function; the retired 7-value display distinction is not reconstructible (and,
 * per prod, has zero live rows), so it is intentionally collapsed here.
 */
export const payoutStatusLabelSql = sql`CASE
  WHEN sl.lifecycle = 'confirmed' THEN 'confirmed_reconciled'
  WHEN sl.lifecycle = 'proposed' AND sl.conflict_gift_id IS NOT NULL THEN 'conflict_approved'
  WHEN sl.lifecycle = 'proposed' THEN 'proposed'
  ELSE 'unmatched'
END`;

/**
 * Physical upsert of ONE settlement link from explicit fields (deterministic id
 * `sl_<payoutId>`). The single low-level write used by the authoritative writer
 * (`settlementWriter.ts`), which builds the fields from explicit human/system
 * intent.
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

/**
 * Guarded state-transition UPDATE of an EXISTING settlement link, used by the
 * human confirm/revert state machine (stripeConfirm.ts) as its optimistic-lock
 * boundary (`settlement_links` is now the sole authoritative reconciliation store;
 * the legacy mirror columns it replaced have been dropped). Advances
 * the 1:1 link (`sl_<payoutId>`) to `fields` ONLY when its CURRENT state still
 * matches `expectedStatus`, expressed in link terms:
 *   - `proposed`             → lifecycle 'proposed' AND no conflict gift
 *   - `conflict_approved`    → lifecycle 'proposed' AND a conflict gift
 *   - `confirmed_reconciled` → lifecycle 'confirmed'
 * Returns `true` when a row advanced, `false` when the prior state had drifted
 * (the caller maps that to a typed `invalid_transition` / 409). This is an UPDATE,
 * never an upsert: every confirm/revert site already has a prior link, and a guard
 * that could INSERT would defeat the optimistic lock.
 */
export async function transitionSettlementLink(
  dbi: DbLike,
  payoutId: string,
  expectedStatus: "proposed" | "conflict_approved" | "confirmed_reconciled",
  fields: SettlementLinkFields,
): Promise<boolean> {
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
  return updated.length > 0;
}
