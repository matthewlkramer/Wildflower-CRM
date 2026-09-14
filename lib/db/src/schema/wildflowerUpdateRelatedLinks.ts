import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { wildflowerUpdateItems } from "./wildflowerUpdateItems";

export const wildflowerUpdateRelatedLinks = pgTable(
  "wildflower_update_related_links",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => wildflowerUpdateItems.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("wildflower_update_related_links_item_id_idx").on(t.itemId),
    uniqueIndex("wildflower_update_related_links_item_url_uq").on(t.itemId, t.normalizedUrl),
  ],
);

export type WildflowerUpdateRelatedLink = typeof wildflowerUpdateRelatedLinks.$inferSelect;
export type NewWildflowerUpdateRelatedLink = typeof wildflowerUpdateRelatedLinks.$inferInsert;