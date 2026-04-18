import { pgTable, text, timestamp, boolean, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { users } from "./users";

export const tagEntityTypeEnum = pgEnum("tag_entity_type", [
  "individual",
  "household",
  "funding_entity",
  "organization",
  "opportunity",
  "gift",
  "move",
]);

export const tags = pgTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  category: text("category"),
  color: text("color"),
  isSystem: boolean("is_system").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tagLinks = pgTable(
  "tag_links",
  {
    id: text("id").primaryKey(),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    entityType: tagEntityTypeEnum("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    uniqueLink: uniqueIndex("tag_links_unique").on(
      table.tagId,
      table.entityType,
      table.entityId,
    ),
    entityIdx: index("tag_links_entity_idx").on(table.entityType, table.entityId),
  }),
);

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type TagLink = typeof tagLinks.$inferSelect;
export type NewTagLink = typeof tagLinks.$inferInsert;
