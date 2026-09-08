import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { emails } from "./emails";

/**
 * Source-evidence mirror of the addresses found in the imported Flodesk
 * workbook. Operational newsletter eligibility remains on `people.newsletter`
 * and `people.unsubscribed_to_newsletter`; this table preserves the import
 * evidence, including addresses that do not yet match a CRM record.
 */
export const newsletterContacts = pgTable(
  "newsletter_contacts",
  {
    normalizedEmail: text("normalized_email").primaryKey(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    emailId: text("email_id").references(() => emails.id, {
      onDelete: "set null",
    }),
    sourceCurrentSubscriber: boolean("source_current_subscriber")
      .default(false)
      .notNull(),
    sourceUnsubscribed: boolean("source_unsubscribed").default(false).notNull(),
    sourceBounced: boolean("source_bounced").default(false).notNull(),
    unsubscribeEvidence: text("unsubscribe_evidence").array(),
    bounceEvidence: text("bounce_evidence").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("newsletter_contacts_email_id_idx").on(t.emailId)],
);

/** One row per historical Flodesk newsletter. */
export const newsletterCampaigns = pgTable("newsletter_campaigns", {
  id: text("id").primaryKey(),
  subject: text("subject").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  sentTimeText: text("sent_time_text"),
  previewUrl: text("preview_url"),
  openRate: numeric("open_rate", { precision: 6, scale: 5 }),
  clickRate: numeric("click_rate", { precision: 6, scale: 5 }),
  sourceSheet: text("source_sheet").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Recipient-level evidence. The composite key makes workbook imports
 * idempotent while retaining unmatched addresses instead of manufacturing
 * duplicate CRM people.
 */
export const newsletterEngagement = pgTable(
  "newsletter_engagement",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => newsletterCampaigns.id, { onDelete: "cascade" }),
    normalizedEmail: text("normalized_email").notNull(),
    email: text("email").notNull(),
    emailId: text("email_id").references(() => emails.id, {
      onDelete: "set null",
    }),
    firstName: text("first_name"),
    lastName: text("last_name"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    opened: boolean("opened").default(false).notNull(),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    totalOpens: integer("total_opens").default(0).notNull(),
    clicked: boolean("clicked").default(false).notNull(),
    lastClickedAt: timestamp("last_clicked_at", { withTimezone: true }),
    totalClicks: integer("total_clicks").default(0).notNull(),
    clickedLinks: text("clicked_links")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({
      name: "newsletter_engagement_pk",
      columns: [t.campaignId, t.normalizedEmail],
    }),
    index("newsletter_engagement_email_id_idx").on(t.emailId),
    index("newsletter_engagement_campaign_opened_idx").on(
      t.campaignId,
      t.opened,
    ),
    index("newsletter_engagement_campaign_clicked_idx").on(
      t.campaignId,
      t.clicked,
    ),
  ],
);

export type NewsletterContact = typeof newsletterContacts.$inferSelect;
export type NewsletterCampaign = typeof newsletterCampaigns.$inferSelect;
export type NewsletterEngagement = typeof newsletterEngagement.$inferSelect;
