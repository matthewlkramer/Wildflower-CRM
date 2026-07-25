import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { stagedPaymentExclusionReasonEnum } from "./_enums";
import { bankDeposits } from "./bankDeposits";
import { users } from "./users";

/**
 * Reviewed, deposit-level "this bank deposit is not fundraising" authority.
 *
 * Some bank deposits are provably non-fundraising money movement that has no
 * QBO/staged-payment record to hang an exclusion on — e.g. internal
 * `ONLINE TRANSFER … CSP/PAYROLL/NONPAYROLL` movements — or whose only tie to a
 * human exclusion decision is an inferred amount+date+name match that must not
 * become a stored relationship. This table records the human decision to treat a
 * specific bank deposit as Not-fundraising directly on the deposit spine.
 *
 * It is a decision authority, not evidence: unlike `bank_deposit_components` or
 * `deposit_qbo_components` it never counts money, never composes a deposit, and
 * never establishes payment completeness. It only drives the workbench
 * Not-fundraising classification. One row per bank deposit (UNIQUE); it is
 * overridable — delete the row to return the deposit to the open queue.
 */
export const bankDepositExclusions = pgTable(
  "bank_deposit_exclusions",
  {
    id: text("id").primaryKey(),
    bankDepositId: text("bank_deposit_id")
      .notNull()
      .references(() => bankDeposits.id, { onDelete: "cascade" }),
    reason: stagedPaymentExclusionReasonEnum("reason").notNull(),
    note: text("note"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bank_deposit_exclusions_bank_deposit_id_uq").on(t.bankDepositId),
    index("bank_deposit_exclusions_reason_idx").on(t.reason),
  ],
);

export type BankDepositExclusion = typeof bankDepositExclusions.$inferSelect;
export type NewBankDepositExclusion = typeof bankDepositExclusions.$inferInsert;
