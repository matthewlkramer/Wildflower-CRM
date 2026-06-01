/**
 * Thin wrapper around Google's OAuth 2.0 endpoints. We deliberately
 * avoid the `googleapis` SDK here — all we need is the three HTTP
 * endpoints (auth, token, revoke) plus a userinfo lookup. Keeping it
 * to `fetch` keeps the server bundle small and makes the flow easy to
 * follow.
 *
 * Scopes requested:
 *   - openid, email — to identify which Google account was connected
 *   - gmail.readonly — for the Gmail sync worker (T003)
 *   - gmail.send — to send the per-recipient tracked copies (Superhuman-style
 *     per-recipient open tracking). Lets the server deliver one individualized
 *     copy per recipient through the user's own mailbox. Adding this scope means
 *     already-connected users must reconnect once to grant it; until they do,
 *     the send path returns a "reconnect Google" error and the extension falls
 *     back to the single-pixel path.
 *   - calendar.readonly — for the Calendar sync worker (T004)
 */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

/** The Gmail send scope — checked before attempting an API send. */
export const GMAIL_SEND_SCOPE =
  "https://www.googleapis.com/auth/gmail.send";

export interface GoogleOauthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Pull config from the environment. Returns null (rather than throws)
 * so callers can surface a "not configured" 503 instead of crashing
 * the request pipeline.
 */
export function getGoogleOauthConfig(): GoogleOauthConfig | null {
  const clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"];
  const clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return null;
  // Prefer an explicit override, then the published REPLIT_DOMAINS
  // (first one), then the dev domain. The chosen host MUST also be
  // registered as an authorized redirect URI in the Google Cloud
  // OAuth client — otherwise Google returns redirect_uri_mismatch.
  const override = process.env["GOOGLE_OAUTH_REDIRECT_URI"];
  if (override) return { clientId, clientSecret, redirectUri: override };
  const domains = (process.env["REPLIT_DOMAINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const dev = process.env["REPLIT_DEV_DOMAIN"];
  const host = domains[0] ?? dev;
  if (!host) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `https://${host}/api/google-oauth/callback`,
  };
}

export function buildAuthUrl(cfg: GoogleOauthConfig, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  // `offline` + `prompt=consent` is the only way to reliably get a
  // refresh_token back; Google omits it on subsequent grants otherwise.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  scope: string;
  expiresAt: Date;
}

export async function exchangeCodeForTokens(
  cfg: GoogleOauthConfig,
  code: string,
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token exchange failed: ${r.status} ${text}`);
  }
  const j = (await r.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? null,
    scope: j.scope,
    expiresAt: new Date(Date.now() + (j.expires_in - 30) * 1000),
  };
}

export interface UserInfo {
  email: string;
  sub: string;
}

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    throw new Error(`userinfo failed: ${r.status}`);
  }
  const j = (await r.json()) as { email: string; id: string };
  return { email: j.email, sub: j.id };
}

/**
 * Tell Google to drop a grant. We send the refresh token (if we have
 * one) — revoking a refresh token also invalidates the access tokens
 * it issued. Best-effort: callers should still wipe the row locally
 * even if the upstream revoke 4xxs (e.g. token already revoked).
 */
export async function revokeToken(token: string): Promise<void> {
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

export interface RefreshResult {
  accessToken: string;
  expiresAt: Date;
  // Google sometimes rotates the refresh token; if so we want to
  // persist the new one. Usually null.
  refreshToken: string | null;
  scope: string | null;
}

/**
 * Exchange a refresh token for a new access token. Throws on failure
 * — callers should catch and record `lastError` so the user sees the
 * problem in the admin panel.
 */
export async function refreshAccessToken(
  cfg: GoogleOauthConfig,
  refreshToken: string,
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token refresh failed: ${r.status} ${text}`);
  }
  const j = (await r.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  return {
    accessToken: j.access_token,
    expiresAt: new Date(Date.now() + (j.expires_in - 30) * 1000),
    refreshToken: j.refresh_token ?? null,
    scope: j.scope ?? null,
  };
}
