import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { emailMessages } from "./emailMessages";

/**
 * One row per attachment on a stored email message. The bytes
 * themselves live in object storage at `storage_key`; we keep the
 * Gmail attachmentId around so we can re-download if the GCS blob
 * is lost or corrupted (Gmail keeps the original indefinitely).
 *
 * Cascade-deletes with the parent message so cleanup is one DELETE.
 */
export const emailAttachments = pgTable(
  "email_attachments",
  {
    id: text("id").primaryKey(),
    emailMessageId: text("email_message_id")
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    filename: text("filename"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    gmailAttachmentId: text("gmail_attachment_id"),
    // GCS object name (inside PRIVATE_OBJECT_DIR's bucket+prefix). The
    // T005 download route resolves this through ObjectStorageService.
    storageKey: text("storage_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("email_attachments_message_idx").on(t.emailMessageId),
    // Idempotency: a sync replay that re-fetches the same Gmail
    // attachment must not double-insert. Partial index — rows
    // synthesised without a Gmail attachmentId (none today, but
    // T005 manual uploads might) are not constrained.
    uniqueIndex("email_attachments_msg_gmail_att_uq")
      .on(t.emailMessageId, t.gmailAttachmentId)
      .where(sql`${t.gmailAttachmentId} is not null`),
  ],
);

export type EmailAttachment = typeof emailAttachments.$inferSelect;
export type NewEmailAttachment = typeof emailAttachments.$inferInsert;
