import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const households = pgTable("households", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  name: text("name").notNull(), 
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  ADD A FIELD FOR CURRENT SO THAT WE CAN MARK HOUSEHOLDS THAT ARE DISSOLVED BY DEATH OR DIVORCE
});

export type Household = typeof households.$inferSelect;
export type NewHousehold = typeof households.$inferInsert;
