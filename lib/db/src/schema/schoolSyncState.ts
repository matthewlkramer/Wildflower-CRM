import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Singleton run-state for the Airtable → schools sync job. There is exactly
 * one row, keyed by a fixed id (`singleton`). The in-process scheduler reads
 * `lastRunFinishedAt` to decide whether a daily sync is due, and writes back
 * counts + status so the last run is observable without trawling logs. A global
 * pg advisory lock (not this row) is what prevents concurrent/overlapping runs.
 *
 * One-way: Airtable is the source of truth, we mirror the Schools view into our
 * `schools` table (upsert by Airtable record id). The sync never deletes — it
 * counts schools that fell out of the source view in `staleInDb` so the
 * operator can reconcile gift-referencing rows by hand (the
 * gifts_and_payments.school_recipient_id FK is ON DELETE RESTRICT).
 */
export const schoolSyncState = pgTable("school_sync_state", {
  id: text("id").primaryKey(),
  lastRunStartedAt: timestamp("last_run_started_at", { withTimezone: true }),
  lastRunFinishedAt: timestamp("last_run_finished_at", { withTimezone: true }),
  // "ok" | "error" | "running"
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  // Records fetched from the Airtable Schools view in the last run.
  schoolsFetched: integer("schools_fetched"),
  // Rows inserted/updated in the `schools` table in the last run.
  schoolsUpserted: integer("schools_upserted"),
  // Schools present in our DB but absent from the source view (not deleted).
  staleInDb: integer("stale_in_db"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type SchoolSyncState = typeof schoolSyncState.$inferSelect;
export type NewSchoolSyncState = typeof schoolSyncState.$inferInsert;

/** The fixed primary key for the single sync-state row. */
export const SCHOOL_SYNC_STATE_ID = "singleton";
