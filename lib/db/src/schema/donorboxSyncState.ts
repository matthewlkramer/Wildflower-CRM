import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Singleton run-state for the Donorbox donation sync. There is exactly one row,
 * keyed by a fixed id (`SINGLETON`). A global pg advisory lock (not this row)
 * prevents concurrent/overlapping runs.
 *
 * Unlike Stripe's "ongoing-only" cursor, the first Donorbox run pulls the FULL
 * history: Stripe-type donations must enrich already-existing (historical) CRM
 * gifts, and non-Stripe donations are surfaced as new-money candidates. After
 * the first full pull, `donationCursor` advances to the newest donation seen and
 * each run re-pulls from `donationCursor` minus an overlap window so refunds /
 * edits on recent donations are picked up.
 */
export const donorboxSyncState = pgTable("donorbox_sync_state", {
  id: text("id").primaryKey(),

  // Newest donation_date ingested so far. Each run pulls donations dated at/after
  // (donationCursor − overlap window) and advances this to the max seen. Null
  // until the first successful run completes (⇒ a full historical pull).
  donationCursor: timestamp("donation_cursor", { withTimezone: true }),

  lastRunStartedAt: timestamp("last_run_started_at", { withTimezone: true }),
  lastRunFinishedAt: timestamp("last_run_finished_at", { withTimezone: true }),
  // "ok" | "error" | "running"
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  donationsUpserted: integer("donations_upserted"),
  // Consecutive errored runs (cursor held). Reset to 0 on a clean run.
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type DonorboxSyncState = typeof donorboxSyncState.$inferSelect;
export type NewDonorboxSyncState = typeof donorboxSyncState.$inferInsert;

/** The fixed primary key for the single sync-state row. */
export const DONORBOX_SYNC_STATE_ID = "singleton";
