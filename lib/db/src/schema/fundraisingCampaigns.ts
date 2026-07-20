import {
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { restrictionAxisEnum } from "./_enums";
import { entities } from "./entities";

// First-class fundraising campaigns table. Each row represents a named
// campaign (typically a Donorbox campaign) that gifts can be attributed to.
// `slug` is the primary key — a stable, slug-style identifier derived from
// the campaign name (lowercase, punctuation stripped, spaces → hyphens).
// The companion plain-text `gifts_and_payments.fundraising_campaign` column
// is NOT replaced — it stays as provenance evidence; this table is the
// structured home for campaign metadata.
export const fundraisingCampaigns = pgTable("fundraising_campaigns", {
  // Slug-style PK: lowercase letters, digits, hyphens, e.g. "spring-2024".
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  // The Donorbox numeric campaign id (stored as text to avoid int overflow
  // and to match the source column type on donorbox_donations.campaign_id).
  donorboxCampaignId: text("donorbox_campaign_id"),
  // Date the campaign fundraising email was sent (used for grant-calendar
  // and timeline ordering). Nullable — not all campaigns are email-driven.
  emailSentAt: timestamp("email_sent_at"),
  // FK to entities.id — the fund entity this campaign raises for.
  entityId: text("entity_id").references(() => entities.id, {
    onDelete: "set null",
  }),
  // ── Restriction axes (mirrors gift_allocations restriction model) ────────
  // Three independent axes capturing the donor's restriction INTENT for gifts
  // coming through this campaign. Each is one of donor_restricted /
  // wf_restricted / unrestricted. Nullable = not specified / unknown.
  regionalRestriction: restrictionAxisEnum("regional_restriction"),
  usageRestriction: restrictionAxisEnum("usage_restriction"),
  timeRestriction: restrictionAxisEnum("time_restriction"),
  // Free-text restriction detail for each axis (the donor's own language).
  regionalRestrictionDetail: text("regional_restriction_detail"),
  usageRestrictionDetail: text("usage_restriction_detail"),
  timeRestrictionDetail: text("time_restriction_detail"),
  // Soft-delete: non-null = archived.
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("fundraising_campaigns_donorbox_campaign_id_idx").on(t.donorboxCampaignId),
  index("fundraising_campaigns_entity_id_idx").on(t.entityId),
  index("fundraising_campaigns_archived_at_idx").on(t.archivedAt),
]);

export type FundraisingCampaign = typeof fundraisingCampaigns.$inferSelect;
export type NewFundraisingCampaign = typeof fundraisingCampaigns.$inferInsert;
