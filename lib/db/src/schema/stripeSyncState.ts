import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

/**
 * Singleton-per-account cursor for the ongoing Stripe → CRM payout sync.
 *
 * Unlike QuickBooks (OAuth tokens in quickbooks_connections), Stripe
 * credentials are fetched fresh from the Replit connector proxy on every
 * call, so there is nothing secret to store here — only the sync cursor and
 * health. One row per Stripe account (settings.account_id), keyed by it.
 *
 * Ongoing-only first cut: `payoutCreatedWatermark` is seeded to the time the
 * sync is first enabled so the historical Stripe payout back-catalogue (which
 * QuickBooks already ingested as net lumps) is intentionally NOT reprocessed.
 * Each run pulls payouts with `created >= watermark` and advances it.
 */
export const stripeSyncState = pgTable("stripe_sync_state", {
  // The Stripe account this state tracks (connector settings.account_id).
  stripeAccountId: text("stripe_account_id").primaryKey(),

  // Only payouts created at/after this instant are pulled. Seeded on first
  // enable (ongoing-only); advanced as payouts are ingested (kept slightly
  // behind the newest seen payout to tolerate out-of-order arrival).
  payoutCreatedWatermark: timestamp("payout_created_watermark", {
    withTimezone: true,
  }),

  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  // "ok" | "error" — coarse health of the most recent run.
  lastRunStatus: text("last_run_status"),
  lastError: text("last_error"),
  // Consecutive errored runs (cursor held). Reset to 0 on a clean run; the
  // admin panel can flag a stuck sync once this crosses a threshold.
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type StripeSyncState = typeof stripeSyncState.$inferSelect;
export type NewStripeSyncState = typeof stripeSyncState.$inferInsert;
