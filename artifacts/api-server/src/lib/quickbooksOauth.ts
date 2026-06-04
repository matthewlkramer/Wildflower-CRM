/**
 * Thin wrapper around Intuit's QuickBooks Online OAuth 2.0 endpoints.
 * Like the Google wrapper, we avoid the Intuit SDK and just hit the HTTP
 * endpoints (authorize, token, revoke) plus a CompanyInfo lookup. This
 * keeps the server bundle small and the flow easy to audit.
 *
 * QuickBooks specifics worth knowing:
 *   - The token endpoint uses HTTP Basic auth (client_id:client_secret),
 *     not body params, for the client credentials.
 *   - Refresh tokens ROTATE on every refresh and expire (~100 days), so
 *     persisting the returned refresh_token each time is mandatory.
 *   - The authorize redirect returns `realmId` (the company id) alongside
 *     `code` and `state`.
 *
 * Only one scope is needed for read-only accounting access:
 *   com.intuit.quickbooks.accounting
 */

export const QUICKBOOKS_SCOPE = "com.intuit.quickbooks.accounting";

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL =
  "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

export interface QuickbooksOauthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Production API base. The connect flow points the live app at the
 * production QuickBooks company; set QUICKBOOKS_API_BASE to the sandbox
 * host (https://sandbox-quickbooks.api.intuit.com) for sandbox testing.
 */
export function getQuickbooksApiBase(): string {
  return (
    process.env["QUICKBOOKS_API_BASE"] ?? "https://quickbooks.api.intuit.com"
  );
}

/**
 * Pull config from the environment. Returns null (rather than throws) so
 * callers can surface a "not configured" 503 instead of crashing.
 *
 * The chosen redirect URI MUST also be registered on the Intuit app or
 * Intuit returns redirect_uri mismatch. In production this resolves to
 * https://wfcrm.replit.app/api/quickbooks-oauth/callback.
 */
export function getQuickbooksOauthConfig(): QuickbooksOauthConfig | null {
  const clientId = process.env["QUICKBOOKS_CLIENT_ID"];
  const clientSecret = process.env["QUICKBOOKS_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return null;
  const override = process.env["QUICKBOOKS_OAUTH_REDIRECT_URI"];
  if (override) return { clientId, clientSecret, redirectUri: override };
  const domains = (process.env["REPLIT_DOMAINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const dev = process.env["REPLIT_DEV_DOMAIN"];
  const host = domains[0] ?? dev;
  if (!host) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `https://${host}/api/quickbooks-oauth/callback`,
  };
}

export function buildAuthUrl(
  cfg: QuickbooksOauthConfig,
  state: string,
): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", QUICKBOOKS_SCOPE);
  u.searchParams.set("state", state);
  return u.toString();
}

function basicAuthHeader(cfg: QuickbooksOauthConfig): string {
  const raw = `${cfg.clientId}:${cfg.clientSecret}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

export interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  scope: string | null;
  expiresAt: Date;
}

export async function exchangeCodeForTokens(
  cfg: QuickbooksOauthConfig,
  code: string,
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(cfg),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`QuickBooks token exchange failed: ${r.status} ${text}`);
  }
  const j = (await r.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    scope: j.scope ?? null,
    expiresAt: new Date(Date.now() + (j.expires_in - 30) * 1000),
  };
}

export interface RefreshResult {
  accessToken: string;
  // QuickBooks rotates the refresh token on every refresh — always persist.
  refreshToken: string;
  expiresAt: Date;
}

export async function refreshAccessToken(
  cfg: QuickbooksOauthConfig,
  refreshToken: string,
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(cfg),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`QuickBooks token refresh failed: ${r.status} ${text}`);
  }
  const j = (await r.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: new Date(Date.now() + (j.expires_in - 30) * 1000),
  };
}

/**
 * Best-effort revoke. Sends the refresh token; Intuit invalidates the
 * whole grant. Callers should still wipe the row locally regardless of
 * the upstream result.
 */
export async function revokeToken(
  cfg: QuickbooksOauthConfig,
  token: string,
): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(cfg),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ token }),
  });
}

/**
 * Fetch the connected company's display name. Used at connect time to
 * show "Connected to <Company>" in the settings UI.
 */
export async function fetchCompanyName(
  accessToken: string,
  realmId: string,
): Promise<string | null> {
  const url = `${getQuickbooksApiBase()}/v3/company/${encodeURIComponent(
    realmId,
  )}/companyinfo/${encodeURIComponent(realmId)}?minorversion=70`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) return null;
  const j = (await r.json()) as {
    CompanyInfo?: { CompanyName?: string; LegalName?: string };
  };
  return j.CompanyInfo?.CompanyName ?? j.CompanyInfo?.LegalName ?? null;
}
