import {
  pgTable,
  text,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { depositQboMatchBasisEnum } from "./_enums";
import { bankDeposits } from "./bankDeposits";
import { stagedPayments } from "./stagedPayments";
import { users } from "./users";

/**
 * Provisional QBO accounting-plane decomposition of a real bank deposit.
 *
 * These rows preserve QBO Deposit member lines as accounting evidence when the
 * authoritative bank-deposit spine has not yet been decomposed into
 * payment_units and bank_deposit_components. They never count money, establish
 * payment completeness, or replace bank_deposit_components; the counted money
 * authority remains payment_units → payment_applications.
 *
 * One staged payment line may be provisionally associated with at most one bank
 * deposit. Confirmation is a finance review fact only and does not promote the
 * row into the counted money spine.
 */
export const depositQboComponents = pgTable(
  "deposit_qbo_components",
  {
    id: text("id").primaryKey(),
    bankDepositId: text("bank_deposit_id")
      .notNull()
      .references(() => bankDeposits.id, { onDelete: "restrict" }),
    realmId: text("realm_id").notNull(),
    qbDepositId: text("qb_deposit_id").notNull(),
    stagedPaymentId: text("staged_payment_id")
      .notNull()
      .references(() => stagedPayments.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    matchBasis: depositQboMatchBasisEnum("match_basis").notNull(),
    confirmed: boolean("confirmed").notNull().default(false),
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("deposit_qbo_components_staged_payment_id_uq").on(t.stagedPaymentId),
    index("deposit_qbo_components_bank_deposit_id_idx").on(t.bankDepositId),
    index("deposit_qbo_components_qb_deposit_id_idx").on(t.qbDepositId),
    check("deposit_qbo_components_amount_positive_chk", sql`${t.amount} > 0`),
  ],
);

export type DepositQboComponent = typeof depositQboComponents.$inferSelect;
export type NewDepositQboComponent = typeof depositQboComponents.$inferInsert;
