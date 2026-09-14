import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { wildflowerUpdateSourceTypeEnum, wildflowerUpdateDatePrecisionEnum } from "./_enums";
import { wildflowerUpdateItems } from "./wildflowerUpdateItems";

export const wildflowerUpdateSources = pgTable(
  "wildflower_update_sources",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => wildflowerUpdateItems.id, { onDelete: "cascade" }),
    sourceType: wildflowerUpdateSourceTypeEnum("source_type").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    publicationDatePrecision: wildflowerUpdateDatePrecisionEnum(
      "publication_date_precision",
    )
      .notNull()
      .default("unknown"),
    publicationDate: date("publication_date"),
    publicationEndDate: date("publication_end_date"),
    publicationYear: integer("publication_year"),
    publicationMonth: integer("publication_month"),
    publicationStartYear: integer("publication_start_year"),
    publicationStartMonth: integer("publication_start_month"),
    publicationEndYear: integer("publication_end_year"),
    publicationEndMonth: integer("publication_end_month"),
    publicationSeason: text("publication_season"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("wildflower_update_sources_item_id_idx").on(t.itemId),
    uniqueIndex("wildflower_update_sources_item_url_uq").on(t.itemId, t.normalizedUrl),
  ],
);

export type WildflowerUpdateSource = typeof wildflowerUpdateSources.$inferSelect;
export type NewWildflowerUpdateSource = typeof wildflowerUpdateSources.$inferInsert;