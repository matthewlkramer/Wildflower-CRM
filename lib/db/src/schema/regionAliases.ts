import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { regions } from "./regions";

/**
 * Alternate search names for a region ("NYC", "DC", "Twin Cities"). Matched
 * (case-insensitively) by the alias-aware region search alongside name,
 * display_path, and state_abbreviation. Structural link rows (like other pure
 * join tables): hard-deleted when an admin edits a region's alias set.
 */
export const regionAliases = pgTable(
  "region_aliases",
  {
    id: text("id").primaryKey(),
    // CASCADE: aliases have no life without their region.
    regionId: text("region_id")
      .notNull()
      .references(() => regions.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("region_aliases_region_alias_uq").on(
      t.regionId,
      sql`lower(${t.alias})`,
    ),
    index("region_aliases_alias_idx").on(sql`lower(${t.alias})`),
  ],
);

export type RegionAlias = typeof regionAliases.$inferSelect;
export type NewRegionAlias = typeof regionAliases.$inferInsert;
