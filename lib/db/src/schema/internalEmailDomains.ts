import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Singleton configuration table for internal staff email domains.
 *
 * Always exactly one row with id = 'singleton'. The API GET endpoint
 * auto-inserts the seed domains if no row exists yet, so behavior is
 * unchanged on rollout.
 *
 * Addresses on any of these domains are dropped by the Gmail + Calendar
 * sync matcher (see `normalizeForMatching` in the api-server emailMatcher)
 * so internal staff-to-staff threads never pollute donor timelines.
 *
 * Fields:
 *   domains — lowercase bare domains (no leading "@"), e.g.
 *             ["wildflowerschools.org", "blackwildflowers.org"]. Admins
 *             add / remove entries from the Admin screen.
 */
export const internalEmailDomains = pgTable("internal_email_domains", {
  id: text("id").primaryKey().default("singleton"),
  domains: text("domains")
    .array()
    .notNull()
    .default(
      sql`ARRAY['wildflowerschools.org','blackwildflowers.org']::text[]`,
    ),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type InternalEmailDomains = typeof internalEmailDomains.$inferSelect;
export type NewInternalEmailDomains = typeof internalEmailDomains.$inferInsert;
