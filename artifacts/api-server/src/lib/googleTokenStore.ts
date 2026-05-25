import { db } from "@workspace/db";
import { googleOauthTokens } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";
import {
  getGoogleOauthConfig,
  refreshAccessToken,
} from "./googleOauth";

/**
 * Single source of truth for "give me a working Gmail / Calendar
 * access token for this CRM user, refreshing if needed". The Gmail
 * (T003) and Calendar (T004) sync workers both call this — they
 * should never poke at the `google_oauth_tokens` row directly.
 *
 * Behavior:
 *   - Returns null when the user has no active grant (never connected
 *     or disconnected) — workers should skip that user.
 *   - If the cached access token has >60s left, returns it.
 *   - Otherwise exchanges the refresh token for a fresh access token,
 *     persists it (encrypted), and returns it.
 *   - On refresh failure, records `lastError` on the row so it surfaces
 *     in the admin panel, then re-throws so the worker can log it too.
 *
 * Returning a small object instead of just the string also gives the
 * worker the connected email + scope, which is useful for participant-
 * matching ("don't match the mailbox owner against themselves") and
 * for skipping users whose scope was downgraded mid-flight.
 */

export interface ActiveGoogleGrant {
  userId: string;
  googleEmail: string;
  accessToken: string;
  scope: string;
  expiresAt: Date;
}

const REFRESH_MARGIN_MS = 60 * 1000;

export async function getValidGoogleAccessTokenForUser(
  userId: string,
): Promise<ActiveGoogleGrant | null> {
  const row = await db
    .select()
    .from(googleOauthTokens)
    .where(eq(googleOauthTokens.userId, userId))
    .then((r) => r[0]);
  if (
    !row ||
    !row.accessTokenEnc ||
    !row.refreshTokenEnc ||
    row.revokedAt ||
    !row.googleEmail
  ) {
    return null;
  }

  // Cached + still fresh — happy path, no network call.
  if (row.expiresAt && row.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
    return {
      userId,
      googleEmail: row.googleEmail,
      accessToken: decryptSecret(row.accessTokenEnc),
      scope: row.scope ?? "",
      expiresAt: row.expiresAt,
    };
  }

  // Needs a refresh.
  const cfg = getGoogleOauthConfig();
  if (!cfg) {
    throw new Error(
      "Google OAuth not configured on server; cannot refresh access token",
    );
  }
  const refreshToken = decryptSecret(row.refreshTokenEnc);
  try {
    const result = await refreshAccessToken(cfg, refreshToken);
    const now = new Date();
    await db
      .update(googleOauthTokens)
      .set({
        accessTokenEnc: encryptSecret(result.accessToken),
        ...(result.refreshToken
          ? { refreshTokenEnc: encryptSecret(result.refreshToken) }
          : {}),
        ...(result.scope ? { scope: result.scope } : {}),
        expiresAt: result.expiresAt,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(googleOauthTokens.userId, userId));
    return {
      userId,
      googleEmail: row.googleEmail,
      accessToken: result.accessToken,
      scope: result.scope ?? row.scope ?? "",
      expiresAt: result.expiresAt,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(googleOauthTokens)
      .set({ lastError: msg, updatedAt: new Date() })
      .where(eq(googleOauthTokens.userId, userId));
    throw e;
  }
}
