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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bankDeposits } from "./bankDeposits";

/**
 * One row per Stripe payout (the bank transfer Stripe makes to the org).
 *
 * A payout is the NET of everything in its batch: gross charges − processor
 * fees − refunds. The individual donor attribution lives in
 * stripe_staged_charges (one row per charge in the payout); this table holds
 * the payout-level rollups (so the UI can show "payout = gross − fees − refunds").
 *
 * ── Payout → bank deposit (docs/adr-bank-spine-money-model.md, Phase 4) ──
 * A payout settles as exactly ONE real bank deposit. `bank_deposit_id` records
 * that tie directly on the payout (UNIQUE — one payout per deposit). This is a
 * NEW relationship to the register-projected `bank_deposits` spine — DISTINCT
 * from `settlement_links`, whose target is a QBO *Deposit* row
 * (`staged_payments`); settlement_links stays until Phase 9 and folds into the
 * QBO accounting-verification role. The match is inferred (amount + currency +
 * arrival/deposit date, trace when available); when >1 equivalent deposit
 * existed at match time `ambiguous_bank_match` is set and a deterministic
 * pairing is used — NO confirmation workflow (a swapped equal-amount/same-day
 * pair is economically inert). `bank_matched_at` stamps when it was computed.
 *
 * The authoritative Stripe payout ↔ QuickBooks deposit settlement lives in the
 * `settlement_links` table (lifecycle + depositStagedPaymentId + conflictGiftId);
 * the reconciliation status is DERIVED via payoutStatusFromLink(link). The legacy
 * mirror columns that once shadowed it here (qb_reconciliation_status + the
 * matched / proposed / conflict pointers + confirmed-by / confirmed-at) plus the
 * qb_reconciliation_status index have been dropped, as has the deprecated
 * qb_supersede_status audit column from the retired auto-supersede model.
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
    // Net of every OTHER balance transaction settling inside the payout —
    // fee-refund adjustments, failed-payment reversals (payment_failure_refund),
    // failed-payout recoveries (payout_failure). NULL until the payout is
    // (re-)synced by rollup code that computes it.
    adjustmentTotal: numeric("adjustment_total", { precision: 14, scale: 2 }),
    // True Stripe-ledger net: gross − fees − refunds + adjustments. Equals the
    // bank `amount` whenever Stripe's books balance, so the settlement-gap lens
    // only flags genuinely unexplained payouts.
    netTotal: numeric("net_total", { precision: 14, scale: 2 }),
    chargeCount: integer("charge_count"),

    rawPayout: jsonb("raw_payout"),

    // ── Payout → bank deposit (Phase 4) ────────────────────────────────
    // The one real bank deposit this payout settled as. SET NULL: the deposit
    // is evidence; losing it degrades the pointer, not the payout.
    bankDepositId: text("bank_deposit_id").references(() => bankDeposits.id, {
      onDelete: "set null",
    }),
    // True when >1 equivalent bank deposit (same amount/currency/date) existed
    // at match time and a deterministic pairing was chosen. Filterable; there is
    // deliberately NO confirmation workflow for it.
    ambiguousBankMatch: boolean("ambiguous_bank_match").notNull().default(false),
    // When the bank-deposit match was computed (NULL = not yet matched).
    bankMatchedAt: timestamp("bank_matched_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("stripe_payouts_account_idx").on(t.stripeAccountId),
    index("stripe_payouts_arrival_date_idx").on(t.arrivalDate),
    // One payout per bank deposit.
    uniqueIndex("stripe_payouts_bank_deposit_id_uq")
      .on(t.bankDepositId)
      .where(sql`${t.bankDepositId} IS NOT NULL`),
  ],
);

export type StripePayout = typeof stripePayouts.$inferSelect;
export type NewStripePayout = typeof stripePayouts.$inferInsert;
