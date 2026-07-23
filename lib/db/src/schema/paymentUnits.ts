import {
  pgTable,
  text,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { paymentUnitKindEnum, paymentUnitLifecycleEnum } from "./_enums";
import { stripeStagedCharges } from "./stripeStagedCharges";
import { donorboxDonations } from "./donorboxDonations";
import { stagedPayments } from "./stagedPayments";

/**
 * The canonical **donor-level payment unit** (docs/adr-bank-spine-money-model.md).
 *
 * One row = ONE real donor-level payment event, regardless of instrument
 * (`kind`: stripe_charge / check / direct_ach / wire / other). This is the
 * single anchor the gift-application ledger re-anchors onto in Phase 5
 * (`payment_applications.payment_unit_id`), collapsing today's three
 * source-specific anchors (payment_id / stripe_charge_id / donorbox_donation_id)
 * to one — which is what lets the three per-source counted-unique indexes become
 * a single `UNIQUE(payment_unit_id) WHERE link_role='counted'`.
 *
 * ── What a payment unit is NOT ──────────────────────────────────────────
 * It does NOT carry donor identity or coding. Per header+allocations
 * (replit.md), the resolved donor and revenue coding live on the GIFT; the
 * unit's raw donor evidence (Stripe `payer_name`, QBO check payer, etc.) stays
 * on the source/evidence tables feeding the matcher — exactly as Stripe donor
 * evidence stays on `stripe_staged_charges` today. It is also **parent-free**:
 * a stripe_charge's parent is its payout, a check's parent is a
 * `bank_deposit_components` row — there is no polymorphic parent pointer here.
 *
 * ── Pointers (identity + evidence, at most one authority each) ───────────
 *   stripeChargeId       1:1 with the Stripe charge this unit represents
 *                        (UNIQUE; REQUIRED iff kind='stripe_charge').
 *   donorboxDonationId   the Donorbox donation this payment settled (UNIQUE) —
 *                        the SINGLE canonical Donorbox authority (Phase 6), for
 *                        both card (via Stripe) and offline/check donations. No
 *                        reciprocal pointer on donorbox_donations.
 *   sourceStagedPaymentId  provisional provenance for check units inferred from
 *                        QBO (Phase 3); SET NULL when a better source replaces
 *                        QBO. Never an application authority.
 *
 * ── Money (major units, 2dp) ────────────────────────────────────────────
 * Donors are credited GROSS; net = gross − fee (processor fees are not donor
 * money). Refund/dispute state is `lifecycle`.
 *
 * ── Backfill (Phase 2) ──────────────────────────────────────────────────
 * Seeded 1:1 from non-excluded `stripe_staged_charges` (id = `pu_<charge id>`,
 * deterministic → idempotent). Check units + their components come in Phase 3.
 */
export const paymentUnits = pgTable(
  "payment_units",
  {
    // Deterministic id so backfills/re-syncs upsert in place. Stripe units use
    // `pu_<charge id>` (e.g. pu_ch_123); check units (Phase 3) derive from the
    // QBO split-child id.
    id: text("id").primaryKey(),
    kind: paymentUnitKindEnum("kind").notNull(),

    // 1:1 identity link for stripe_charge units (evidence + identity). RESTRICT:
    // a charge with a payment unit cannot be deleted out from under it (charges
    // are upsert-only in practice, never deleted).
    stripeChargeId: text("stripe_charge_id").references(
      () => stripeStagedCharges.id,
      { onDelete: "restrict" },
    ),

    // The single canonical Donorbox application authority (Phase 6). SET NULL:
    // the donation is enrichment/evidence; losing it degrades the pointer, not
    // the payment.
    donorboxDonationId: text("donorbox_donation_id").references(
      () => donorboxDonations.id,
      { onDelete: "set null" },
    ),

    // Provisional provenance for QBO-inferred check units (Phase 3). SET NULL
    // when a bank-native source replaces QBO. Not an application authority.
    sourceStagedPaymentId: text("source_staged_payment_id").references(
      () => stagedPayments.id,
      { onDelete: "set null" },
    ),

    // ── Money (major units, 2dp). Credit donors GROSS. ──────────────────
    grossAmount: numeric("gross_amount", { precision: 14, scale: 2 }),
    feeAmount: numeric("fee_amount", { precision: 14, scale: 2 }),
    netAmount: numeric("net_amount", { precision: 14, scale: 2 }),
    currency: text("currency").notNull().default("USD"),
    // The calendar date the payment is credited to (gift date grain).
    receivedDate: date("received_date"),

    lifecycle: paymentUnitLifecycleEnum("lifecycle").notNull().default("received"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // One payment unit per Stripe charge / per Donorbox donation.
    uniqueIndex("payment_units_stripe_charge_id_uq")
      .on(t.stripeChargeId)
      .where(sql`${t.stripeChargeId} IS NOT NULL`),
    uniqueIndex("payment_units_donorbox_donation_id_uq")
      .on(t.donorboxDonationId)
      .where(sql`${t.donorboxDonationId} IS NOT NULL`),
    index("payment_units_kind_idx").on(t.kind),
    index("payment_units_source_staged_payment_id_idx").on(
      t.sourceStagedPaymentId,
    ),
    index("payment_units_received_date_idx").on(t.receivedDate),
    // A stripe_charge unit MUST carry its charge id; a non-stripe unit MUST NOT
    // (its charge id is meaningless — checks/ACH/wires are not Stripe charges).
    check(
      "payment_units_stripe_charge_shape_chk",
      sql`(${t.kind} = 'stripe_charge') = (${t.stripeChargeId} IS NOT NULL)`,
    ),
  ],
);

export type PaymentUnit = typeof paymentUnits.$inferSelect;
export type NewPaymentUnit = typeof paymentUnits.$inferInsert;
