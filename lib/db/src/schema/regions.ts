import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { regionTypeEnum } from "./_enums";

export const regions = pgTable("regions", {
  id: text("id").primaryKey(),
  airtableId: text("airtable_id").unique(),
  name: text("name").notNull(),
  stateAbbreviation: text("state_abbreviation"),
  type: regionTypeEnum("type"),
  parentRegionId: text("parent_region_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Region = typeof regions.$inferSelect;
export type NewRegion = typeof regions.$inferInsert;
