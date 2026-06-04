import { db } from "@workspace/db";
import { quickbooksConnections } from "@workspace/db/schema";
import { desc, eq, isNull } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./crypto";
import {
  getQuickbooksOauthConfig,
  refreshAccessToken,
} from "./quickbooksOauth";

/**
 * Single source of truth for "give me a working QuickBooks access token
 * for the connected company, refreshing if needed". The sync worker and
 * the manual-sync route both call this — they never poke the
 * `quickbooks_connections` row directly.
 *
 * QuickBooks is org-wide (one company), so unlike the Google store there
 * is no userId argument: we resolve the single active connection (latest
 * granted, not revoked).
 *
 * Behavior mirrors googleTokenStore:
 *   - Returns null when there is no active connection.
 *   - Cached access token with >60s left → returned as-is.
 *   - Otherwise refresh, persist (encrypted, including the rotated
 *     refresh token), and return.
 *   - On refresh failure record `lastError` and re-throw.
 */

export interface ActiveQuickbooksConnection {
  realmId: string;
  companyName: string | null;
  accessToken: string;
  expiresAt: Date;
}

const REFRESH_MARGIN_MS = 60 * 1000;

/** Resolve the single active (granted, non-revoked) connection row. */
export async function getActiveQuickbooksConnectionRow() {
  return db
    .select()
    .from(quickbooksConnections)
    .where(isNull(quickbooksConnections.revokedAt))
    .orderBy(desc(quickbooksConnections.grantedAt))
    .then((r) => r[0] ?? null);
}

export async function getValidQuickbooksAccessToken(): Promise<ActiveQuickbooksConnection | null> {
  const row = await getActiveQuickbooksConnectionRow();
  if (!row || !row.accessTokenEnc || !row.refreshTokenEnc || row.revokedAt) {
    return null;
  }

  // Cached + still fresh — no network call.
  if (
    row.expiresAt &&
    row.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS
  ) {
    return {
      realmId: row.realmId,
      companyName: row.companyName,
      accessToken: decryptSecret(row.accessTokenEnc),
      expiresAt: row.expiresAt,
    };
  }

  const cfg = getQuickbooksOauthConfig();
  if (!cfg) {
    throw new Error(
      "QuickBooks OAuth not configured on server; cannot refresh access token",
    );
  }
  const refreshToken = decryptSecret(row.refreshTokenEnc);
  try {
    const result = await refreshAccessToken(cfg, refreshToken);
    const now = new Date();
    await db
      .update(quickbooksConnections)
      .set({
        accessTokenEnc: encryptSecret(result.accessToken),
        refreshTokenEnc: encryptSecret(result.refreshToken),
        expiresAt: result.expiresAt,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(quickbooksConnections.realmId, row.realmId));
    return {
      realmId: row.realmId,
      companyName: row.companyName,
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(quickbooksConnections)
      .set({ lastError: msg, updatedAt: new Date() })
      .where(eq(quickbooksConnections.realmId, row.realmId));
    throw e;
  }
}
