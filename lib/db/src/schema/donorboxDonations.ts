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
  stagedPaymentMatchStatusEnum,
  stagedPaymentMatchMethodEnum,
  donorboxExclusionReasonEnum,
} from "./_enums";
import { organizations } from "./organizations";
import { people } from "./people";
import { households } from "./households";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";
import { stagedPayments } from "./stagedPayments";
import { stripeStagedCharges } from "./stripeStagedCharges";

/**
 * Canonical store of Donorbox donations pulled (read-only) from the Donorbox
 * API. One row per Donorbox donation, keyed by the Donorbox donation id so
 * re-pulls upsert in place (idempotent) and never duplicate a donation.
 *
 * Two purposes, split by `donationType`:
 *
 *   1. ENRICHMENT (donationType === "stripe") — the donation's
 *      `stripeChargeId` (ch_…) equals `stripe_staged_charges.id`, giving a
 *      clean 1:1 join. These rows ENRICH the existing Stripe-sourced record
 *      (campaign, designation, comment, recurring flag, donor profile). They
 *      NEVER mint a CRM gift — the Stripe sync already pulls those charges, so
 *      minting here would double-count. The review columns below stay at their
 *      defaults and these rows never appear in the new-money worklist.
 *
 *   2. NEW MONEY (donationType !== "stripe", e.g. "paypal"/ACH) — money that
 *      does NOT flow through our Stripe sync. These rows are human-reviewed
 *      "new-money candidates": a fundraiser links the row to an existing gift,
 *      mints a new gift (with a dedupe guard), or excludes it. We NEVER
 *      auto-mint and NEVER synthesize a staged_payments row (that table is
 *      QuickBooks-semantic with mandatory QB identity).
 *
 * Idempotency: the upsert refreshes only read-only Donorbox facts (amounts,
 * status, refund, campaign/designation/comment, donor profile, raw payload) and
 * preserves all review state (status / donor match / gift linkage), mirroring
 * the Stripe staged-charge upsert.
 *
 * Gift linkage lives in the payment_applications ledger (counted donorbox
 * rows; created_the_gift marks a mint). The legacy matchedGiftId /
 * createdGiftId pointer columns were DROPPED (migration 0126).
 */
export const donorboxDonations = pgTable(
  "donorbox_donations",
  {
    // The Donorbox donation id (stringified) — primary key for idempotent
    // re-pulls.
    id: text("id").primaryKey(),

    // "stripe" | "paypal" | … — kept as free text because Donorbox may add
    // processors; the enrichment-vs-new-money split keys off `=== "stripe"`.
    donationType: text("donation_type"),

    // ── Processor identifiers ───────────────────────────────────────────
    // For Stripe-type donations this equals stripe_staged_charges.id (ch_…) —
    // the enrichment join key (partial-unique so the join stays 1:1).
    stripeChargeId: text("stripe_charge_id"),
    // For PayPal-type donations — used by the new-money dedupe guard.
    paypalTransactionId: text("paypal_transaction_id"),

    // ── Money (major units, 2dp) ────────────────────────────────────────
    amount: numeric("amount", { precision: 14, scale: 2 }),
    amountRefunded: numeric("amount_refunded", { precision: 14, scale: 2 }),
    processingFee: numeric("processing_fee", { precision: 14, scale: 2 }),
    currency: text("currency"),

    // Donorbox donation status ("paid" | "refunded" | …). Distinct from the
    // review `status` column below.
    donationStatus: text("donation_status"),
    // True when fully/partially refunded in Donorbox — surfaced as a badge so a
    // reviewer can reverse/reduce a gift minted from this donation by hand
    // (Donorbox refunds are NOT auto-applied to gifts).
    refunded: boolean("refunded").notNull().default(false),
    recurring: boolean("recurring").notNull().default(false),

    // When the donation was made (Donorbox donation_date) — the sync cursor.
    donatedAt: timestamp("donated_at", { withTimezone: true }),
    // Calendar date the gift is credited to (donatedAt in America/Chicago).
    dateReceived: date("date_received"),

    // ── Donorbox context (read-only; refreshed on re-pull) ──────────────
    campaignId: text("campaign_id"),
    campaignName: text("campaign_name"),
    designation: text("designation"),
    comment: text("comment"),
    anonymous: boolean("anonymous").notNull().default(false),
    giftAid: boolean("gift_aid").notNull().default(false),

    // ── Donor profile (read-only; refreshed on re-pull) ─────────────────
    donorName: text("donor_name"),
    donorEmail: text("donor_email"),
    donorFirstName: text("donor_first_name"),
    donorLastName: text("donor_last_name"),
    donorPhone: text("donor_phone"),
    donorEmployer: text("donor_employer"),

    // UTM attribution + custom questions, stored verbatim as JSON.
    utm: jsonb("utm").$type<Record<string, string>>(),
    questions: jsonb("questions"),
    // The complete raw Donorbox donation payload (storage only; excluded from
    // the list API responses).
    raw: jsonb("raw"),

    // ── Review state (non-Stripe new-money worklist; mirrors staged rows) ─
    //   pending    — awaiting review (default; only meaningful for non-Stripe).
    //   approved   — minted a NEW gift (ledger row with created_the_gift).
    //   reconciled — linked to a PRE-EXISTING gift (counted ledger row).
    //   excluded   — dismissed as not-new-money (exclusionReason set).
    status: stagedPaymentStatusEnum("status").notNull().default("pending"),
    exclusionReason: donorboxExclusionReasonEnum("exclusion_reason"),

    // Suggested donor match (a hint for the reviewer; never auto-applied).
    matchStatus: stagedPaymentMatchStatusEnum("match_status")
      .notNull()
      .default("unmatched"),
    matchScore: integer("match_score"),
    matchMethod: stagedPaymentMatchMethodEnum("match_method"),
    matchConfirmedByUserId: text("match_confirmed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    matchConfirmedAt: timestamp("match_confirmed_at", { withTimezone: true }),

    // Donor match (XOR — at most one set until reconcile/mint enforces it).
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
    // The payment intermediary the donor gave through (Donorbox/PayPal), when
    // applicable.
    matchedPaymentIntermediaryId: text(
      "matched_payment_intermediary_id",
    ).references(() => paymentIntermediaries.id, { onDelete: "set null" }),

    // The legacy gift-pointer columns (matched_gift_id / created_gift_id) were
    // DROPPED (migration 0126): the donation↔gift link is the counted
    // `payment_applications` ledger row (`donorbox_donation_id` anchor); a mint
    // is `created_the_gift = true`. Do not reintroduce gift-pointer columns.

    // ── Cross-processor link (human-confirmed, additive) ────────────────
    // Reviewer-confirmed ties to the SAME money recorded elsewhere, so the
    // Reconciliation Workbench can persist a confirmed cross-processor tie
    // WITHOUT re-deriving the settlement lineage each time. Purely additive
    // provenance — never mints/mutates a gift, never written back to any
    // processor.
    //   linkedQbStagedPaymentId — the QuickBooks staged_payments row recording
    //     this donation (covers non-Stripe Donorbox money — PayPal/ACH — that
    //     lands in a QB bank deposit and has no pulled processor join).
    //   linkedStripeChargeId — the human-CONFIRMED Stripe charge counterpart
    //     (complements the read-only PULLED `stripeChargeId` join key above;
    //     lets a reviewer override/affirm the derived 1:1 Stripe match).
    // Both SET NULL if the referenced row is removed.
    linkedQbStagedPaymentId: text("linked_qb_staged_payment_id").references(
      () => stagedPayments.id,
      { onDelete: "set null" },
    ),
    linkedStripeChargeId: text("linked_stripe_charge_id").references(
      () => stripeStagedCharges.id,
      { onDelete: "set null" },
    ),
    crossProcessorLinkedByUserId: text(
      "cross_processor_linked_by_user_id",
    ).references(() => users.id, { onDelete: "set null" }),
    crossProcessorLinkedAt: timestamp("cross_processor_linked_at", {
      withTimezone: true,
    }),

    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // Enrichment join key — 1:1 with stripe_staged_charges.id when present.
    uniqueIndex("donorbox_donations_stripe_charge_id_uq")
      .on(t.stripeChargeId)
      .where(sql`${t.stripeChargeId} IS NOT NULL`),
    index("donorbox_donations_paypal_txn_id_idx").on(t.paypalTransactionId),
    index("donorbox_donations_donation_type_idx").on(t.donationType),
    index("donorbox_donations_status_idx").on(t.status),
    index("donorbox_donations_match_status_idx").on(t.matchStatus),
    index("donorbox_donations_donated_at_idx").on(t.donatedAt),
    index("donorbox_donations_date_received_idx").on(t.dateReceived),
    index("donorbox_donations_amount_idx").on(t.amount),
    index("donorbox_donations_donor_email_idx").on(t.donorEmail),
    index("donorbox_donations_organization_id_idx").on(t.organizationId),
    index("donorbox_donations_individual_giver_person_id_idx").on(
      t.individualGiverPersonId,
    ),
    index("donorbox_donations_household_id_idx").on(t.householdId),
    index("donorbox_donations_linked_qb_staged_payment_id_idx").on(
      t.linkedQbStagedPaymentId,
    ),
    index("donorbox_donations_linked_stripe_charge_id_idx").on(
      t.linkedStripeChargeId,
    ),
  ],
);

export type DonorboxDonation = typeof donorboxDonations.$inferSelect;
export type NewDonorboxDonation = typeof donorboxDonations.$inferInsert;
