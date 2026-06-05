import {
  pgTable,
  text,
  integer,
  timestamp,
  numeric,
  date,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  quickbooksEntityTypeEnum,
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

/**
 * Review queue for incoming-money records pulled one-way from QuickBooks
 * Online (SalesReceipt / Payment / Deposit). The sync worker stages a row
 * here for each incoming-money UNIT; a scored matcher resolves the donor
 * and an existing CRM gift (or decides to mint one), and a fundraiser
 * reconciles anything the matcher wasn't sure about.
 *
 * ── Granularity ────────────────────────────────────────────────────────
 * The matching UNIT is one of:
 *   - a SalesReceipt   (one entity, one donor)
 *   - a Payment        (one entity, one donor)
 *   - a single Deposit LINE (a bank deposit bundles many donors, one per
 *     line — each line carries its own payer Entity / amount / memo, so we
 *     stage PER LINE, never the whole deposit). Deposit lines that merely
 *     re-record an already-ingested Payment/SalesReceipt (LinkedTxn) are
 *     skipped at pull time so the same money is never staged twice.
 *
 * Idempotency: unique on (realmId, qbEntityType, qbEntityId, qbLineId).
 * Non-deposit rows use qbLineId = '' (empty, NOT null) so the unique index
 * dedupes them too (Postgres treats NULLs as distinct).
 *
 * ── Queues (derived) ───────────────────────────────────────────────────
 *   Auto-matched : status='approved' AND autoApplied=true AND
 *                  matchConfirmedAt IS NULL — high-confidence matches the
 *                  system already applied (linked an existing gift OR minted
 *                  one). Assumed correct; a human reviews/corrects on demand.
 *   Needs review : status='pending' — uncertain. matchStatus may be
 *                  'suggested' (a hint) or 'unmatched' (nothing). Nothing is
 *                  applied to the ledger until a human acts.
 *   Excluded     : status='excluded' — auto/manual non-donation noise.
 *   (Done        : status='approved' AND (matchConfirmedAt IS NOT NULL OR
 *                  autoApplied=false) — fully reconciled, out of review.)
 *
 * Donor match follows the same XOR rule as gifts: at most one of
 * organizationId / individualGiverPersonId / householdId is set. The
 * approve/reconcile endpoints enforce exactly-one via validateGiftInvariants.
 *
 * A row is reconciled in exactly one of two ways (mutually exclusive):
 *   - matchedGiftId set  → linked to a PRE-EXISTING gifts_and_payments row.
 *   - createdGiftId set  → a NEW gifts_and_payments row was minted from it.
 * Unlinking is only allowed for matchedGiftId (unlinking a minted gift would
 * orphan it).
 */
export const stagedPayments = pgTable(
  "staged_payments",
  {
    id: text("id").primaryKey(),
    // The QuickBooks company this payment came from.
    realmId: text("realm_id").notNull(),
    qbEntityType: quickbooksEntityTypeEnum("qb_entity_type").notNull(),
    // The QuickBooks entity id (unique per type within a company).
    qbEntityId: text("qb_entity_id").notNull(),
    // The QuickBooks line id, for deposits staged per-line. Empty string
    // (NOT null) for SalesReceipt/Payment so the idempotency unique index
    // treats them as a single unit.
    qbLineId: text("qb_line_id").notNull().default(""),

    // Normalized incoming-money facts pulled from QuickBooks.
    amount: numeric("amount", { precision: 14, scale: 2 }),
    dateReceived: date("date_received"),
    payerName: text("payer_name"),
    payerEmail: text("payer_email"),
    // Human-readable reference (doc number, payment ref) for context.
    rawReference: text("raw_reference"),
    // Per-line / per-entity free-text description or memo (deposit line
    // Description, deposit PrivateNote, CustomerMemo) — context for the
    // reconciler and the memo-based matcher/classifier.
    lineDescription: text("line_description"),

    status: stagedPaymentStatusEnum("status").notNull().default("pending"),
    // Set only when status = "excluded" — why the row was filtered.
    exclusionReason: stagedPaymentExclusionReasonEnum("exclusion_reason"),
    // Whether the exclusion classification was set automatically or pinned
    // by a human. The re-runnable classifier never touches a `manual` row.
    classificationSource: stagedPaymentClassificationSourceEnum(
      "classification_source",
    )
      .notNull()
      .default("auto"),

    // Scored-match outcome (see stagedPaymentMatchStatusEnum).
    matchStatus: stagedPaymentMatchStatusEnum("match_status")
      .notNull()
      .default("unmatched"),
    // 0–100 confidence of the best donor/gift match the scorer found.
    matchScore: integer("match_score"),
    // How the match was derived (audit + UI badge).
    matchMethod: stagedPaymentMatchMethodEnum("match_method"),
    // True when the system auto-applied this match to the ledger at high
    // confidence (links the Auto-matched review queue). Reset on unmatch.
    autoApplied: boolean("auto_applied").notNull().default(false),

    // Set when a human confirms the match (confirming a suggestion or
    // picking the donor/gift themselves). NULL while a row is unconfirmed
    // (including auto-applied rows awaiting review). Independent of `status`.
    matchConfirmedByUserId: text("match_confirmed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    matchConfirmedAt: timestamp("match_confirmed_at", { withTimezone: true }),

    // QuickBooks line-item detail captured at pull time, used by the noise
    // classifier (membership/loan/etc.) and to make exclusions auditable.
    // For Payment entities (which carry no lines of their own) these come
    // from the linked Invoice's lines; for SalesReceipt/Deposit-line they
    // come from that line's own detail.
    lineItemNames: text("line_item_names").array(),
    lineAccountNames: text("line_account_names").array(),
    lineClasses: text("line_classes").array(),

    // Donor match (XOR). Populated by the scorer and/or a human. All FKs
    // set-null on donor delete.
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

    // The payment intermediary (DAF / giving platform / wealth manager) the
    // payer resolved to, when the donor gives THROUGH one. Set alongside a
    // donor; the donor is the ultimate giver, this is the conduit.
    matchedPaymentIntermediaryId: text(
      "matched_payment_intermediary_id",
    ).references(() => paymentIntermediaries.id, { onDelete: "set null" }),

    // Reconciliation target (mutually exclusive):
    //   matchedGiftId — linked to a PRE-EXISTING gift (no new ledger row).
    matchedGiftId: text("matched_gift_id").references(
      () => giftsAndPayments.id,
      { onDelete: "set null" },
    ),
    //   createdGiftId — a NEW gift minted from this staged payment.
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
    uniqueIndex("staged_payments_qb_entity_uq").on(
      t.realmId,
      t.qbEntityType,
      t.qbEntityId,
      t.qbLineId,
    ),
    index("staged_payments_status_idx").on(t.status),
    index("staged_payments_match_status_idx").on(t.matchStatus),
    index("staged_payments_date_received_idx").on(t.dateReceived),
    index("staged_payments_amount_idx").on(t.amount),
    index("staged_payments_organization_id_idx").on(t.organizationId),
    index("staged_payments_individual_giver_person_id_idx").on(
      t.individualGiverPersonId,
    ),
    index("staged_payments_household_id_idx").on(t.householdId),
    // One-to-one staged↔gift linkage: at most one staged row may reconcile to
    // (matchedGiftId) or mint (createdGiftId) any given gift. Partial-unique so
    // the many NULLs (unresolved rows) don't collide, and so this also serves
    // as the lookup index. Backstops the route/worker NOT EXISTS guards against
    // write-skew under concurrent reconciles.
    uniqueIndex("staged_payments_matched_gift_id_uq")
      .on(t.matchedGiftId)
      .where(sql`${t.matchedGiftId} IS NOT NULL`),
    uniqueIndex("staged_payments_created_gift_id_uq")
      .on(t.createdGiftId)
      .where(sql`${t.createdGiftId} IS NOT NULL`),
  ],
);

export type StagedPayment = typeof stagedPayments.$inferSelect;
export type NewStagedPayment = typeof stagedPayments.$inferInsert;
