import {
  pgTable,
  text,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bankDepositSourceEnum } from "./_enums";
import { bankTransactions } from "./bankTransactions";

/**
 * The SPINE of the money model (docs/adr-bank-spine-money-model.md).
 *
 * One row per real bank deposit — an actual credit that landed in the
 * organization's bank account. Everything else hangs off this: a Stripe payout
 * settles as one bank deposit (`stripe_payouts.bank_deposit_id`, Phase 4); a
 * check deposit is composed of one-or-more check payment units
 * (`bank_deposit_components`, Phase 3). QBO is downstream of this table, not the
 * other way around.
 *
 * ── Source (curated projection, not a new sync) ────────────────────────
 * Today a bank deposit is a PROJECTION of a deposit-type `bank_transactions`
 * row (`source = 'qbo_register_export'`, `deposit IS NOT NULL AND deposit > 0`)
 * — QBO's own mirror of the bank feed. `sourceBankTransactionId` records that
 * provenance and is UNIQUE so the projection is exactly 1:1 and idempotent
 * (re-projection upserts by that key). When a bank-native feed arrives
 * (`plaid`) or a deposit is hand-entered (`manual`), the same table is
 * repopulated from the better source WITHOUT changing the schema or anything
 * that hangs off it — the whole point of making the deposit a first-class
 * object now.
 *
 * ── Derived, never stored ──────────────────────────────────────────────
 * Composition state (unresolved / partial / complete / overallocated) is a
 * pure function of the component amounts (Phase 3) plus any settling payout
 * versus `amount` — it is DERIVED at read time (replit.md invariant #3: one
 * authority per derived fact) and must never become a stored column here.
 *
 * ── Evidence, sync-owned ───────────────────────────────────────────────
 * Like `bank_transactions`, this is evidence: the source facts (amount, date,
 * account) are re-asserted from the source on every (re-)projection and must
 * never be edited to express a relationship. Relationships live in separate
 * columns/tables (`stripe_payouts.bank_deposit_id`, `bank_deposit_components`).
 */
export const bankDeposits = pgTable(
  "bank_deposits",
  {
    // Deterministic id so re-projection is stable and idempotent. For a
    // qbo_register_export projection this is `bdep_<source bnk hash>` (the
    // source bank_transactions id with its `bnk_` prefix swapped) — see the
    // 0159 projection SQL. Plaid/manual rows use their own deterministic scheme.
    id: text("id").primaryKey(),

    source: bankDepositSourceEnum("source").notNull(),

    // The deposit-type bank_transactions row this deposit was projected from.
    // UNIQUE (partial, where non-null) so one register line maps to at most one
    // curated deposit. NULL for manual rows. SET NULL if the raw row is ever
    // removed — the curated deposit survives as the spine (its facts are copied
    // here), the provenance pointer just degrades.
    sourceBankTransactionId: text("source_bank_transaction_id").references(
      () => bankTransactions.id,
      { onDelete: "set null" },
    ),

    // ── Deposit facts (copied from the source; re-asserted on re-projection) ─
    depositDate: date("deposit_date").notNull(),
    // The total that hit the bank (major units, 2dp; always > 0 — a deposit is
    // money in). The component / payout amounts reconcile against this.
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    // The bank/asset account the money landed in (register Account).
    account: text("account"),
    // The register Location tag, kept for entity attribution context.
    location: text("location"),
    // Human-readable reference (register Ref No.) and memo, for matching UI.
    reference: text("reference"),
    memo: text("memo"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // 1:1 projection guarantee (partial — manual rows carry no source pointer).
    uniqueIndex("bank_deposits_source_bank_transaction_id_uq")
      .on(t.sourceBankTransactionId)
      .where(sql`${t.sourceBankTransactionId} IS NOT NULL`),
    index("bank_deposits_deposit_date_idx").on(t.depositDate),
    index("bank_deposits_amount_idx").on(t.amount),
    index("bank_deposits_account_idx").on(t.account),
    // A deposit is money in — always strictly positive.
    check("bank_deposits_amount_positive_chk", sql`${t.amount} > 0`),
  ],
);

export type BankDeposit = typeof bankDeposits.$inferSelect;
export type NewBankDeposit = typeof bankDeposits.$inferInsert;
