import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Charter organizations that receive charter-designated money (e.g. the
// Minnesota charter, Aurora Colorado). Distinct from `schools` (individual
// Montessori school sites) and from `regions`: a charter is the chartered
// legal recipient a gift allocation can be earmarked for. Modeled as a table
// (not an enum) so new charters can be added without a schema migration —
// same convention as entities / fundable_projects (human-readable slug PK).
export const charters = pgTable("charters", {
  id: text("id").primaryKey(), // slug-style key, e.g. "minnesota"
  name: text("name").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Charter = typeof charters.$inferSelect;
export type NewCharter = typeof charters.$inferInsert;
