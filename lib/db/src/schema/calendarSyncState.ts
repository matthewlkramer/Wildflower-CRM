import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Per-calendar sync bookkeeping. One row per (user, calendar) pair.
 *
 * Google Calendar's incremental model is simpler than Gmail's: every
 * `events.list` response includes a `nextSyncToken`. We pass that
 * back on the next call to get only the changes since. If Google
 * decides the token is too old it returns 410 GONE — our client
 * surfaces that as `CalendarSyncTokenGoneError`, the orchestrator
 * drops the token and re-bootstraps on the next run.
 *
 *  - `bootstrap_completed_at` set once the initial `timeMin=30d ago`
 *    backfill drains. Before that we're in bootstrap mode, paging
 *    through pages with `pageToken` and stashing the next one in
 *    `bootstrap_page_token` if we hit the per-run page cap.
 *  - `sync_token` is Google's incremental cursor, written only when
 *    a full pagination drain completes with zero per-event errors.
 *    Same gating rationale as Gmail's `last_history_id`: don't
 *    advance past failed work.
 *  - `incremental_page_token` lets us resume a multi-page
 *    incremental run that hit the per-run page cap, exactly like
 *    Gmail's incremental_page_token.
 *  - `last_error` is the most-recent failure message; cleared on a
 *    clean run.
 *
 * MVP scope: we only sync the user's `primary` calendar. The
 * `gcal_calendar_id` column is denormalised here (it's "primary"
 * until/unless we add multi-calendar support) so the schema doesn't
 * have to migrate when we do.
 */
export const calendarSyncState = pgTable("calendar_sync_state", {
  calendarUserId: text("calendar_user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  gcalCalendarId: text("gcal_calendar_id").notNull().default("primary"),
  syncToken: text("sync_token"),
  bootstrapCompletedAt: timestamp("bootstrap_completed_at", {
    withTimezone: true,
  }),
  bootstrapPageToken: text("bootstrap_page_token"),
  incrementalPageToken: text("incremental_page_token"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type CalendarSyncState = typeof calendarSyncState.$inferSelect;
export type NewCalendarSyncState = typeof calendarSyncState.$inferInsert;
