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
  quickbooksEntityTypeEnum,
  quickbooksPayerTypeEnum,
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
import { quickbooksHandlingRules } from "./quickbooksHandlingRules";

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
    // The underlying bank Deposit this incoming money belongs to, when known.
    // For a direct deposit LINE this is the deposit's own entity id; for a
    // Payment/SalesReceipt that was bundled into a bank deposit it is threaded
    // from the deposit→entity back-index at pull time. NULL when the unit is not
    // tied to a deposit (e.g. an undeposited payment, or a row staged before
    // this column existed). Several staged rows sharing one non-null
    // qbDepositId are the candidates a fundraiser may MANUALLY group into a
    // single "deposit unit" and reconcile as a whole to one multi-allocation
    // gift. Grouping never spans deposits.
    qbDepositId: text("qb_deposit_id"),

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

    // ── QuickBooks payer + entity context captured at pull time ───────────
    // All of the following are read-only facts mirrored from QuickBooks. They
    // are NEVER part of review state, so the full re-pull may refresh them on
    // any row (including approved/rejected) without touching the reconcile.
    //
    // The kind of QB name the payer resolves to (Customer / Vendor / Employee).
    // A vendor/employee payer is a strong "not a donation" hint. NULL when QB
    // supplied no payer ref.
    qbPayerType: quickbooksPayerTypeEnum("qb_payer_type"),
    // The QB id of that payer ref (stable across renames; lets us link back to
    // the QB Customer/Vendor/Employee record).
    qbPayerId: text("qb_payer_id"),
    // QB PaymentMethodRef name (e.g. "Check", "ACH", "Visa") — entity-level for
    // SalesReceipt/Payment, line-level for a deposit line.
    qbPaymentMethod: text("qb_payment_method"),
    // Check number / payment reference number (deposit line CheckNum, or the
    // entity's PaymentRefNum). Distinct from rawReference, which prefers the
    // DocNumber for display.
    qbCheckNumber: text("qb_check_number"),
    // The bank/asset account the money was deposited to (DepositToAccountRef).
    qbDepositToAccountName: text("qb_deposit_to_account_name"),
    // The entity's DocNumber, kept verbatim (rawReference may massage this).
    qbDocNumber: text("qb_doc_number"),
    // The payer's billing address, flattened to a single display string
    // (SalesReceipt BillAddr). NULL when the entity carries no address.
    qbBillingAddress: text("qb_billing_address"),
    // The transaction-level PrivateNote (entity memo) — distinct from
    // lineDescription, which prefers the per-line note for deposit lines.
    qbTransactionMemo: text("qb_transaction_memo"),
    // QB currency code (CurrencyRef.value, e.g. "USD") and the exchange rate to
    // home currency (ExchangeRate). Captured for multi-currency auditing.
    qbCurrency: text("qb_currency"),
    qbExchangeRate: numeric("qb_exchange_rate", { precision: 18, scale: 6 }),
    // When the QB record was created (MetaData.CreateTime), distinct from when
    // we first staged it (createdAt).
    qbCreateTime: timestamp("qb_create_time", { withTimezone: true }),
    // The line's LinkedTxn references (each { txnId, txnType }) — e.g. a deposit
    // line linked to the Payment it re-records, or a Payment linked to the
    // Invoice it pays. Kept for provenance and dedupe auditing.
    qbLinkedTxn:
      jsonb("qb_linked_txn").$type<{ txnId: string; txnType: string }[]>(),
    // The complete raw QuickBooks entity payload, stored verbatim so any future
    // field can be derived WITHOUT re-pulling from QuickBooks. Excluded from
    // list API responses (heavy) — storage only.
    qbRaw: jsonb("qb_raw"),
    // For deposit-line rows only: the specific deposit Line object, verbatim.
    qbRawLine: jsonb("qb_raw_line"),

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

    // Deposit-group reconciliation (manual): when a fundraiser groups several
    // staged rows that share one bank deposit and matches the GROUP to a single
    // existing multi-allocation gift, EVERY member (including the representative)
    // gets this set to that gift's id. It marks group membership; the group is
    // exactly the rows sharing this gift id. To stay compatible with the
    // one-staged↔one-gift partial-unique index on matchedGiftId, only ONE member
    // (the "representative") also carries matchedGiftId = the same gift; the
    // others reconcile to the gift via this column alone. A grouped gift is
    // therefore "linked" through its representative's matchedGiftId (existing
    // gift-linkage logic is unchanged), while members still display the gift via
    // the resolved-gift join's COALESCE. Cleared for the whole group on revert.
    groupReconciledGiftId: text("group_reconciled_gift_id").references(
      () => giftsAndPayments.id,
      { onDelete: "set null" },
    ),

    // The admin-editable handling rule (quickbooks_handling_rules) that caused
    // this row to be auto-excluded or auto-created+approved at ingest / apply
    // time. NULL for rows classified by the legacy code-only classifier, rows
    // that were manually classified, or rows that matched no rule at all.
    // SET NULL on rule delete so audit rows are never orphaned.
    matchedRuleId: text("matched_rule_id").references(
      () => quickbooksHandlingRules.id,
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
    // Look up the candidate members of a bank deposit (manual deposit-grouping)
    // and the members of an already-grouped reconciliation.
    index("staged_payments_qb_deposit_id_idx").on(t.qbDepositId),
    index("staged_payments_group_reconciled_gift_id_idx").on(
      t.groupReconciledGiftId,
    ),
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
