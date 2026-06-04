import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Singleton run-state for the Flodesk subscriber-sync job. There is exactly
 * one row, keyed by a fixed id (`SINGLETON`). The in-process scheduler reads
 * `lastRunFinishedAt` to decide whether a daily reconcile is due, and writes
 * back counts + status so the last run is observable without trawling logs. A
 * global pg advisory lock (not this row) is what prevents concurrent/overlapping
 * runs.
 *
 * This tracks the INBOUND reconcile only (Flodesk → CRM unsubscribes). Outbound
 * member pushes (CRM → Flodesk) happen inline on person create/update and are
 * not journaled here. `pullCursor` is an opaque resume hint for paginating the
 * Flodesk subscriber list across runs (nullable; a fresh full scan when null).
 */
export const flodeskSyncState = pgTable("flodesk_sync_state", {
  id: text("id").primaryKey(),
  lastRunStartedAt: timestamp("last_run_started_at", { withTimezone: true }),
  lastRunFinishedAt: timestamp("last_run_finished_at", { withTimezone: true }),
  // "ok" | "error" | "running"
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  // Opaque pagination cursor for resuming the subscriber scan across runs.
  pullCursor: text("pull_cursor"),
  subscribersChecked: integer("subscribers_checked"),
  unsubscribesApplied: integer("unsubscribes_applied"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type FlodeskSyncState = typeof flodeskSyncState.$inferSelect;
export type NewFlodeskSyncState = typeof flodeskSyncState.$inferInsert;

/** The fixed primary key for the single sync-state row. */
export const FLODESK_SYNC_STATE_ID = "singleton";
