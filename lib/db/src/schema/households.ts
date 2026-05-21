import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const households = pgTable("households", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  name: text("name").notNull(), 
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // TODO: add a "current" / active field so we can mark households that
  // have been dissolved by death or divorce.
});

export type Household = typeof households.$inferSelect;
export type NewHousehold = typeof households.$inferInsert;
