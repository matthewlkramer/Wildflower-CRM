import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bankTransactionSourceEnum } from "./_enums";
import { users } from "./users";

/**
 * One durable receipt per source file processed by an automated or manual
 * bank import. bank_transactions contains the deduplicated evidence rows;
 * this table answers the separate operational question "when did we last
 * receive and successfully process a report?" even when a YTD file contains
 * zero new transactions.
 */
export const bankTransactionImports = pgTable(
  "bank_transaction_imports",
  {
    id: text("id").primaryKey(),
    source: bankTransactionSourceEnum("source").notNull(),
    sourceFile: text("source_file").notNull(),
    mailboxUserId: text("mailbox_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    gmailMessageId: text("gmail_message_id"),
    gmailAttachmentId: text("gmail_attachment_id"),
    contentSha256: text("content_sha256").notNull(),
    reportStartDate: date("report_start_date"),
    reportEndDate: date("report_end_date"),
    rowCount: integer("row_count").notNull().default(0),
    insertedCount: integer("inserted_count").notNull().default(0),
    status: text("status").notNull(),
    error: text("error"),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "bank_transaction_imports_status_chk",
      sql`${t.status} IN ('succeeded', 'rejected')`,
    ),
    check(
      "bank_transaction_imports_counts_chk",
      sql`${t.rowCount} >= 0 AND ${t.insertedCount} >= 0 AND ${t.insertedCount} <= ${t.rowCount}`,
    ),
    uniqueIndex("bank_transaction_imports_gmail_attachment_uq")
      .on(t.mailboxUserId, t.gmailMessageId, t.gmailAttachmentId)
      .where(
        sql`${t.mailboxUserId} IS NOT NULL AND ${t.gmailMessageId} IS NOT NULL AND ${t.gmailAttachmentId} IS NOT NULL`,
      ),
    index("bank_transaction_imports_source_processed_idx").on(
      t.source,
      t.processedAt,
    ),
  ],
);

export type BankTransactionImport = typeof bankTransactionImports.$inferSelect;
export type NewBankTransactionImport =
  typeof bankTransactionImports.$inferInsert;
