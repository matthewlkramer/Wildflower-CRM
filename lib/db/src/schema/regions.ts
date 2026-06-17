import { type AnyPgColumn, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
  // Soft-delete: non-null = archived (hidden from non-admins).
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("regions_parent_region_id_idx").on(t.parentRegionId),
  index("regions_archived_at_idx").on(t.archivedAt),
]);

export type Region = typeof regions.$inferSelect;
export type NewRegion = typeof regions.$inferInsert;
