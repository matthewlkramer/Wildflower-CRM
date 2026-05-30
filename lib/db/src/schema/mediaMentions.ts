import {
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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
    // News headline. Populated by the GDELT ingestion pipeline; optional
    // for manually-entered mentions.
    title: text("title"),
    author: text("author"),
    publicationDate: date("publication_date"),
    url: text("url").notNull(),
    aiSummary: text("ai_summary"),
    // Provenance of the row: "gdelt" for auto-ingested news, null/"manual"
    // for hand-entered mentions. Lets the UI/cleanup distinguish the two.
    source: text("source"),
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
    // URL is the dedupe key for the GDELT ingestion upsert. A unique index
    // lets the importer use `INSERT ... ON CONFLICT (url) DO UPDATE` so that
    // concurrent runs can't create duplicate rows or drop entity-link merges.
    // Manually-entered mentions always carry a url too (NOT NULL).
    uniqueIndex("media_mentions_url_uq").on(t.url),
  ],
);

export type MediaMention = typeof mediaMentions.$inferSelect;
export type NewMediaMention = typeof mediaMentions.$inferInsert;
