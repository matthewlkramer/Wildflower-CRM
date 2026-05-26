import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Per-mailbox sync bookkeeping. One row per connected user.
 *
 *  - `last_history_id` is Gmail's monotonic mailbox-level revision
 *    cursor. We pass it to `users.history.list` to get incremental
 *    deltas. Null = first sync hasn't happened yet (caller should run
 *    the bootstrap path).
 *  - `bootstrap_completed_at` marks the point at which the initial
 *    backfill of recent history finished. Until it's set the worker
 *    is in bootstrap mode and shouldn't trust last_history_id for
 *    delta sync.
 *  - `last_error` surfaces the most recent failure to the admin
 *    panel. Cleared on successful sync.
 */
export const emailSyncState = pgTable("email_sync_state", {
  mailboxUserId: text("mailbox_user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  lastHistoryId: text("last_history_id"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastError: text("last_error"),
  bootstrapCompletedAt: timestamp("bootstrap_completed_at", {
    withTimezone: true,
  }),
  // Resumable cursor for the initial backfill. Each scheduled run
  // processes a bounded number of messages and stashes Gmail's
  // nextPageToken here so the next run picks up where this one left
  // off. Null once bootstrap is complete (`bootstrap_completed_at`
  // is set in the same write).
  bootstrapPageToken: text("bootstrap_page_token"),
  // Same idea, but for the incremental `users.history.list` pass:
  // a single sync run caps the number of history pages it consumes
  // so a long-idle mailbox can't monopolise a worker tick. The
  // pending page token lives here until the next run drains the
  // remainder, at which point we clear it AND advance
  // `last_history_id` in the same write. Until we've fully drained,
  // `last_history_id` stays pinned so Gmail keeps replaying the
  // missed deltas — losing nothing.
  incrementalPageToken: text("incremental_page_token"),
  // Stamped by the one-shot email-intelligence backfill
  // (`backfillIntelForUser`) on successful completion. Null means the
  // backfill hasn't yet run against this mailbox's fully-synced
  // contents. The scheduler watches for `bootstrap_completed_at IS
  // NOT NULL AND backfill_completed_at IS NULL` and kicks off a
  // backfill once bootstrap finishes — so a freshly-connected
  // mailbox auto-sweeps detector/matcher additions over its full
  // history without manual intervention.
  backfillCompletedAt: timestamp("backfill_completed_at", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type EmailSyncState = typeof emailSyncState.$inferSelect;
export type NewEmailSyncState = typeof emailSyncState.$inferInsert;
