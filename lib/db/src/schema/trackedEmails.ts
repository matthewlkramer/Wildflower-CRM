import {
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Email-tracking tables for the vendored Magio extension.
 *
 * When a CRM user clicks "Send" in Gmail with tracking enabled, the
 * extension POSTs the subject/recipient/sender here. We mint an id,
 * resolve the recipient address(es) against our `emails` table to
 * populate the three link arrays (person/funder/household), and the
 * extension injects a 1×1 pixel pointing at /api/email-tracking/track/{id}.gif
 * into the outbound email body.
 *
 * Authentication: this is intentionally unauthenticated on the write
 * path (the extension is end-user installed and Magio's upstream is
 * also open). The CRM-facing read paths use requireAuth.
 *
 * Privacy: per the user's call, recipients are NOT notified that the
 * email is tracked. The CRM operator is responsible for compliance.
 *
 * `recipient` is stored verbatim as the comma-separated string the
 * extension scraped from Gmail's compose UI, so detail UIs can show
 * "what was on the To: line". The split-and-matched ids live in the
 * three array columns and are queried with array operators.
 */
export const trackedEmails = pgTable(
  "tracked_emails",
  {
    id: text("id").primaryKey(),
    subject: text("subject").notNull(),
    recipient: text("recipient").notNull(),
    sender: text("sender").notNull(),
    senderIp: text("sender_ip"),
    // Per-recipient (Superhuman-style) sends create ONE row per recipient, all
    // sharing the same `group_id`, so a single group email yields a distinct
    // pixel (= row id) per recipient and we can attribute opens to a specific
    // person. Null for legacy single-pixel sends registered via POST
    // /email-tracking (one row, `recipient` = the whole comma-separated To line).
    groupId: text("group_id"),
    // Gmail message + thread ids returned by users.messages.send for this
    // recipient's copy. Null on the legacy register path (the extension lets
    // Gmail send and we never see the ids). threadId is shared across a group so
    // the sender's Sent folder collapses the copies into one conversation.
    gmailMessageId: text("gmail_message_id"),
    gmailThreadId: text("gmail_thread_id"),
    recipientPersonIds: text("recipient_person_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    recipientOrganizationIds: text("recipient_organization_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    recipientHouseholdIds: text("recipient_household_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("tracked_emails_subject_idx").on(t.subject),
    index("tracked_emails_sender_idx").on(t.sender),
    index("tracked_emails_created_at_idx").on(t.createdAt),
    index("tracked_emails_group_id_idx").on(t.groupId),
    // GIN indexes for the linked-contact arrays — queried with array
    // operators (@>, &&) on contact-detail pages.
    index("tracked_emails_recipient_person_ids_gin")
      .using("gin", t.recipientPersonIds),
    index("tracked_emails_recipient_organization_ids_gin")
      .using("gin", t.recipientOrganizationIds),
    index("tracked_emails_recipient_household_ids_gin")
      .using("gin", t.recipientHouseholdIds),
  ],
);

export const trackedEmailViews = pgTable(
  "tracked_email_views",
  {
    id: text("id").primaryKey(),
    emailId: text("email_id")
      .notNull()
      .references(() => trackedEmails.id, { onDelete: "cascade" }),
    viewedAt: timestamp("viewed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("tracked_email_views_email_id_viewed_at_idx").on(
      t.emailId,
      t.viewedAt,
    ),
  ],
);

export type TrackedEmailRow = typeof trackedEmails.$inferSelect;
export type NewTrackedEmailRow = typeof trackedEmails.$inferInsert;
export type TrackedEmailViewRow = typeof trackedEmailViews.$inferSelect;
export type NewTrackedEmailViewRow = typeof trackedEmailViews.$inferInsert;
