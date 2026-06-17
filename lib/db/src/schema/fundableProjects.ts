import { index, pgTable, text, timestamp, boolean, date, numeric } from "drizzle-orm/pg-core";

// Specific fundable projects (e.g. SSJ, MDD, Charter Growth). Referenced
// from opportunities_and_pledges / pledge_allocations / gifts_and_payments /
// gift_allocations via fundable_project_id when intended_usage = 'project'.
// Modeled as a table (not an enum) so new projects can be added through the
// UI without a schema migration.
export const fundableProjects = pgTable("fundable_projects", {
  id: text("id").primaryKey(), // slug-style key, e.g. "ssj"
  name: text("name").notNull(),
  description: text("description"),
  active: boolean("active").default(true).notNull(),
  // Planning timeframes + goal for the dedicated Fundable projects page.
  // fundraisingStart is conceptually required, but kept nullable so existing
  // rows (seeded before these columns existed) keep loading; the UI treats a
  // missing fundraisingStart/goal as "needs to be filled in".
  fundraisingStart: date("fundraising_start"),
  fundraisingEnd: date("fundraising_end"),
  spendingStart: date("spending_start"),
  spendingEnd: date("spending_end"),
  // Fundraising goal in dollars. Decimal string convention (numeric(14,2)),
  // mirroring fiscal_year_entity_goals.goalAmount.
  fundraisingGoal: numeric("fundraising_goal", { precision: 14, scale: 2 }),
  // Soft-delete: non-null = archived (hidden from non-admins). Separate from
  // the `active` flag, which is a real lifecycle status.
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("fundable_projects_archived_at_idx").on(t.archivedAt),
]);

export type FundableProject = typeof fundableProjects.$inferSelect;
export type NewFundableProject = typeof fundableProjects.$inferInsert;
