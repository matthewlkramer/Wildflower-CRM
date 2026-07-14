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
  stagedPaymentExclusionReasonEnum,
  stagedPaymentMatchStatusEnum,
  stagedPaymentMatchMethodEnum,
  stagedPaymentClassificationSourceEnum,
  stagedPaymentEntitySourceEnum,
  stagedPaymentFundingSourceEnum,
  stagedPaymentFundingSourceProvenanceEnum,
  stagedPaymentPayerTypeEnum,
  stagedPaymentPaymentTypeEnum,
  deferredRevenueEnum,
} from "./_enums";
import { organizations } from "./organizations";
import { people } from "./people";
import { households } from "./households";
import { paymentIntermediaries } from "./paymentIntermediaries";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";
import { quickbooksHandlingRules } from "./quickbooksHandlingRules";
import { entities } from "./entities";

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
 * ── Status (fully DERIVED — there is NO stored status column) ──────────
 * A row's reconciliation status is derived from facts, in precedence order
 * (see api-server lib/derivedStatus.ts, the single source of truth):
 *   excluded        ⇐ exclusionReason IS NOT NULL — auto/manual non-donation
 *                     noise, out of the money flow.
 *   match_proposed  ⇐ autoApplied AND matchConfirmedAt IS NULL AND a counted
 *                     payment_applications row — a high-confidence match the
 *                     system already applied, awaiting human review.
 *   match_confirmed ⇐ a counted payment_applications row OR a confirmed
 *                     settlement link on this deposit row — the money is
 *                     booked.
 *   pending         ⇐ none of the above — needs review; matchStatus may be
 *                     'suggested' (a hint) or 'unmatched' (nothing). Nothing
 *                     is applied to the ledger until a human acts.
 *
 * Donor match follows the same XOR rule as gifts: at most one of
 * organizationId / individualGiverPersonId / householdId is set. The
 * approve/reconcile endpoints enforce exactly-one via validateGiftInvariants.
 *
 * A row's gift linkage lives SOLELY in the counted `payment_applications`
 * ledger: a counted row with `created_the_gift = false` links the payment to a
 * PRE-EXISTING gift; `created_the_gift = true` records that a NEW gift was
 * minted from it. Unlinking is only allowed for non-mint links (unlinking a
 * minted gift would orphan it). The legacy gift-link columns
 * (matchedGiftId / createdGiftId / groupReconciledGiftId) were dropped
 * (migration 0126).
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
    // any row (including resolved ones) without touching the reconcile.
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
    // The QB Location/Department tagged on the transaction (DepartmentRef.name),
    // e.g. "National:Foundation Operations". A read-only QB fact captured at pull
    // time (previously derived from qb_raw at query time). NULL when none.
    qbLocation: text("qb_location"),
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

    // Why the row was filtered out of the money flow. NON-NULL is what makes a
    // row's derived status "excluded" (there is no stored status column).
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
    // (including auto-applied rows awaiting review).
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

    // The legacy gift-pointer columns (matched_gift_id / created_gift_id /
    // group_reconciled_gift_id) were DROPPED (migration 0126) after the ledger
    // cutover: the counted `payment_applications` ledger is the SOLE gift-link
    // record (mint-ownership = `created_the_gift`; group reconciliation = one
    // counted row per member + `unit_groups` membership). Do not reintroduce
    // gift-pointer columns here.

    // "Same physical gift" grouping is now a first-class polymorphic association
    // in `unit_groups` / `unit_group_members` (docs/reconciliation-design.md
    // §4.6b, Decision 7). The legacy `source_group_id` column was retired
    // (migration 0104) after the read+write flip; membership lives entirely in
    // `unit_group_members` (`evidence_source = 'quickbooks'`, `source_id` =
    // staged_payments.id). Do NOT reintroduce a grouping column here.

    // The admin-editable handling rule (quickbooks_handling_rules) that caused
    // this row to be auto-excluded or auto-created+approved at ingest / apply
    // time. NULL for rows classified by the legacy code-only classifier, rows
    // that were manually classified, or rows that matched no rule at all.
    // SET NULL on rule delete so audit rows are never orphaned.
    matchedRuleId: text("matched_rule_id").references(
      () => quickbooksHandlingRules.id,
      { onDelete: "set null" },
    ),

    // Which Wildflower legal entity this incoming money belongs to, derived at
    // ingest / reclassify time from QuickBooks markers (Class, payer, item,
    // account, memo) via `detectEntity`. NULL means "no distinctive entity
    // marker" — treated as the default Wildflower Foundation bucket by the
    // entity queue filter (so historical rows need no backfill to appear under
    // Foundation). Read-only derived QB attribution, NOT review state: the full
    // re-pull may refresh it on any row. Money belonging to a fiscally sponsored
    // entity is attributed here and STAYS in the review queue (it is no longer
    // auto-excluded). SET NULL if the entity row is ever deleted.
    entityId: text("entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    // Whether the entity attribution above was derived automatically by
    // `detectEntity` (`auto`, default) or pinned by a human (`manual`). A
    // `manual` attribution is review state, not a read-only QB fact: the
    // upsert and the reclassifier never overwrite the entity of a manual row,
    // so a hand-filed attribution (e.g. "Sunlight" money that can't be
    // auto-attributed) or a corrected misattribution survives every re-pull.
    entitySource: stagedPaymentEntitySourceEnum("entity_source")
      .notNull()
      .default("auto"),

    // WHERE this incoming money actually came from / how it was rendered
    // (Stripe, brokerage/stock, DAF, Donorbox, PayPal, wire/ACH, check, cash,
    // employer-match, other). A first-class, queryable + human-correctable
    // origin dimension — DISTINCT from qbPaymentMethod (the QB instrument like
    // "Visa") and from the DERIVED reconciliation funding lane (reconcile
    // progress, not origin). NULL = not yet determined / unknown. Auto-seeded
    // at ingest by the pure `detectFundingSource` helper from existing signals,
    // and correctable by a human.
    fundingSource: stagedPaymentFundingSourceEnum("funding_source"),
    // Whether fundingSource was derived automatically (`auto`, default) or
    // pinned by a human (`manual`). A `manual` value is review state: the QB
    // upsert and the re-runnable reclassifier never overwrite the funding
    // source of a `manual` row (CASE-guarded, exactly like entitySource), so a
    // hand-set / corrected origin survives every re-pull.
    fundingSourceProvenance: stagedPaymentFundingSourceProvenanceEnum(
      "funding_source_provenance",
    )
      .notNull()
      .default("auto"),

    // ── Revenue-accounting / QuickBooks coding snapshot (Task #449) ──────────
    // The derived QBO coding snapshot describes a QuickBooks PAYMENT, so it lives
    // HERE (moved off gift_allocations / pledge_allocations). A reviewer edits it
    // in the staged-payment (Finance Reconciliation) surface; the CRM can still
    // produce a live coding-instructions preview from the linked gift's allocation
    // scope (deriveRevenueCoding). All nullable/editable — `*Override` columns let
    // a human override the derived value (effective = override ?? derived).
    objectCode: text("object_code"),
    objectCodeOverride: text("object_code_override"),
    revenueLocation: text("revenue_location"),
    revenueLocationOverride: text("revenue_location_override"),
    revenueClass: text("revenue_class"),
    revenueClassOverride: text("revenue_class_override"),
    // Coding flags surfaced for human review (e.g. "location_default",
    // "payer_type_assumed", "loan_no_revenue_account").
    codingFlags: text("coding_flags").array(),
    // Deferred-revenue capture (CRM captures the answer; it does NOT compute AR).
    deferredRevenue: deferredRevenueEnum("deferred_revenue"),
    deferredRevenueReason: text("deferred_revenue_reason"),

    // ── Human-reviewed bookkeeping dimensions (edited-tables import) ─────────
    // All hand-maintained review facts; the sync/re-pull NEVER writes them.
    // WHO the payer is, semantically (distinct from qbPayerType = QB name kind).
    payerType: stagedPaymentPayerTypeEnum("payer_type"),
    // WHAT the money is, semantically (distinct from exclusionReason and
    // fundingSource).
    paymentType: stagedPaymentPaymentTypeEnum("payment_type"),
    // The conduit (DAF sponsor / giving platform) this money came THROUGH,
    // hand-identified from the payer/memo. Parallel to
    // matchedPaymentIntermediaryId, which belongs to the donor-matching flow —
    // this one is the reviewed bookkeeping fact.
    intermediaryId: text("intermediary_id").references(
      () => paymentIntermediaries.id,
      { onDelete: "set null" },
    ),
    // The true payer when the QB payer name is a conduit or mislabel (e.g. QB
    // says the DAF sponsor; this holds the actual grantor).
    realPayerName: text("real_payer_name"),
    // Human-synthesized payment-method slug (e.g. "stripe", "eft",
    // "direct_wire", "daf") — reviewed origin instrument, distinct from the raw
    // qbPaymentMethod string.
    synthesizedPaymentMethod: text("synthesized_payment_method"),
    // Region slug this money is associated with (plain text, NOT an FK — the
    // region model rethink is a planned follow-on; values like "minnesota",
    // "mid_atlantic", plus legacy buckets like "nor_cal" / "radicle").
    regional: text("regional"),
    // Money belonging to the Seed Fund initiative (cuts across entity/project).
    seedFund: boolean("seed_fund").notNull().default(false),

    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),

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
    index("staged_payments_match_status_idx").on(t.matchStatus),
    // Look up the candidate members of a bank deposit (manual deposit-grouping)
    // and the members of an already-grouped reconciliation.
    index("staged_payments_qb_deposit_id_idx").on(t.qbDepositId),
    index("staged_payments_date_received_idx").on(t.dateReceived),
    index("staged_payments_amount_idx").on(t.amount),
    index("staged_payments_organization_id_idx").on(t.organizationId),
    index("staged_payments_individual_giver_person_id_idx").on(
      t.individualGiverPersonId,
    ),
    index("staged_payments_household_id_idx").on(t.householdId),
    index("staged_payments_entity_id_idx").on(t.entityId),
    index("staged_payments_funding_source_idx").on(t.fundingSource),
  ],
);

export type StagedPayment = typeof stagedPayments.$inferSelect;
export type NewStagedPayment = typeof stagedPayments.$inferInsert;
