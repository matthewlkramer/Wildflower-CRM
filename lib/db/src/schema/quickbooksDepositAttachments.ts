import {
  pgTable,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type QuickbooksAttachmentComponent = {
  amount: string;
  payerName: string | null;
  checkNumber: string | null;
  reference: string | null;
};

/**
 * Read-only evidence mirrored from attachments on a QuickBooks Deposit.
 * The source file stays in QuickBooks; the CRM stores only source metadata and
 * the structured component amounts extracted from it. A bank-spine update may
 * use these components only when they add up exactly to the deposit total.
 */
export const quickbooksDepositAttachments = pgTable(
  "quickbooks_deposit_attachments",
  {
    id: text("id").primaryKey(),
    realmId: text("realm_id").notNull(),
    qbAttachableId: text("qb_attachable_id").notNull(),
    qbDepositId: text("qb_deposit_id").notNull(),
    fileName: text("file_name"),
    contentType: text("content_type"),
    note: text("note"),
    qbUpdatedAt: timestamp("qb_updated_at", { withTimezone: true }),
    extractionStatus: text("extraction_status").notNull().default("pending"),
    components: jsonb("components").$type<QuickbooksAttachmentComponent[]>(),
    extractionError: text("extraction_error"),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("qbo_deposit_attachments_source_uq").on(
      t.realmId,
      t.qbAttachableId,
      t.qbDepositId,
    ),
    index("qbo_deposit_attachments_deposit_idx").on(t.realmId, t.qbDepositId),
    check(
      "qbo_deposit_attachments_status_ck",
      sql`${t.extractionStatus} IN ('pending', 'extracted', 'ignored', 'error')`,
    ),
  ],
);

export type QuickbooksDepositAttachment =
  typeof quickbooksDepositAttachments.$inferSelect;
export type NewQuickbooksDepositAttachment =
  typeof quickbooksDepositAttachments.$inferInsert;
