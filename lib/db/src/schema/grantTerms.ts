import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { opportunitiesAndPledges } from "./opportunitiesAndPledges";
import { pledgeAllocations } from "./pledgeAllocations";
import { pledgeExpectedPayments } from "./pledgeExpectedPayments";
import { users } from "./users";

/**
 * Versioned, human-reviewed interpretations of an opportunity's governing
 * grant documents. Allocation rows remain the authority for accounting scope;
 * an active term set records the evidence and review that produced that scope.
 */
export const grantTermSetSourceEnum = pgEnum("grant_term_set_source", [
  "manual",
  "grant_agreement",
  "amendment",
]);

export const grantTermSetStatusEnum = pgEnum("grant_term_set_status", [
  "pending_review",
  "active",
  "superseded",
  "rejected",
]);

export const grantTermKindEnum = pgEnum("grant_term_kind", [
  "donor_restriction",
  "condition",
  "reporting_requirement",
  "payment_requirement",
  "spending_rule",
  "other_requirement",
]);

export const grantRestrictionDimensionEnum = pgEnum(
  "grant_restriction_dimension",
  ["entity", "geography", "purpose", "time", "project", "school"],
);

export const grantSpendingRuleTypeEnum = pgEnum("grant_spending_rule_type", [
  "allowable_cost",
  "prohibited_cost",
  "cap",
  "prior_approval",
]);

export const grantTermOutcomeEnum = pgEnum("grant_term_outcome", [
  "satisfied",
  "missed",
  "waived",
  "reopened",
]);

export const grantTermSets = pgTable(
  "grant_term_sets",
  {
    id: text("id").primaryKey(),
    opportunityId: text("opportunity_id")
      .notNull()
      .references(() => opportunitiesAndPledges.id, { onDelete: "restrict" }),
    source: grantTermSetSourceEnum("source").notNull(),
    status: grantTermSetStatusEnum("status").notNull(),
    sourceDocumentUrl: text("source_document_url"),
    sourceDocumentFilename: text("source_document_filename"),
    analysisSummary: text("analysis_summary"),
    aiModel: text("ai_model"),
    promptVersion: text("prompt_version"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("grant_term_sets_opportunity_idx").on(t.opportunityId),
    index("grant_term_sets_status_idx").on(t.status),
    // There is exactly one accepted interpretation at a time. Pending AI
    // proposals and superseded history may coexist freely.
    uniqueIndex("grant_term_sets_one_active_per_opportunity_idx")
      .on(t.opportunityId)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex("grant_term_sets_one_pending_per_opportunity_idx")
      .on(t.opportunityId)
      .where(sql`${t.status} = 'pending_review'`),
  ],
);

export const grantTerms = pgTable(
  "grant_terms",
  {
    id: text("id").primaryKey(),
    termSetId: text("term_set_id")
      .notNull()
      .references(() => grantTermSets.id, { onDelete: "restrict" }),
    // Null means the term applies to every allocation in the opportunity.
    pledgeAllocationId: text("pledge_allocation_id").references(
      () => pledgeAllocations.id,
      { onDelete: "set null" },
    ),
    expectedPaymentId: text("expected_payment_id").references(
      () => pledgeExpectedPayments.id,
      { onDelete: "set null" },
    ),
    kind: grantTermKindEnum("kind").notNull(),
    restrictionDimension: grantRestrictionDimensionEnum(
      "restriction_dimension",
    ),
    spendingRuleType: grantSpendingRuleTypeEnum("spending_rule_type"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    exactQuote: text("exact_quote"),
    sourcePage: text("source_page"),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    startDate: date("start_date"),
    endDate: date("end_date"),
    dueDate: date("due_date"),
    barrier: text("barrier"),
    returnOrReleaseRight: text("return_or_release_right"),
    consequence: text("consequence"),
    categories: text("categories").array(),
    capAmount: numeric("cap_amount", { precision: 14, scale: 2 }),
    capPercent: numeric("cap_percent", { precision: 7, scale: 4 }),
    sortOrder: numeric("sort_order", { precision: 8, scale: 0 })
      .default("0")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("grant_terms_term_set_idx").on(t.termSetId),
    index("grant_terms_allocation_idx").on(t.pledgeAllocationId),
    index("grant_terms_expected_payment_idx").on(t.expectedPaymentId),
    check(
      "grant_terms_amount_nonnegative_chk",
      sql`${t.amount} IS NULL OR ${t.amount} >= 0`,
    ),
    check(
      "grant_terms_cap_amount_nonnegative_chk",
      sql`${t.capAmount} IS NULL OR ${t.capAmount} >= 0`,
    ),
    check(
      "grant_terms_cap_percent_range_chk",
      sql`${t.capPercent} IS NULL OR (${t.capPercent} >= 0 AND ${t.capPercent} <= 1)`,
    ),
  ],
);

/** Append-only status evidence for a formal condition or restriction term. */
export const grantTermOutcomeEvents = pgTable(
  "grant_term_outcome_events",
  {
    id: text("id").primaryKey(),
    grantTermId: text("grant_term_id")
      .notNull()
      .references(() => grantTerms.id, { onDelete: "restrict" }),
    outcome: grantTermOutcomeEnum("outcome").notNull(),
    effectiveDate: date("effective_date").notNull(),
    note: text("note"),
    evidenceUrl: text("evidence_url"),
    recordedByUserId: text("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("grant_term_outcome_events_term_idx").on(t.grantTermId, t.createdAt),
  ],
);

/**
 * Human-entered cumulative spending checkpoints for an allocation. These are
 * intentionally not expense-ledger rows and have no QuickBooks relationship.
 */
export const grantSpendSnapshots = pgTable(
  "grant_spend_snapshots",
  {
    id: text("id").primaryKey(),
    pledgeAllocationId: text("pledge_allocation_id")
      .notNull()
      .references(() => pledgeAllocations.id, { onDelete: "restrict" }),
    asOfDate: date("as_of_date").notNull(),
    amountSpentToDate: numeric("amount_spent_to_date", {
      precision: 14,
      scale: 2,
    }).notNull(),
    note: text("note"),
    recordedByUserId: text("recorded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("grant_spend_snapshots_allocation_idx").on(
      t.pledgeAllocationId,
      t.asOfDate,
      t.createdAt,
    ),
    check(
      "grant_spend_snapshots_nonnegative_chk",
      sql`${t.amountSpentToDate} >= 0`,
    ),
  ],
);

export type GrantTermSet = typeof grantTermSets.$inferSelect;
export type NewGrantTermSet = typeof grantTermSets.$inferInsert;
export type GrantTerm = typeof grantTerms.$inferSelect;
export type NewGrantTerm = typeof grantTerms.$inferInsert;
export type GrantTermOutcomeEvent = typeof grantTermOutcomeEvents.$inferSelect;
export type GrantSpendSnapshot = typeof grantSpendSnapshots.$inferSelect;
