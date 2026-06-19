import {
  pgTable,
  text,
  integer,
  timestamp,
  numeric,
  date,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  stagedPaymentStatusEnum,
  stagedPaymentExclusionReasonEnum,
  stagedPaymentMatchStatusEnum,
  stagedPaymentMatchMethodEnum,
  stagedPaymentClassificationSourceEnum,
} from "./_enums";
import { organizations } from "./organizations";
import { people } from "./people";
import { households } from "./households";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";
import { stripePayouts } from "./stripePayouts";

/**
 * Review queue for incoming Stripe charges, one row per charge grouped under
 * the payout it settled in. Mirrors staged_payments (QuickBooks) but keyed on
 * Stripe ids. Stripe is the source of truth for per-donor attribution: a
 * scored matcher resolves the donor, and a fundraiser approves a row to mint a
 * gifts_and_payments row honoring the Donor XOR invariant.
 *
 * Money: donors are credited the GROSS charge amount (`grossAmount`). The
 * payout net is gross − fees − refunds, so the gap is processor fees and is NOT
 * a donor amount. All amounts are stored in major units (e.g. dollars), 2dp,
 * converted from Stripe's integer minor units at stage time.
 *
 * Idempotency: PK `id` IS the Stripe charge id, so re-pulls upsert in place
 * (onConflictDoUpdate by id) and never duplicate a charge. The upsert must
 * preserve review state (status / donor match / gift linkage) and only refresh
 * read-only Stripe facts.
 *
 * Reconciliation (mutually exclusive, same rule as staged_payments):
 *   matchedGiftId — linked to a PRE-EXISTING gift (no new ledger row).
 *   createdGiftId — a NEW gift minted from this charge.
 */
export const stripeStagedCharges = pgTable(
  "stripe_staged_charges",
  {
    // The Stripe charge id (ch_...) — used directly as the primary key so
    // re-pulls are idempotent.
    id: text("id").primaryKey(),
    stripeAccountId: text("stripe_account_id").notNull(),
    // The payout this charge settled in (null until paid out / for an
    // unsettled charge). Set null on payout delete to stay non-destructive.
    stripePayoutId: text("stripe_payout_id").references(() => stripePayouts.id, {
      onDelete: "set null",
    }),
    stripeBalanceTransactionId: text("stripe_balance_transaction_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeCustomerId: text("stripe_customer_id"),

    // ── Money (major units, 2dp). Credit donors GROSS. ──────────────────
    grossAmount: numeric("gross_amount", { precision: 14, scale: 2 }),
    feeAmount: numeric("fee_amount", { precision: 14, scale: 2 }),
    netAmount: numeric("net_amount", { precision: 14, scale: 2 }),
    amountRefunded: numeric("amount_refunded", { precision: 14, scale: 2 }),
    currency: text("currency"),
    // When Stripe created the charge (charge.created).
    chargeCreated: timestamp("charge_created", { withTimezone: true }),
    // Calendar date the gift is credited to (derived from chargeCreated in
    // America/Chicago). Used by the matcher and minted onto the gift.
    dateReceived: date("date_received"),

    // ── Donor-identifying Stripe facts (read-only; refreshed on re-pull) ──
    payerName: text("payer_name"),
    payerEmail: text("payer_email"),
    // charge.description — frequently carries the real donor name / memo.
    description: text("description"),
    statementDescriptor: text("statement_descriptor"),
    cardBrand: text("card_brand"),
    metadata: jsonb("metadata").$type<Record<string, string>>(),
    // Refund / dispute flags — surfaced to the reviewer; a fully refunded or
    // disputed charge is usually not a real gift.
    refunded: boolean("refunded").notNull().default(false),
    disputed: boolean("disputed").notNull().default(false),
    // The complete raw Stripe charge payload (storage only; excluded from the
    // list API).
    rawCharge: jsonb("raw_charge"),

    // ── Review state (mirrors staged_payments) ──────────────────────────
    status: stagedPaymentStatusEnum("status").notNull().default("pending"),
    exclusionReason: stagedPaymentExclusionReasonEnum("exclusion_reason"),
    classificationSource: stagedPaymentClassificationSourceEnum(
      "classification_source",
    )
      .notNull()
      .default("auto"),

    matchStatus: stagedPaymentMatchStatusEnum("match_status")
      .notNull()
      .default("unmatched"),
    matchScore: integer("match_score"),
    matchMethod: stagedPaymentMatchMethodEnum("match_method"),
    autoApplied: boolean("auto_applied").notNull().default(false),
    matchConfirmedByUserId: text("match_confirmed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    matchConfirmedAt: timestamp("match_confirmed_at", { withTimezone: true }),

    // Donor match (XOR).
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    individualGiverPersonId: text("individual_giver_person_id").references(
      () => people.id,
      { onDelete: "set null" },
    ),
    householdId: text("household_id").references(() => households.id, {
      onDelete: "set null",
    }),
    // The payment intermediary (Stripe itself, a DAF, etc.) the donor gave
    // through, when applicable.
    matchedPaymentIntermediaryId: text(
      "matched_payment_intermediary_id",
    ).references(() => paymentIntermediaries.id, { onDelete: "set null" }),

    matchedGiftId: text("matched_gift_id").references(
      () => giftsAndPayments.id,
      { onDelete: "set null" },
    ),
    createdGiftId: text("created_gift_id").references(
      () => giftsAndPayments.id,
      { onDelete: "set null" },
    ),

    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedByUserId: text("rejected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("stripe_staged_charges_status_idx").on(t.status),
    index("stripe_staged_charges_match_status_idx").on(t.matchStatus),
    index("stripe_staged_charges_payout_id_idx").on(t.stripePayoutId),
    index("stripe_staged_charges_date_received_idx").on(t.dateReceived),
    index("stripe_staged_charges_gross_amount_idx").on(t.grossAmount),
    index("stripe_staged_charges_organization_id_idx").on(t.organizationId),
    index("stripe_staged_charges_individual_giver_person_id_idx").on(
      t.individualGiverPersonId,
    ),
    index("stripe_staged_charges_household_id_idx").on(t.householdId),
    // One-to-one staged↔gift linkage (same guard as staged_payments).
    uniqueIndex("stripe_staged_charges_matched_gift_id_uq")
      .on(t.matchedGiftId)
      .where(sql`${t.matchedGiftId} IS NOT NULL`),
    uniqueIndex("stripe_staged_charges_created_gift_id_uq")
      .on(t.createdGiftId)
      .where(sql`${t.createdGiftId} IS NOT NULL`),
  ],
);

export type StripeStagedCharge = typeof stripeStagedCharges.$inferSelect;
export type NewStripeStagedCharge = typeof stripeStagedCharges.$inferInsert;
