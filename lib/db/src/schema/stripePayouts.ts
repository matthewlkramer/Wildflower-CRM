import {
  pgTable,
  text,
  numeric,
  integer,
  boolean,
  date,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { stagedPayments } from "./stagedPayments";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";

/**
 * One row per Stripe payout (the bank transfer Stripe makes to the org).
 *
 * A payout is the NET of everything in its batch: gross charges − processor
 * fees − refunds. The individual donor attribution lives in
 * stripe_staged_charges (one row per charge in the payout); this table holds
 * the payout-level rollups (so the UI can show "payout = gross − fees − refunds")
 * and the non-destructive audit link to the QuickBooks net-payout lump the
 * payout supersedes.
 *
 * qbSupersedeStatus:
 *   none              — no matching QB lump found (or supersede not run yet).
 *   excluded_pending  — the matching QB staged row was still pending and was
 *                       auto-excluded (processor_payout) so it is not also booked.
 *   conflict_approved — the matching QB lump was ALREADY approved into a gift.
 *                       We never mutate it; the conflict is surfaced and Stripe
 *                       charge approval for this payout is blocked until a human
 *                       resolves the QB side.
 */
export const stripePayouts = pgTable(
  "stripe_payouts",
  {
    // Stripe payout id (po_...).
    id: text("id").primaryKey(),
    stripeAccountId: text("stripe_account_id").notNull(),

    // Net amount that hit the bank (payout.amount), in major units.
    amount: numeric("amount", { precision: 14, scale: 2 }),
    currency: text("currency"),
    // paid | pending | in_transit | canceled | failed
    status: text("status"),
    automatic: boolean("automatic"),
    arrivalDate: date("arrival_date"),
    payoutCreated: timestamp("payout_created", { withTimezone: true }),

    // Rollups derived from this payout's balance transactions. Refunds are
    // tracked separately from fees (a refund is not a processor fee).
    grossTotal: numeric("gross_total", { precision: 14, scale: 2 }),
    feeTotal: numeric("fee_total", { precision: 14, scale: 2 }),
    refundTotal: numeric("refund_total", { precision: 14, scale: 2 }),
    netTotal: numeric("net_total", { precision: 14, scale: 2 }),
    chargeCount: integer("charge_count"),

    // ── Non-destructive QuickBooks supersede audit ──────────────────────
    // DEPRECATED: the original auto-supersede model. Superseded by the
    // human-confirmed `qbReconciliationStatus` flow below; retained (not
    // dropped) so historical rows keep their value. Do not write to it on the
    // new path.
    qbSupersedeStatus: text("qb_supersede_status").notNull().default("none"),
    // ── DEPRECATED legacy Stripe↔QuickBooks reconciliation mirror ───────
    // As of the settlement_links read-flip (reconciliation redesign Phase 4),
    // the AUTHORITATIVE source for the Stripe payout ↔ QB deposit settlement is
    // the `settlement_links` table (lifecycle + depositStagedPaymentId +
    // conflictGiftId); status is DERIVED via payoutStatusFromLink(link). The
    // columns below are now written ONLY as a reverse-derived mirror — retained
    // so the parity gate `derive(legacy) == link` stays valid — and are scrubbed
    // from every API response. Do NOT read them for behavior. They stop being
    // written and are physically DROPped in a later, separately-gated phase.

    // The QB staged row this payout is CONFIRMED-matched to (the net-payout
    // lump). Set when a human confirms the match in the reconciliation queue.
    /** @deprecated mirror-only; read settlement_links.depositStagedPaymentId. Scrubbed from responses. */
    matchedQbStagedPaymentId: text("matched_qb_staged_payment_id").references(
      () => stagedPayments.id,
      { onDelete: "set null" },
    ),
    // The QB staged row that was already APPROVED (conflict — left untouched).
    /** @deprecated mirror-only; conflict is settlement_links.conflictGiftId. Scrubbed from responses. */
    qbConflictStagedPaymentId: text("qb_conflict_staged_payment_id").references(
      () => stagedPayments.id,
      { onDelete: "set null" },
    ),
    /** @deprecated mirror-only; read settlement_links.conflictGiftId. Scrubbed from responses. */
    qbConflictGiftId: text("qb_conflict_gift_id").references(
      () => giftsAndPayments.id,
      { onDelete: "set null" },
    ),

    // ── Human-confirmed Stripe↔QuickBooks reconciliation ────────────────
    // The system PROPOSES a payout↔deposit match; a human confirms it in the
    // reconciliation queue. Nothing on the QB side changes until confirm.
    //   unmatched          — no proposal yet
    //   proposed           — a candidate QB deposit lump was proposed (stored in
    //                        proposedQbStagedPaymentId); awaiting human review
    //   confirmed_excluded — confirmed against a PENDING QB lump; that lump is
    //                        now excluded (processor_payout) + linked
    //   confirmed_keep     — confirmed against an ALREADY-APPROVED QB gift; the
    //                        existing gift was kept, just linked for audit
    //   confirmed_replace  — confirmed against an already-approved QB gift that
    //                        the human chose to REPLACE (old gift archived; the
    //                        per-charge gross Stripe gifts are now the record)
    //   conflict_approved  — proposal landed on an already-approved QB gift and
    //                        is awaiting the human's KEEP/REPLACE decision
    //   confirmed_reconciled — NEW model: confirmed payout↔deposit match. The QB
    //                        deposit lump is marked `reconciled` (kept + linked,
    //                        NEVER a gift, NEVER archived) and the per-charge
    //                        Stripe gifts are stamped as the source of truth.
    //                        Supersedes confirmed_excluded/_keep/_replace going
    //                        forward; the old values are retained for history.
    // NOTE: the `$type` union is kept FULL — history rows still physically hold
    // the legacy confirmed_excluded/_keep/_replace values. The API contract
    // (StripePayoutReconciliationStatus) narrows to the 4 values
    // payoutStatusFromLink emits.
    /** @deprecated mirror-only; derive via payoutStatusFromLink(settlement_links). Scrubbed from responses. */
    qbReconciliationStatus: text("qb_reconciliation_status")
      .$type<
        | "unmatched"
        | "proposed"
        | "confirmed_excluded"
        | "confirmed_keep"
        | "confirmed_replace"
        | "conflict_approved"
        | "confirmed_reconciled"
      >()
      .notNull()
      .default("unmatched"),
    // The QB staged row PROPOSED as this payout's net-deposit lump (pre-confirm).
    /** @deprecated mirror-only; read settlement_links.depositStagedPaymentId. Scrubbed from responses. */
    proposedQbStagedPaymentId: text(
      "proposed_qb_staged_payment_id",
    ).references(() => stagedPayments.id, { onDelete: "set null" }),
    /** @deprecated mirror-only; read settlement_links.confirmedByUserId. Scrubbed from responses. */
    qbReconciliationConfirmedByUserId: text(
      "qb_reconciliation_confirmed_by_user_id",
    ).references(() => users.id, { onDelete: "set null" }),
    /** @deprecated mirror-only; read settlement_links.confirmedAt. Scrubbed from responses. */
    qbReconciliationConfirmedAt: timestamp("qb_reconciliation_confirmed_at", {
      withTimezone: true,
    }),

    rawPayout: jsonb("raw_payout"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("stripe_payouts_account_idx").on(t.stripeAccountId),
    index("stripe_payouts_arrival_date_idx").on(t.arrivalDate),
    index("stripe_payouts_supersede_status_idx").on(t.qbSupersedeStatus),
    index("stripe_payouts_qb_reconciliation_status_idx").on(
      t.qbReconciliationStatus,
    ),
  ],
);

export type StripePayout = typeof stripePayouts.$inferSelect;
export type NewStripePayout = typeof stripePayouts.$inferInsert;
