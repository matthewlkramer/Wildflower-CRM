import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  wildflowerUpdateDatePrecisionEnum,
  wildflowerUpdatePreparationStatusEnum,
  wildflowerUpdateStatusEnum,
} from "./_enums";
import { users } from "./users";

/**
 * Dated, source-backed Wildflower news and progress. This is intentionally
 * separate from wildflower_updates, the existing singleton talking-points
 * note, which has different lifecycle and permissions.
 *
 * Date components are stored independently so a month, year, or season is
 * never silently converted to an invented exact date.
 */
export const wildflowerUpdateItems = pgTable(
  "wildflower_update_items",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    details: text("details").notNull(),
    qualification: text("qualification"),
    importKey: text("import_key"),
    datePrecision: wildflowerUpdateDatePrecisionEnum("date_precision")
      .notNull()
      .default("unknown"),
    eventStartDate: date("event_start_date"),
    eventEndDate: date("event_end_date"),
    eventYear: integer("event_year"),
    eventStartYear: integer("event_start_year"),
    eventStartMonth: integer("event_start_month"),
    eventEndYear: integer("event_end_year"),
    eventEndMonth: integer("event_end_month"),
    eventMonth: integer("event_month"),
    eventSeason: text("event_season"),
    status: wildflowerUpdateStatusEnum("status").notNull(),
    preparationStatus: wildflowerUpdatePreparationStatusEnum(
      "preparation_status",
    )
      .notNull()
      .default("eligible"),
    thematicTags: text("thematic_tags").array().notNull().default([]),
    ageTags: text("age_tags").array().notNull().default([]),
    governanceTags: text("governance_tags").array().notNull().default([]),
    fundingRegionIds: text("funding_region_ids").array().notNull().default([]),
    normalizedHeadline: text("normalized_headline").notNull(),
    eventDateKey: text("event_date_key").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByUserId: text("archived_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("wildflower_update_items_created_at_idx").on(t.createdAt),
    index("wildflower_update_items_event_start_date_idx").on(t.eventStartDate),
    index("wildflower_update_items_status_idx").on(t.status),
    index("wildflower_update_items_archived_at_idx").on(t.archivedAt),
    index("wildflower_update_items_thematic_tags_gin_idx").using("gin", t.thematicTags),
    index("wildflower_update_items_age_tags_gin_idx").using("gin", t.ageTags),
    index("wildflower_update_items_governance_tags_gin_idx").using("gin", t.governanceTags),
    index("wildflower_update_items_funding_region_ids_gin_idx").using("gin", t.fundingRegionIds),
    uniqueIndex("wildflower_update_items_identity_uq").on(
      t.normalizedHeadline,
      t.eventDateKey,
    ),
    uniqueIndex("wildflower_update_items_import_key_uq").on(t.importKey),
  ],
);

export type WildflowerUpdateItem = typeof wildflowerUpdateItems.$inferSelect;
export type NewWildflowerUpdateItem = typeof wildflowerUpdateItems.$inferInsert;