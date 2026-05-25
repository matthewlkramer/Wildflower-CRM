import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { googleOauthTokens } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  getGoogleOauthConfig,
  revokeToken,
} from "../lib/googleOauth";
import {
  decryptSecret,
  encryptSecret,
  randomNonce,
  signPayload,
  verifyPayload,
} from "../lib/crypto";

const router: IRouter = Router();
router.use(requireAuth);

const STATE_COOKIE = "wf_google_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  userId: string;
  // random nonce so two starts in a row produce different states
  nonce: string;
  // millis-since-epoch the state was issued; we reject anything older
  // than STATE_TTL_MS
  iat: number;
  // path on the CRM to return the user to once the callback completes
  returnTo: string;
}

function makeState(userId: string, returnTo: string): string {
  const payload: StatePayload = {
    userId,
    nonce: randomNonce(),
    iat: Date.now(),
    returnTo,
  };
  return signPayload(JSON.stringify(payload));
}

function parseState(state: string | undefined): StatePayload | null {
  if (!state) return null;
  const raw = verifyPayload(state);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as StatePayload;
    if (Date.now() - p.iat > STATE_TTL_MS) return null;
    return p;
  } catch {
    return null;
  }
}

// Tiny cookie parser — we don't want to drag in cookie-parser just for
// this one route. Returns the first matching value or undefined.
function readCookie(req: { headers: { cookie?: string | undefined } }, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

// ─── GET /google-oauth/status ──────────────────────────────────────────────
// Tiny JSON shape consumed by the Settings UI to render the
// connect/disconnect block.
router.get(
  "/google-oauth/status",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const configured = getGoogleOauthConfig() !== null;
    const row = await db
      .select()
      .from(googleOauthTokens)
      .where(eq(googleOauthTokens.userId, user.id))
      .then((r) => r[0]);
    const connected = !!row && !!row.accessTokenEnc && !row.revokedAt;
    res.json({
      configured,
      connected,
      googleEmail: connected ? row?.googleEmail ?? null : null,
      scope: connected ? row?.scope ?? null : null,
      expiresAt: connected ? row?.expiresAt?.toISOString() ?? null : null,
      grantedAt: connected ? row?.grantedAt?.toISOString() ?? null : null,
      revokedAt: row?.revokedAt ? row.revokedAt.toISOString() : null,
      lastError: row?.lastError ?? null,
    });
  }),
);

// ─── GET /google-oauth/start ───────────────────────────────────────────────
// Browser navigation entry point. Signs a short-lived state, drops it
// in an httpOnly cookie, and 302s to Google.
router.get(
  "/google-oauth/start",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const cfg = getGoogleOauthConfig();
    if (!cfg) {
      res.status(503).json({
        error: "not_configured",
        message:
          "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set",
      });
      return;
    }
    const rawReturn = typeof req.query["returnTo"] === "string" ? req.query["returnTo"] : "/admin";
    // Only accept same-app relative paths to prevent open-redirect.
    const returnTo = rawReturn.startsWith("/") && !rawReturn.startsWith("//") ? rawReturn : "/admin";
    const state = makeState(user.id, returnTo);
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: STATE_TTL_MS,
      path: "/api/google-oauth",
    });
    res.redirect(buildAuthUrl(cfg, state));
  }),
);

// ─── GET /google-oauth/callback ────────────────────────────────────────────
// Google redirects the user's browser here. We verify state matches
// the cookie AND identifies the logged-in user, then exchange the code
// and persist encrypted tokens.
router.get(
  "/google-oauth/callback",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).send("Unauthorized");
      return;
    }
    const cfg = getGoogleOauthConfig();
    if (!cfg) {
      res.status(503).send("Google OAuth is not configured on this server.");
      return;
    }
    const queryState = typeof req.query["state"] === "string" ? req.query["state"] : undefined;
    const cookieState = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: "/api/google-oauth" });
    if (!queryState || !cookieState || queryState !== cookieState) {
      res.status(400).send("OAuth state mismatch. Please try connecting again.");
      return;
    }
    const parsed = parseState(queryState);
    if (!parsed || parsed.userId !== user.id) {
      res.status(400).send("OAuth state expired or does not match this account. Please try again.");
      return;
    }
    const err = typeof req.query["error"] === "string" ? req.query["error"] : undefined;
    if (err) {
      res.redirect(`${parsed.returnTo}?google_oauth=denied`);
      return;
    }
    const code = typeof req.query["code"] === "string" ? req.query["code"] : undefined;
    if (!code) {
      res.status(400).send("Missing authorization code.");
      return;
    }
    try {
      const tokens = await exchangeCodeForTokens(cfg, code);
      const info = await fetchUserInfo(tokens.accessToken);
      const now = new Date();
      // INSERT … ON CONFLICT lets the user reconnect into the same
      // row. Crucially: if Google omits a refresh_token on a re-grant
      // (it sometimes does, despite prompt=consent), we keep whatever
      // refresh token we already had.
      await db
        .insert(googleOauthTokens)
        .values({
          userId: user.id,
          googleEmail: info.email,
          accessTokenEnc: encryptSecret(tokens.accessToken),
          refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
          scope: tokens.scope,
          expiresAt: tokens.expiresAt,
          grantedAt: now,
          revokedAt: null,
          lastError: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: googleOauthTokens.userId,
          set: {
            googleEmail: info.email,
            accessTokenEnc: encryptSecret(tokens.accessToken),
            ...(tokens.refreshToken
              ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) }
              : {}),
            scope: tokens.scope,
            expiresAt: tokens.expiresAt,
            grantedAt: now,
            revokedAt: null,
            lastError: null,
            updatedAt: now,
          },
        });
      res.redirect(`${parsed.returnTo}?google_oauth=connected`);
    } catch (e) {
      req.log?.error({ err: e }, "Google OAuth callback failed");
      res
        .status(500)
        .send("Failed to complete Google sign-in. Please try again.");
    }
  }),
);

// ─── POST /google-oauth/disconnect ─────────────────────────────────────────
// Best-effort upstream revoke + local soft-clear. We keep the row so
// the UI can show "Disconnected on …"; reconnecting overwrites it.
router.post(
  "/google-oauth/disconnect",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const row = await db
      .select()
      .from(googleOauthTokens)
      .where(eq(googleOauthTokens.userId, user.id))
      .then((r) => r[0]);
    if (row?.refreshTokenEnc) {
      try {
        await revokeToken(decryptSecret(row.refreshTokenEnc));
      } catch (e) {
        req.log?.warn({ err: e }, "Upstream Google revoke failed; clearing local grant anyway");
      }
    } else if (row?.accessTokenEnc) {
      try {
        await revokeToken(decryptSecret(row.accessTokenEnc));
      } catch (e) {
        req.log?.warn({ err: e }, "Upstream Google revoke failed; clearing local grant anyway");
      }
    }
    const now = new Date();
    await db
      .update(googleOauthTokens)
      .set({
        accessTokenEnc: null,
        refreshTokenEnc: null,
        scope: null,
        expiresAt: null,
        revokedAt: now,
        updatedAt: now,
      })
      .where(eq(googleOauthTokens.userId, user.id));
    res.json({ ok: true });
  }),
);

export default router;
