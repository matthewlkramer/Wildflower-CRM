import {
  boolean,
  date,
  index,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Press / media coverage attached to one or more CRM entities. Mirrors the
 * `notes` denormalized link pattern: each linkable entity type gets its own
 * `text[]` array column with a GIN index so detail pages can filter cheaply
 * via `WHERE person_ids @> ARRAY[$1]`. A mention can reference individuals
 * (people) and/or organizations.
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
    // Tracking-free URL and normalized-headline digest used by the ingest
    // pipeline to collapse URL variants and same-day syndicated reposts.
    canonicalUrl: text("canonical_url"),
    // Deterministic 0..1 score assigned by ingestion/backfill. Null means the
    // historical row has not been evaluated yet.
    relevanceScore: real("relevance_score"),
    // Classification is stored independently from pinning. Readers always
    // surface pinned rows even when this remains true.
    isFiltered: boolean("is_filtered").notNull().default(false),
    headlineFingerprint: text("headline_fingerprint"),
    aiSummary: text("ai_summary"),
    // Provenance of the row: "gdelt" for auto-ingested news, null/"manual"
    // for hand-entered mentions. Lets the UI/cleanup distinguish the two.
    source: text("source"),
    pinned: boolean("pinned").notNull().default(false),
    // Soft-delete tombstone. "Deleting" a mention sets this true rather than
    // removing the row, so the URL stays on record as a dedupe key and a later
    // GDELT sweep can't re-insert/re-link the same article. Dismissed rows are
    // excluded from every list response. Dismissal is GLOBAL per article (per
    // url), not per linked entity — hiding a mention hides it everywhere.
    dismissed: boolean("dismissed").notNull().default(false),
    personIds: text("person_ids").array(),
    organizationIds: text("organization_ids").array(),
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
    index("media_mentions_canonical_url_idx").on(t.canonicalUrl),
    index("media_mentions_headline_fingerprint_idx").on(
      t.headlineFingerprint,
      t.publicationDate,
    ),
    index("media_mentions_pinned_idx").on(t.pinned),
    index("media_mentions_dismissed_idx").on(t.dismissed),
    index("media_mentions_is_filtered_idx").on(t.isFiltered),
    index("media_mentions_person_ids_gin_idx").using("gin", t.personIds),
    index("media_mentions_organization_ids_gin_idx").using("gin", t.organizationIds),
    // Raw URL uniqueness is the last-resort collision guard. Ingestion also
    // serializes canonical-URL and headline identities with advisory locks.
    // Manually-entered mentions always carry a URL too (NOT NULL).
    uniqueIndex("media_mentions_url_uq").on(t.url),
  ],
);

export type MediaMention = typeof mediaMentions.$inferSelect;
export type NewMediaMention = typeof mediaMentions.$inferInsert;
