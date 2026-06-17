import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { organizations } from "./organizations";
import { opportunitiesAndPledges } from "./opportunitiesAndPledges";
import { grantLeadStatusEnum } from "./_enums";

/**
 * Team-shared grant opportunity lead. Deduped across inboxes by a
 * per-opportunity dedupe key (URL host+path, or funder+deadline+title
 * hash). When the same grant announcement arrives in multiple team
 * members' inboxes, it produces ONE lead row here instead of a
 * per-mailbox email_proposals row.
 *
 * All source emails ("sightings") are tracked in grant_lead_sightings
 * as a child table so the UI can show "received by Alex, Sam +3" with
 * each source email linked.
 *
 * A lead lives here until it is either:
 *   - converted → a real opportunity is minted; status='converted',
 *     convertedOpportunityId set.
 *   - archived → dismissed for everyone; status='archived'.
 *
 * payload mirrors the grant_opportunity email_proposals payload shape
 * so existing extraction logic can write directly.
 */
export const grantLeads = pgTable(
  "grant_leads",
  {
    id: text("id").primaryKey(),
    // The dedupe key used by the extractor to collapse same-opportunity
    // signals from multiple inboxes into one lead.
    dedupeKey: text("dedupe_key").notNull(),
    status: grantLeadStatusEnum("status").default("new").notNull(),
    // Human-readable title of the grant opportunity.
    title: text("title").notNull(),
    // Name of the granting organization as parsed from the email. May
    // be null for anonymous/digest entries.
    funderName: text("funder_name"),
    // CRM organization match (optional, fuzzy). Reviewer can correct
    // this at conversion time by picking a different org.
    targetOrganizationId: text("target_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    deadline: text("deadline"),
    amount: text("amount"),
    url: text("url"),
    // Short excerpt from the source email body.
    snippet: text("snippet"),
    // Full extractor payload (same shape as email_proposals.payload for
    // grant_opportunity). Kept for provenance and future re-processing.
    payload: jsonb("payload").notNull().default({}),
    // Current owner / assignee. Set when someone claims the lead.
    assigneeUserId: text("assignee_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // When the lead was claimed (status flipped to 'claimed').
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // When the lead was converted (status flipped to 'converted').
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    convertedByUserId: text("converted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    convertedOpportunityId: text("converted_opportunity_id").references(
      () => opportunitiesAndPledges.id,
      { onDelete: "set null" },
    ),
    // When the lead was archived.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByUserId: text("archived_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // One active (non-archived, non-converted) lead per dedupe key.
    // Once a lead is resolved (archived or converted), the slot opens
    // up so a future identical signal can surface as a fresh lead.
    uniqueIndex("grant_leads_dedupe_active_uq")
      .on(t.dedupeKey)
      .where(sql`status NOT IN ('archived', 'converted')`),
    index("grant_leads_status_idx").on(t.status),
    index("grant_leads_assignee_user_id_idx").on(t.assigneeUserId),
    index("grant_leads_target_organization_id_idx").on(t.targetOrganizationId),
    index("grant_leads_created_at_idx").on(t.createdAt),
  ],
);

/**
 * One sighting row per (grant_lead, mailbox_user, gmail_message).
 * Records every inbox that received the same grant announcement so
 * the UI can show who received it and link to the source email.
 */
export const grantLeadSightings = pgTable(
  "grant_lead_sightings",
  {
    id: text("id").primaryKey(),
    grantLeadId: text("grant_lead_id")
      .notNull()
      .references(() => grantLeads.id, { onDelete: "cascade" }),
    // The team member whose inbox received this copy of the email.
    mailboxUserId: text("mailbox_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Gmail message ID (the raw Gmail id, not our email_messages PK)
    // — may be present even if the message isn't in email_messages yet.
    gmailMessageId: text("gmail_message_id"),
    // Our email_messages row id (nullable: may not be synced yet).
    emailMessageId: text("email_message_id"),
    // When the source email was sent (from the message's Date header).
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Prevent double-adding the same Gmail message for the same lead.
    uniqueIndex("grant_lead_sightings_lead_message_uq").on(
      t.grantLeadId,
      t.mailboxUserId,
      t.gmailMessageId,
    ),
    index("grant_lead_sightings_grant_lead_id_idx").on(t.grantLeadId),
    index("grant_lead_sightings_mailbox_user_id_idx").on(t.mailboxUserId),
  ],
);

export type GrantLead = typeof grantLeads.$inferSelect;
export type NewGrantLead = typeof grantLeads.$inferInsert;
export type GrantLeadSighting = typeof grantLeadSightings.$inferSelect;
export type NewGrantLeadSighting = typeof grantLeadSightings.$inferInsert;
