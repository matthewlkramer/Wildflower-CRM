import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const schools = pgTable("schools", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type School = typeof schools.$inferSelect;
export type NewSchool = typeof schools.$inferInsert;
