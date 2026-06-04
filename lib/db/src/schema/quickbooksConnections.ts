import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * QuickBooks Online company connections. Unlike the per-user Google grant,
 * a QuickBooks connection is org-wide: an admin links ONE QuickBooks
 * company (realm) and the whole CRM pulls incoming-money records from it.
 *
 * Keyed by `realmId` (the QuickBooks company id). Reconnecting the same
 * company reuses the row via INSERT … ON CONFLICT; connecting a different
 * company inserts a new row. The "active" connection is the most-recently
 * granted, non-revoked row.
 *
 * Tokens are stored encrypted-at-rest (AES-256-GCM keyed off
 * SESSION_SECRET); the `*Enc` columns hold the base64-encoded
 * (iv || tag || ciphertext) blob. We keep a row after revoke (revokedAt
 * set) so the settings page can show "last disconnected".
 */
export const quickbooksConnections = pgTable("quickbooks_connections", {
  // QuickBooks company (realm) id — PK so reconnects upsert cleanly.
  realmId: text("realm_id").primaryKey(),
  // Display name of the connected QuickBooks company, fetched from the
  // CompanyInfo endpoint at connect time.
  companyName: text("company_name"),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  scope: text("scope"),
  // When the current access token expires (used to refresh pre-emptively).
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  grantedAt: timestamp("granted_at", { withTimezone: true }),
  // Non-null = disconnected (by admin or upstream). Kept for display.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // The admin who established this connection (display / audit only).
  connectedByUserId: text("connected_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  // Incremental-pull watermark: the QuickBooks server time of the last
  // successful sync. Subsequent syncs query for entities updated on/after
  // this time. Null = full initial pull.
  syncWatermark: timestamp("sync_watermark", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  // Last sync/refresh error surfaced by the worker, for the settings UI.
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type QuickbooksConnection = typeof quickbooksConnections.$inferSelect;
export type NewQuickbooksConnection = typeof quickbooksConnections.$inferInsert;
