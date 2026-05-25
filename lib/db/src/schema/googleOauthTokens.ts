import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Per-user Google OAuth grants. One row per CRM user — they own their
 * own Gmail / Calendar tokens. Tokens are stored encrypted-at-rest (AES-
 * 256-GCM keyed off SESSION_SECRET); the `*Enc` columns hold the
 * base64-encoded (iv || tag || ciphertext) blob.
 *
 * We keep a row around after revoke (revokedAt set) so we can show
 * "last disconnected" in the UI without recreating the row. Re-connect
 * reuses the row via INSERT … ON CONFLICT.
 */
export const googleOauthTokens = pgTable("google_oauth_tokens", {
  // user_id is PK — one Google grant per CRM user. Deleting a CRM user
  // cascades the grant; we never want a token row pointing at a missing
  // user.
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // Email of the connected Google account, for display ("Connected as
  // jane@…"). Always populated when accessTokenEnc is non-null.
  googleEmail: text("google_email"),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  scope: text("scope"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  grantedAt: timestamp("granted_at", { withTimezone: true }),
  // Non-null = the user (or upstream) revoked. We keep the row so the
  // settings page can show "Disconnected on <date>" until they reconnect.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // Last sync error surfaced by the worker (T006). Holding the column
  // here keeps everything user-scoped + Google-scoped in one place.
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type GoogleOauthToken = typeof googleOauthTokens.$inferSelect;
export type NewGoogleOauthToken = typeof googleOauthTokens.$inferInsert;
