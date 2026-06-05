import {
  pgTable,
  text,
  timestamp,
  numeric,
  date,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import {
  quickbooksEntityTypeEnum,
  stagedPaymentStatusEnum,
  stagedPaymentExclusionReasonEnum,
  stagedPaymentMatchStatusEnum,
} from "./_enums";
import { organizations } from "./organizations";
import { people } from "./people";
import { households } from "./households";
import { giftsAndPayments } from "./giftsAndPayments";
import { users } from "./users";

/**
 * Review queue for incoming-money records pulled one-way from QuickBooks
 * Online (SalesReceipt / Payment / Deposit). The sync worker stages a row
 * here for each QB entity; a fundraiser confirms/fixes the donor match and
 * approves, which creates a real `gifts_and_payments` row.
 *
 * Idempotency: a unique index on (realmId, qbEntityType, qbEntityId) means
 * re-syncing never duplicates a queue entry or the resulting ledger gift.
 * Approved/rejected rows are retained (not deleted) so a later sync of the
 * same QB entity is a no-op rather than re-staging it.
 *
 * Donor match follows the same XOR rule as gifts: at most one of
 * organizationId / individualGiverPersonId / householdId may be set. The
 * approve endpoint enforces exactly-one via validateGiftInvariants.
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

    // Normalized incoming-money facts pulled from QuickBooks.
    amount: numeric("amount", { precision: 14, scale: 2 }),
    dateReceived: date("date_received"),
    payerName: text("payer_name"),
    payerEmail: text("payer_email"),
    // Human-readable reference (doc number, memo, txn ref) for context in
    // the review queue.
    rawReference: text("raw_reference"),

    status: stagedPaymentStatusEnum("status").notNull().default("pending"),
    // Set only when status = "excluded" — why the row was auto-filtered.
    exclusionReason: stagedPaymentExclusionReasonEnum("exclusion_reason"),
    matchStatus: stagedPaymentMatchStatusEnum("match_status")
      .notNull()
      .default("unmatched"),

    // When a human confirms the donor match (either by confirming a
    // system-suggested match or by picking the donor themselves), these
    // record who/when. NULL while a row is unmatched or only system-matched.
    // This is what distinguishes a "system matched" row (matchStatus =
    // "matched" but matchConfirmedAt IS NULL) from a "human approved" one
    // (matchConfirmedAt IS NOT NULL). It is independent of `status`, which
    // tracks whether the row has been minted into a gift.
    matchConfirmedByUserId: text("match_confirmed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    matchConfirmedAt: timestamp("match_confirmed_at", { withTimezone: true }),

    // QuickBooks line-item detail captured at pull time, used by the noise
    // classifier (membership detection) and to make exclusions auditable.
    // For Payment entities (which carry no lines of their own) these come from
    // the linked Invoice's lines; for SalesReceipt/Deposit they come from the
    // transaction's own lines. Arrays because a transaction can have many lines.
    lineItemNames: text("line_item_names").array(),
    lineAccountNames: text("line_account_names").array(),
    lineClasses: text("line_classes").array(),

    // Donor match (XOR). Populated by auto-match at sync time and/or by the
    // fundraiser via the resolve endpoint. All FKs set-null on donor delete.
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

    // Set when approved → the gifts_and_payments row this became.
    createdGiftId: text("created_gift_id").references(
      () => giftsAndPayments.id,
      { onDelete: "set null" },
    ),
    // Distinguishes the two "approved" resolutions, since createdGiftId is
    // overloaded: true when the row was tied to a pre-existing gift via the
    // link endpoint, false when "Approve → create gift" minted a new one. Only
    // linked rows may be unlinked (unlinking a minted gift would orphan it).
    giftWasLinked: boolean("gift_was_linked").notNull().default(false),

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
    ),
    index("staged_payments_status_idx").on(t.status),
    index("staged_payments_organization_id_idx").on(t.organizationId),
    index("staged_payments_individual_giver_person_id_idx").on(
      t.individualGiverPersonId,
    ),
    index("staged_payments_household_id_idx").on(t.householdId),
  ],
);

export type StagedPayment = typeof stagedPayments.$inferSelect;
export type NewStagedPayment = typeof stagedPayments.$inferInsert;
