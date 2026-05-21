import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type FundableProject = typeof fundableProjects.$inferSelect;
export type NewFundableProject = typeof fundableProjects.$inferInsert;
