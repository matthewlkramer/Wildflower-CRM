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
  stagedPaymentExclusionReasonEnum,
  stagedPaymentMatchStatusEnum,
  stagedPaymentMatchMethodEnum,
  stagedPaymentClassificationSourceEnum,
  stripeRefundPropagationStatusEnum,
  stripeRefundKindEnum,
} from "./_enums";
import { organizations } from "./organizations";
import { people } from "./people";
import { households } from "./households";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";
import { stripePayouts } from "./stripePayouts";
import { stagedPayments } from "./stagedPayments";
import { entities } from "./entities";
import { fundableProjects } from "./fundableProjects";

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
 * preserve review state (exclusion / donor match / gift linkage) and only
 * refresh read-only Stripe facts.
 *
 * Status is fully DERIVED from facts (no stored status column), in precedence
 * order (see api-server lib/derivedStatus.ts): excluded ⇐ exclusionReason
 * NOT NULL; match_proposed ⇐ autoApplied AND matchConfirmedAt IS NULL AND a
 * counted ledger gift link; match_confirmed ⇐ a counted ledger gift link;
 * else pending.
 *
 * Gift linkage lives in the payment_applications ledger (counted stripe rows;
 * created_the_gift marks a mint). The legacy matchedGiftId / createdGiftId
 * pointer columns are RETIRED — never read or written.
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

    // ── Human-reviewed bookkeeping dimensions (edited-tables import) ────────
    // Hand-maintained review facts; the Stripe re-pull NEVER writes them.
    // Which Wildflower legal entity this charge's money belongs to (parallel
    // to staged_payments.entityId, but human-attributed — there is no
    // detectEntity for Stripe charges).
    entityId: text("entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    // Region slug (plain text, NOT an FK — region model rethink is a planned
    // follow-on). Same convention as staged_payments.regional.
    regional: text("regional"),
    // The specific fundable project this charge's money funds, when known.
    fundableProjectId: text("fundable_project_id").references(
      () => fundableProjects.id,
      { onDelete: "set null" },
    ),
    // Money belonging to the Seed Fund initiative.
    seedFund: boolean("seed_fund").notNull().default(false),

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

    /**
     * @deprecated RETIRED pointer (physical column kept; never read/written).
     * The charge↔gift link is the counted `payment_applications` ledger row
     * (`stripe_charge_id` anchor); a mint is `created_the_gift = true`.
     */
    matchedGiftId: text("matched_gift_id").references(
      () => giftsAndPayments.id,
      { onDelete: "set null" },
    ),
    /** @deprecated RETIRED pointer — see matchedGiftId. */
    createdGiftId: text("created_gift_id").references(
      () => giftsAndPayments.id,
      { onDelete: "set null" },
    ),

    // ── Refund / chargeback propagation (INV-13, propose-then-confirm) ───
    // When a refund or dispute lands on a charge whose money is already booked
    // into a CRM gift, the sync worker RAISES a proposal here; a human confirms
    // (reverse/reduce the gift) or dismisses it. Detected via refund/dispute
    // balance transactions on later payouts (the original charge is not
    // re-pulled), so the live `refunded`/`disputed`/`amountRefunded` facts above
    // are refreshed in lockstep when a proposal is raised.
    refundPropagationStatus: stripeRefundPropagationStatusEnum(
      "refund_propagation_status",
    )
      .notNull()
      .default("none"),
    refundPropagationKind: stripeRefundKindEnum("refund_propagation_kind"),
    // The CRM gift the proposal targets (snapshot of the gift link at propose
    // time); set null if that gift is later removed.
    refundPropagationGiftId: text("refund_propagation_gift_id").references(
      () => giftsAndPayments.id,
      { onDelete: "set null" },
    ),
    // The absolute amount being reversed by this proposal (gross for a full
    // refund / chargeback, the cumulative Stripe amount_refunded for a partial).
    // Doubles as the idempotency signature so a re-sync of the same refund state
    // never re-raises an already-handled proposal.
    refundProposedAmount: numeric("refund_proposed_amount", {
      precision: 14,
      scale: 2,
    }),
    refundConfirmedByUserId: text("refund_confirmed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    refundConfirmedAt: timestamp("refund_confirmed_at", { withTimezone: true }),

    // ── Cross-processor link (human-confirmed, additive) ────────────────
    // A reviewer-confirmed tie from this Stripe charge to the QuickBooks
    // staged_payments row that records the SAME money (a per-charge QB↔Stripe
    // link, finer than the payout-level `stripe_payouts.matched_qb_staged_payment_id`).
    // Purely additive provenance so the Reconciliation Workbench can persist a
    // confirmed cross-processor tie WITHOUT re-deriving the settlement lineage
    // every time. Never mints/mutates a gift and never written back to any
    // processor. SET NULL if the QB staged row is removed.
    linkedQbStagedPaymentId: text("linked_qb_staged_payment_id").references(
      () => stagedPayments.id,
      { onDelete: "set null" },
    ),
    // A SYSTEM-PROPOSED (not yet confirmed) charge↔QB tie awaiting a human
    // approve on the Settlement report — the charge-grain analogue of a
    // `proposed` settlement link, for payouts the bookkeeper booked as
    // individual QB rows instead of one deposit lump. Written ONLY by the
    // idempotent charge-grain proposal pass (never while a confirmed
    // `linkedQbStagedPaymentId` exists); approve moves it into
    // `linkedQbStagedPaymentId` + provenance and clears it. SET NULL if the QB
    // staged row is removed.
    proposedQbStagedPaymentId: text("proposed_qb_staged_payment_id").references(
      () => stagedPayments.id,
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
    index("stripe_staged_charges_match_status_idx").on(t.matchStatus),
    index("stripe_staged_charges_payout_id_idx").on(t.stripePayoutId),
    index("stripe_staged_charges_linked_qb_staged_payment_id_idx").on(
      t.linkedQbStagedPaymentId,
    ),
    index("stripe_staged_charges_proposed_qb_staged_payment_id_idx").on(
      t.proposedQbStagedPaymentId,
    ),
    index("stripe_staged_charges_date_received_idx").on(t.dateReceived),
    index("stripe_staged_charges_gross_amount_idx").on(t.grossAmount),
    index("stripe_staged_charges_organization_id_idx").on(t.organizationId),
    index("stripe_staged_charges_individual_giver_person_id_idx").on(
      t.individualGiverPersonId,
    ),
    index("stripe_staged_charges_household_id_idx").on(t.householdId),
    // Partial index for the small refund-review queue (proposals awaiting a
    // human confirm/dismiss) — most rows are 'none', so keep the index tiny.
    index("stripe_staged_charges_refund_propagation_idx")
      .on(t.refundPropagationStatus)
      .where(sql`${t.refundPropagationStatus} = 'proposed'`),
    // Legacy 1:1 guards on the RETIRED pointer columns (kept physical so the
    // Publish diff stays quiet; the ledger's own uniques are authoritative).
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
