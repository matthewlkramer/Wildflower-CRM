import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  calendarSyncState,
  emailSyncState,
  googleOauthTokens,
  users,
} from "@workspace/db/schema";
import { asc, eq, isNull } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, paramId } from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import { syncUserGmail } from "../lib/gmailSync";
import { syncUserCalendar } from "../lib/calendarSync";
import { withSyncLock } from "../lib/syncLock";

/**
 * Admin-only sync visibility + manual resync. Surfaces per-user Gmail
 * + Calendar health: last sync time, last error, bootstrap progress.
 * The "Resync now" button hits POST /admin/google-sync/:userId — same
 * code path as the scheduler, just on demand.
 */
const router: IRouter = Router();
router.use(requireAuth);

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

router.get(
  "/admin/google-sync",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // One row per connected user. Archived users are excluded — once
    // archived they can't log in, so their sync state is academic.
    const rows = await db
      .select({
        userId: users.id,
        userEmail: users.email,
        googleEmail: googleOauthTokens.googleEmail,
        grantedAt: googleOauthTokens.grantedAt,
        revokedAt: googleOauthTokens.revokedAt,
        tokenLastError: googleOauthTokens.lastError,
        gmailLastSyncedAt: emailSyncState.lastSyncedAt,
        gmailLastError: emailSyncState.lastError,
        gmailBootstrapCompletedAt: emailSyncState.bootstrapCompletedAt,
        gmailBootstrapPageToken: emailSyncState.bootstrapPageToken,
        calendarLastSyncedAt: calendarSyncState.lastSyncedAt,
        calendarLastError: calendarSyncState.lastError,
        calendarBootstrapCompletedAt: calendarSyncState.bootstrapCompletedAt,
        calendarBootstrapPageToken: calendarSyncState.bootstrapPageToken,
      })
      .from(googleOauthTokens)
      .innerJoin(users, eq(users.id, googleOauthTokens.userId))
      .leftJoin(
        emailSyncState,
        eq(emailSyncState.mailboxUserId, googleOauthTokens.userId),
      )
      .leftJoin(
        calendarSyncState,
        eq(calendarSyncState.calendarUserId, googleOauthTokens.userId),
      )
      .where(isNull(users.archivedAt))
      .orderBy(asc(users.email));

    res.json({
      data: rows.map((r) => ({
        userId: r.userId,
        userEmail: r.userEmail,
        googleEmail: r.googleEmail,
        connected: !r.revokedAt,
        grantedAt: r.grantedAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        tokenLastError: r.tokenLastError,
        gmail: {
          lastSyncedAt: r.gmailLastSyncedAt?.toISOString() ?? null,
          lastError: r.gmailLastError,
          bootstrapCompletedAt:
            r.gmailBootstrapCompletedAt?.toISOString() ?? null,
          bootstrapInProgress:
            !r.gmailBootstrapCompletedAt && !!r.gmailBootstrapPageToken,
        },
        calendar: {
          lastSyncedAt: r.calendarLastSyncedAt?.toISOString() ?? null,
          lastError: r.calendarLastError,
          bootstrapCompletedAt:
            r.calendarBootstrapCompletedAt?.toISOString() ?? null,
          bootstrapInProgress:
            !r.calendarBootstrapCompletedAt && !!r.calendarBootstrapPageToken,
        },
      })),
    });
  }),
);

router.post(
  "/admin/google-sync/:id/resync",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const targetUserId = paramId(req);
    // Verify the target actually has an active grant before hitting
    // Google — gives a clean 409 instead of a misleading "ok: false".
    const grant = await db
      .select({ revokedAt: googleOauthTokens.revokedAt })
      .from(googleOauthTokens)
      .where(eq(googleOauthTokens.userId, targetUserId))
      .then((r) => r[0]);
    if (!grant || grant.revokedAt) {
      res.status(409).json({
        error: "not_connected",
        message: "User has no active Google grant.",
      });
      return;
    }
    // Each source has its own lock so admin-triggered Gmail + Calendar
    // can still run in parallel, but won't collide with an in-flight
    // scheduler tick or a user-triggered sync on the same source.
    const [gmailLock, calLock] = await Promise.all([
      withSyncLock(targetUserId, "gmail", () => syncUserGmail(targetUserId)),
      withSyncLock(targetUserId, "calendar", () => syncUserCalendar(targetUserId)),
    ]);
    res.json({
      ok:
        (gmailLock.ran ? gmailLock.result!.ok : false) &&
        (calLock.ran ? calLock.result!.ok : false),
      gmail: gmailLock.ran
        ? gmailLock.result
        : { ok: false, error: "sync_in_progress" },
      calendar: calLock.ran
        ? calLock.result
        : { ok: false, error: "sync_in_progress" },
    });
  }),
);

export default router;
