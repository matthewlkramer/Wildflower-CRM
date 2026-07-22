import {
  pgTable,
  text,
  integer,
  timestamp,
  numeric,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { bankTransactionSourceEnum } from "./_enums";

/**
 * Raw bank-account transaction evidence — one row per register line in the
 * organization's bank account, tagged by `source`.
 *
 * Current source: `qbo_register_export` — seven overlapping QuickBooks Online
 * bank-register XLS exports (2016 → 2026), merged and deduplicated at import
 * time by the scripts importer (`import:bank-register`). A future `plaid`
 * source will append live feed rows under the same shape.
 *
 * This is EVIDENCE, not CRM data:
 *   - read-only after import; rows are never edited, split, or archived;
 *   - it never mints gifts and never anchors `payment_applications` rows;
 *   - it carries NO foreign keys into CRM or other evidence tables — any
 *     future cross-evidence tie goes through the `source_links` ledger once
 *     its ADR is implemented (never a pointer column here).
 *
 * Dedup model (register exports overlap):
 *   `dedupKey` = the raw register field values
 *   date|ref|payee|memo|payment|deposit|type|balance joined with `|`.
 *   The same key can legitimately occur more than once WITHIN one export
 *   (e.g. repeated voided payments on one day at an identical running
 *   balance), so the true multiplicity of a key is the MAX count observed in
 *   any single file; `occurrence` (0-based) distinguishes those copies. The
 *   unique index on (source, dedupKey, occurrence) makes re-imports
 *   idempotent (ON CONFLICT DO NOTHING).
 */
export const bankTransactions = pgTable(
  "bank_transactions",
  {
    // Deterministic id derived from (source, dedupKey, occurrence) so
    // re-imports are stable: `bnk_<sha256 prefix>`.
    id: text("id").primaryKey(),

    source: bankTransactionSourceEnum("source").notNull(),
    // Which export file the kept copy came from (basename, no path).
    sourceFile: text("source_file").notNull(),

    // ── Register facts (verbatim from the export) ───────────────────────
    txnDate: date("txn_date").notNull(),
    // QBO transaction type: Deposit / Payment / Journal / Transfer / …
    txnType: text("txn_type"),
    refNo: text("ref_no"),
    payee: text("payee"),
    memo: text("memo"),
    class: text("class"),
    account: text("account"),
    location: text("location"),
    // QBO reconciliation status letter (R / C / blank) — the bank-rec state
    // inside QuickBooks, unrelated to CRM reconciliation.
    reconciliationStatus: text("reconciliation_status"),
    addedInBanking: text("added_in_banking"),

    // ── Money (major units, 2dp; sign as in the register) ───────────────
    // Money out. NULL when the row is a deposit-only line.
    payment: numeric("payment", { precision: 14, scale: 2 }),
    // Money in. NULL when the row is a payment-only line.
    deposit: numeric("deposit", { precision: 14, scale: 2 }),
    // Running account balance after this row, as exported.
    balance: numeric("balance", { precision: 14, scale: 2 }),

    // ── Dedup identity (see header comment) ─────────────────────────────
    dedupKey: text("dedup_key").notNull(),
    occurrence: integer("occurrence").notNull().default(0),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bank_transactions_source_dedup_key_occurrence_uq").on(
      t.source,
      t.dedupKey,
      t.occurrence,
    ),
    index("bank_transactions_txn_date_idx").on(t.txnDate),
    index("bank_transactions_txn_type_idx").on(t.txnType),
    index("bank_transactions_deposit_idx").on(t.deposit),
    index("bank_transactions_payee_idx").on(t.payee),
  ],
);

export type BankTransaction = typeof bankTransactions.$inferSelect;
export type NewBankTransaction = typeof bankTransactions.$inferInsert;
