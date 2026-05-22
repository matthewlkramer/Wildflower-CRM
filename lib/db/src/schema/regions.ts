import { type AnyPgColumn, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { regionTypeEnum } from "./_enums";

export const regions = pgTable("regions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  displayPath: text("display_path").notNull(),
  stateAbbreviation: text("state_abbreviation"),
  type: regionTypeEnum("type"),
  // Self-ref. SET NULL: removing a wrapper region (e.g. a multi-state aggregate)
  // shouldn't delete its descendants — they just lose the parent pointer.
  parentRegionId: text("parent_region_id").references(
    (): AnyPgColumn => regions.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Region = typeof regions.$inferSelect;
export type NewRegion = typeof regions.$inferInsert;
