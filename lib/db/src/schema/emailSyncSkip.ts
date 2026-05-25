import {
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * "We already looked at this Gmail message and it had no matches in
 * the CRM — don't waste a round-trip re-fetching it next sync." The
 * row is intentionally tiny: just the composite (mailbox_user_id,
 * gmail_message_id) PK and a created_at for housekeeping. We never
 * store body / metadata for unmatched messages, per the user's
 * decision to only keep contact-with-people content.
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: "email_sync_skip_pk",
      columns: [t.mailboxUserId, t.gmailMessageId],
    }),
  ],
);

export type EmailSyncSkip = typeof emailSyncSkip.$inferSelect;
export type NewEmailSyncSkip = typeof emailSyncSkip.$inferInsert;
