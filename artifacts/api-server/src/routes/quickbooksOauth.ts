import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { quickbooksConnections } from "@workspace/db/schema";
import { and, isNull, ne } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchCompanyName,
  getQuickbooksOauthConfig,
  revokeToken,
} from "../lib/quickbooksOauth";
import { getActiveQuickbooksConnectionRow } from "../lib/quickbooksTokenStore";
import {
  decryptSecret,
  encryptSecret,
  randomNonce,
  signPayload,
  verifyPayload,
} from "../lib/crypto";

/**
 * Admin-only QuickBooks Online OAuth flow. Org-wide: one admin connects a
 * single QuickBooks company and the whole CRM pulls from it. Mirrors the
 * Google OAuth route (signed state cookie + CSRF) but stores the grant in
 * `quickbooks_connections` keyed by realmId.
 */
const router: IRouter = Router();
router.use(requireAuth);

const STATE_COOKIE = "wf_quickbooks_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const COOKIE_PATH = "/api/quickbooks-oauth";

function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
): boolean {
  const me = getAppUser(req);
  if (!me || me.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

interface StatePayload {
  userId: string;
  nonce: string;
  iat: number;
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

function readCookie(
  req: { headers: { cookie?: string | undefined } },
  name: string,
): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

// ─── GET /quickbooks-oauth/status ──────────────────────────────────────────
router.get(
  "/quickbooks-oauth/status",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const configured = getQuickbooksOauthConfig() !== null;
    const row = await getActiveQuickbooksConnectionRow();
    const connected = !!row && !!row.accessTokenEnc && !row.revokedAt;
    res.json({
      configured,
      connected,
      realmId: connected ? row?.realmId ?? null : null,
      companyName: connected ? row?.companyName ?? null : null,
      grantedAt: connected ? row?.grantedAt?.toISOString() ?? null : null,
      lastSyncedAt: connected ? row?.lastSyncedAt?.toISOString() ?? null : null,
      revokedAt: row?.revokedAt ? row.revokedAt.toISOString() : null,
      lastError: row?.lastError ?? null,
    });
  }),
);

// ─── GET /quickbooks-oauth/start ───────────────────────────────────────────
router.get(
  "/quickbooks-oauth/start",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const user = getAppUser(req)!;
    const cfg = getQuickbooksOauthConfig();
    if (!cfg) {
      res.status(503).json({
        error: "not_configured",
        message:
          "QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET must be set",
      });
      return;
    }
    const rawReturn =
      typeof req.query["returnTo"] === "string"
        ? req.query["returnTo"]
        : "/settings";
    const returnTo =
      rawReturn.startsWith("/") && !rawReturn.startsWith("//")
        ? rawReturn
        : "/settings";
    const state = makeState(user.id, returnTo);
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: STATE_TTL_MS,
      path: COOKIE_PATH,
    });
    res.redirect(buildAuthUrl(cfg, state));
  }),
);

// ─── GET /quickbooks-oauth/callback ────────────────────────────────────────
router.get(
  "/quickbooks-oauth/callback",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user || user.role !== "admin") {
      res.status(403).send("Admin access required.");
      return;
    }
    const cfg = getQuickbooksOauthConfig();
    if (!cfg) {
      res
        .status(503)
        .send("QuickBooks OAuth is not configured on this server.");
      return;
    }
    const queryState =
      typeof req.query["state"] === "string" ? req.query["state"] : undefined;
    const cookieState = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: COOKIE_PATH });
    if (!queryState || !cookieState || queryState !== cookieState) {
      res
        .status(400)
        .send("OAuth state mismatch. Please try connecting again.");
      return;
    }
    const parsed = parseState(queryState);
    if (!parsed || parsed.userId !== user.id) {
      res
        .status(400)
        .send(
          "OAuth state expired or does not match this account. Please try again.",
        );
      return;
    }
    const err =
      typeof req.query["error"] === "string" ? req.query["error"] : undefined;
    if (err) {
      res.redirect(`${parsed.returnTo}?quickbooks_oauth=denied`);
      return;
    }
    const code =
      typeof req.query["code"] === "string" ? req.query["code"] : undefined;
    const realmId =
      typeof req.query["realmId"] === "string"
        ? req.query["realmId"]
        : undefined;
    if (!code || !realmId) {
      res.status(400).send("Missing authorization code or company id.");
      return;
    }
    try {
      const tokens = await exchangeCodeForTokens(cfg, code);
      let companyName: string | null = null;
      try {
        companyName = await fetchCompanyName(tokens.accessToken, realmId);
      } catch (e) {
        req.log?.warn({ err: e }, "QuickBooks company name lookup failed");
      }
      const now = new Date();
      await db
        .insert(quickbooksConnections)
        .values({
          realmId,
          companyName,
          accessTokenEnc: encryptSecret(tokens.accessToken),
          refreshTokenEnc: encryptSecret(tokens.refreshToken),
          scope: tokens.scope,
          expiresAt: tokens.expiresAt,
          grantedAt: now,
          revokedAt: null,
          connectedByUserId: user.id,
          lastError: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: quickbooksConnections.realmId,
          set: {
            companyName,
            accessTokenEnc: encryptSecret(tokens.accessToken),
            refreshTokenEnc: encryptSecret(tokens.refreshToken),
            scope: tokens.scope,
            expiresAt: tokens.expiresAt,
            grantedAt: now,
            revokedAt: null,
            connectedByUserId: user.id,
            lastError: null,
            updatedAt: now,
          },
        });
      // Enforce a single active company: revoke any other still-active
      // connection so connecting a new realm cannot leave a stale one that
      // could later resurface as "active" (and so disconnect is definitive).
      await db
        .update(quickbooksConnections)
        .set({
          accessTokenEnc: null,
          refreshTokenEnc: null,
          scope: null,
          expiresAt: null,
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            ne(quickbooksConnections.realmId, realmId),
            isNull(quickbooksConnections.revokedAt),
          ),
        );
      res.redirect(`${parsed.returnTo}?quickbooks_oauth=connected`);
    } catch (e) {
      req.log?.error({ err: e }, "QuickBooks OAuth callback failed");
      res
        .status(500)
        .send("Failed to connect QuickBooks. Please try again.");
    }
  }),
);

// ─── POST /quickbooks-oauth/disconnect ─────────────────────────────────────
router.post(
  "/quickbooks-oauth/disconnect",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const cfg = getQuickbooksOauthConfig();
    const row = await getActiveQuickbooksConnectionRow();
    if (row && cfg) {
      const token = row.refreshTokenEnc
        ? decryptSecret(row.refreshTokenEnc)
        : row.accessTokenEnc
          ? decryptSecret(row.accessTokenEnc)
          : null;
      if (token) {
        try {
          await revokeToken(cfg, token);
        } catch (e) {
          req.log?.warn(
            { err: e },
            "Upstream QuickBooks revoke failed; clearing local grant anyway",
          );
        }
      }
    }
    // Revoke ALL still-active rows (not just the latest), so disconnect is
    // definitive and an older non-revoked row can't silently become active.
    const now = new Date();
    await db
      .update(quickbooksConnections)
      .set({
        accessTokenEnc: null,
        refreshTokenEnc: null,
        scope: null,
        expiresAt: null,
        revokedAt: now,
        updatedAt: now,
      })
      .where(isNull(quickbooksConnections.revokedAt));
    res.json({ ok: true });
  }),
);

export default router;
