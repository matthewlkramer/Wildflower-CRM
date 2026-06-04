import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { emailDirectionEnum } from "./_enums";

/**
 * A Gmail message that the sync worker decided was worth keeping
 * (i.e. at least one non-internal participant matched a person /
 * funder / household in the CRM). Messages that don't match end up in
 * `email_sync_skip` instead so we never re-fetch them.
 *
 * The PK is a synthetic nanoid rather than the Gmail message ID
 * because Gmail message IDs are unique per mailbox — two staff
 * members syncing the same conversation would otherwise collide.
 * `(mailbox_user_id, gmail_message_id)` is unique, which is the
 * upsert target.
 *
 * Match arrays are GIN-indexed so detail pages can do
 * `WHERE matched_person_ids @> ARRAY[$1]` cheaply — same pattern
 * the rest of the codebase uses (see `interactions`).
 *
 * Privacy: `is_private` defaults false (whole team sees the email
 * on detail pages). Only the mailbox owner can flip it true; once
 * private, only they see it. `private_set_by_user_id` records who
 * flipped it for audit.
 */
export const emailMessages = pgTable(
  "email_messages",
  {
    id: text("id").primaryKey(),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id"),
    mailboxUserId: text("mailbox_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    direction: emailDirectionEnum("direction").notNull(),
    // Gmail's internalDate (ms since epoch on Google's servers). This
    // is the timeline ordering key — we never re-key off the Date:
    // header since spam-era forwards lie about that.
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    subject: text("subject"),
    snippet: text("snippet"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    // One-line topic summary generated at sync time when the mailbox
    // owner's `email_sync_mode = 'summary_only'`. In that mode bodyText
    // / bodyHtml / snippet are all null and no attachments are stored;
    // this is the ONLY content anyone — including the owner — ever sees
    // for this message. Null when the owner is in `full` mode.
    aiSummary: text("ai_summary"),
    fromEmail: text("from_email"),
    toEmails: text("to_emails").array(),
    ccEmails: text("cc_emails").array(),
    bccEmails: text("bcc_emails").array(),
    hasAttachments: boolean("has_attachments").default(false).notNull(),
    // False if the message was stored but at least one of its
    // attachments failed to download or upload to GCS. The sync
    // worker uses this as the "needs retry" signal:
    // `filterUnseenIds` deliberately does NOT skip rows where
    // `attachments_complete = false`, so the next sync run will
    // re-enter `processOneMessage` and the (idempotent) attachment
    // loop tops up the missing rows. Flipped to true once every
    // attachment loop iteration succeeded.
    attachmentsComplete: boolean("attachments_complete")
      .default(true)
      .notNull(),
    isPrivate: boolean("is_private").default(false).notNull(),
    privateSetByUserId: text("private_set_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    matchedPersonIds: text("matched_person_ids").array(),
    matchedOrganizationIds: text("matched_organization_ids").array(),
    matchedHouseholdIds: text("matched_household_ids").array(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("email_messages_mailbox_gmail_id_uq").on(
      t.mailboxUserId,
      t.gmailMessageId,
    ),
    index("email_messages_thread_idx").on(t.gmailThreadId),
    index("email_messages_mailbox_sent_at_idx").on(t.mailboxUserId, t.sentAt),
    index("email_messages_matched_person_ids_idx")
      .using("gin", t.matchedPersonIds)
      .where(sql`${t.matchedPersonIds} is not null`),
    index("email_messages_matched_organization_ids_idx")
      .using("gin", t.matchedOrganizationIds)
      .where(sql`${t.matchedOrganizationIds} is not null`),
    index("email_messages_matched_household_ids_idx")
      .using("gin", t.matchedHouseholdIds)
      .where(sql`${t.matchedHouseholdIds} is not null`),
  ],
);

export type EmailMessage = typeof emailMessages.$inferSelect;
export type NewEmailMessage = typeof emailMessages.$inferInsert;
