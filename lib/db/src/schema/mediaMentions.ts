import {
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Press / media coverage attached to one or more CRM entities. Mirrors the
 * `notes` denormalized link pattern: each linkable entity type gets its own
 * `text[]` array column with a GIN index so detail pages can filter cheaply
 * via `WHERE person_ids @> ARRAY[$1]`. A mention can reference individuals
 * (people) and/or funders.
 *
 * `pinned` lets a user surface a particular mention in a dedicated card on
 * the linked record's detail page. The table is populated separately (e.g.
 * an ingestion pipeline) — there is no author/user attribution here.
 */
export const mediaMentions = pgTable(
  "media_mentions",
  {
    id: text("id").primaryKey(),
    publicationName: text("publication_name").notNull(),
    author: text("author"),
    publicationDate: date("publication_date"),
    url: text("url").notNull(),
    aiSummary: text("ai_summary"),
    pinned: boolean("pinned").notNull().default(false),
    personIds: text("person_ids").array(),
    funderIds: text("funder_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("media_mentions_created_at_idx").on(t.createdAt),
    index("media_mentions_publication_date_idx").on(t.publicationDate),
    index("media_mentions_pinned_idx").on(t.pinned),
    index("media_mentions_person_ids_gin_idx").using("gin", t.personIds),
    index("media_mentions_funder_ids_gin_idx").using("gin", t.funderIds),
  ],
);

export type MediaMention = typeof mediaMentions.$inferSelect;
export type NewMediaMention = typeof mediaMentions.$inferInsert;
