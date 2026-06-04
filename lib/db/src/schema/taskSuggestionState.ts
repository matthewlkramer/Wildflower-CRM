import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Singleton run-state for the automated task-intelligence sweeps (the
 * one-time backfill and the monthly off-hours refresh). There is exactly
 * one row, keyed by a fixed id (`SINGLETON`).
 *
 * The monthly scheduler reads `lastRunFinishedAt` to decide whether a
 * refresh is due (survives restarts), and both sweeps write back counts +
 * status so the last run is observable without trawling logs. A global pg
 * advisory lock (not this row) is what prevents concurrent/overlapping
 * runs. Signal-triggered regenerations are continuous (not "runs") and do
 * NOT touch this row.
 */
export const taskSuggestionState = pgTable("task_suggestion_state", {
  id: text("id").primaryKey(),
  // Which sweep last wrote this row: "backfill" | "monthly" | "manual".
  lastRunKind: text("last_run_kind"),
  lastRunStartedAt: timestamp("last_run_started_at", { withTimezone: true }),
  lastRunFinishedAt: timestamp("last_run_finished_at", { withTimezone: true }),
  // "ok" | "error" | "running"
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  entitiesProcessed: integer("entities_processed"),
  suggestionsGenerated: integer("suggestions_generated"),
  suggestionsRegenerated: integer("suggestions_regenerated"),
  suggestionsSkipped: integer("suggestions_skipped"),
  errors: integer("errors"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type TaskSuggestionState = typeof taskSuggestionState.$inferSelect;
export type NewTaskSuggestionState = typeof taskSuggestionState.$inferInsert;

/** The fixed primary key for the single task-suggestion run-state row. */
export const TASK_SUGGESTION_STATE_ID = "singleton";
