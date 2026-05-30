import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Singleton run-state for the GDELT media-mention ingestion job. There is
 * exactly one row, keyed by a fixed id (`SINGLETON`). The in-process
 * scheduler reads `lastRunFinishedAt` to decide whether a daily run is due,
 * and writes back counts + status so the last run is observable without
 * trawling logs. A global pg advisory lock (not this row) is what prevents
 * concurrent/overlapping runs.
 */
export const mediaIngestState = pgTable("media_ingest_state", {
  id: text("id").primaryKey(),
  lastRunStartedAt: timestamp("last_run_started_at", { withTimezone: true }),
  lastRunFinishedAt: timestamp("last_run_finished_at", { withTimezone: true }),
  // "ok" | "error" | "running"
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  entitiesProcessed: integer("entities_processed"),
  mentionsCreated: integer("mentions_created"),
  mentionsLinked: integer("mentions_linked"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type MediaIngestState = typeof mediaIngestState.$inferSelect;
export type NewMediaIngestState = typeof mediaIngestState.$inferInsert;

/** The fixed primary key for the single ingest-state row. */
export const MEDIA_INGEST_STATE_ID = "singleton";
