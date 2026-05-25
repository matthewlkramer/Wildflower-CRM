import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * "We already looked at this Gmail message and it didn't match any
 * current CRM contact." We deliberately do NOT store body or
 * attachments for these — only enough header data to retroactively
 * detect a match if someone later adds a new CRM person whose email
 * appears in this skipped message's participants.
 *
 * Stored per row:
 *   - `(mailbox_user_id, gmail_message_id)` PK
 *   - `from_addrs / to_addrs / cc_addrs / bcc_addrs` (lowercased,
 *      parsed from the metadata-format headers)
 *   - `subject` and `sent_at` for display in any "re-match candidates"
 *      UI we build later
 *
 * A combined GIN index covers all four address arrays so a query like
 *   WHERE 'newperson@x.com' = ANY(from_addrs)
 *      OR 'newperson@x.com' = ANY(to_addrs)  ... etc
 * can use the index instead of a sequential scan over what will grow
 * to many thousands of rows per mailbox once full-history bootstrap
 * runs.
 *
 * The Gmail message ID is per-mailbox-unique, so the same id can
 * legitimately appear under different mailbox_user_ids — hence the
 * composite PK.
 */
export const emailSyncSkip = pgTable(
  "email_sync_skip",
  {
    mailboxUserId: text("mailbox_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gmailMessageId: text("gmail_message_id").notNull(),
    fromAddrs: text("from_addrs")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    toAddrs: text("to_addrs")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ccAddrs: text("cc_addrs")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    bccAddrs: text("bcc_addrs")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text("subject"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: "email_sync_skip_pk",
      columns: [t.mailboxUserId, t.gmailMessageId],
    }),
    index("email_sync_skip_addrs_gin")
      .using("gin", t.fromAddrs, t.toAddrs, t.ccAddrs, t.bccAddrs),
  ],
);

export type EmailSyncSkip = typeof emailSyncSkip.$inferSelect;
export type NewEmailSyncSkip = typeof emailSyncSkip.$inferInsert;
