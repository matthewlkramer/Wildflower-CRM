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
 * The authoritative Stripe payout ↔ QuickBooks deposit settlement lives in the
 * `settlement_links` table (lifecycle + depositStagedPaymentId + conflictGiftId);
 * the reconciliation status is DERIVED via payoutStatusFromLink(link). The legacy
 * mirror columns that once shadowed it here (qb_reconciliation_status + the
 * matched / proposed / conflict pointers + confirmed-by / confirmed-at) plus the
 * qb_reconciliation_status index have been dropped.
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
    // settlement_links reconciliation flow; retained (not dropped) so historical
    // rows keep their value. Do not write to it on the new path.
    qbSupersedeStatus: text("qb_supersede_status").notNull().default("none"),

    // Free-text "something is off here" note from the finance review pass
    // (edited-tables import). Human-maintained.
    issuesToAddress: text("issues_to_address"),

    rawPayout: jsonb("raw_payout"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("stripe_payouts_account_idx").on(t.stripeAccountId),
    index("stripe_payouts_arrival_date_idx").on(t.arrivalDate),
    index("stripe_payouts_supersede_status_idx").on(t.qbSupersedeStatus),
  ],
);

export type StripePayout = typeof stripePayouts.$inferSelect;
export type NewStripePayout = typeof stripePayouts.$inferInsert;
