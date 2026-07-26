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
import { bankDeposits } from "./bankDeposits";
import { bankTransactions } from "./bankTransactions";

/**
 * Typed evidence link between a real bank deposit and the matching QBO bank
 * register row. This documents accounting evidence only: it never composes
 * payment units, mints gifts, or anchors payment applications.
 *
 * The matcher writes only unique amount/date-window pairs. `ambiguous` is
 * reserved for a future human-candidate workflow and remains false today.
 */
export const bankDepositQboRegister = pgTable(
  "bank_deposit_qbo_register",
  {
    id: text("id").primaryKey(),
    bankDepositId: text("bank_deposit_id")
      .notNull()
      .references(() => bankDeposits.id, { onDelete: "restrict" }),
    bankTransactionId: text("bank_transaction_id")
      .notNull()
      .references(() => bankTransactions.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    ambiguous: boolean("ambiguous").notNull().default(false),
    matchedAt: timestamp("matched_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bank_deposit_qbo_register_bank_deposit_id_uq").on(t.bankDepositId),
    uniqueIndex("bank_deposit_qbo_register_bank_transaction_id_uq").on(t.bankTransactionId),
    index("bank_deposit_qbo_register_bank_deposit_id_idx").on(t.bankDepositId),
    index("bank_deposit_qbo_register_bank_transaction_id_idx").on(t.bankTransactionId),
    check("bank_deposit_qbo_register_amount_positive_chk", sql`${t.amount} > 0`),
  ],
);

export type BankDepositQboRegister = typeof bankDepositQboRegister.$inferSelect;
export type NewBankDepositQboRegister = typeof bankDepositQboRegister.$inferInsert;
