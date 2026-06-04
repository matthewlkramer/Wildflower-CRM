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
import { syncUserGmail, STUCK_NO_PROGRESS_THRESHOLD } from "../lib/gmailSync";
import { syncUserCalendar } from "../lib/calendarSync";
import { withSyncLock } from "../lib/syncLock";
import { backfillIntelForUser } from "../lib/gmailBackfill";
import { analyzePendingForUser } from "../lib/analyzePending";
import { logger } from "../lib/logger";

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
        gmailNoProgressRuns: emailSyncState.noProgressRuns,
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
          noProgressRuns: r.gmailNoProgressRuns ?? 0,
          // "Stuck" = the mailbox's cursor has been pinned by errors for
          // STUCK_NO_PROGRESS_THRESHOLD consecutive runs. Quiet idle
          // mailboxes reset the counter every clean run, so this never
          // false-positives on an inbox that simply has no new mail.
          stuck: (r.gmailNoProgressRuns ?? 0) >= STUCK_NO_PROGRESS_THRESHOLD,
        },
        calendar: {
          lastSyncedAt: r.calendarLastSyncedAt?.toISOString() ?? null,
          lastError: r.calendarLastError,
          bootstrapCompletedAt:
            r.calendarBootstrapCompletedAt?.toISOString() ?? null,
          bootstrapInProgress:
            !r.calendarBootstrapCompletedAt && !!r.calendarBootstrapPageToken,
          // Calendar sync doesn't track no-progress runs yet; report the
          // shared shape as healthy so the admin panel stays consistent.
          noProgressRuns: 0,
          stuck: false,
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

/**
 * One-time backfill: re-run email-domain matching + email-intelligence
 * detectors over messages already synced. Useful after adding new
 * detectors (e.g. grant_opportunity) or after expanding the CRM
 * person/funder set — historical messages don't pick up new
 * capabilities through the normal incremental sync loop because the
 * Gmail history cursor has moved past them.
 *
 * Fire-and-forget: the backfill on a 10k+ mailbox can take many
 * minutes. We respond 202 immediately and the worker acquires the
 * same `gmail` advisory lock the scheduler uses (inside
 * `backfillIntelForUser`) so it can't collide with a concurrent
 * normal sync tick on the same mailbox; a contending scheduler tick
 * will just no-op until backfill releases the lock. Progress is
 * visible in the server logs ("Backfill phase A/B/C progress" + final
 * "Backfill complete").
 */
router.post(
  "/admin/google-sync/:id/backfill-intel",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const targetUserId = paramId(req);
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
    // Kick off in the background so the HTTP response doesn't time
    // out on long-running mailboxes. The worker takes the `gmail`
    // advisory lock internally so it serializes against the
    // scheduler. Errors are logged inside backfillIntelForUser.
    void backfillIntelForUser(targetUserId).catch((err) => {
      logger.error({ err, userId: targetUserId }, "Backfill route: failed");
    });
    res.status(202).json({ ok: true, message: "Backfill started" });
  }),
);

/**
 * Gmail-free AI analysis sweep: re-run action-proposal over the user's
 * pending, not-yet-analyzed proposals. Use after archiving + re-detection
 * to fill in AI suggestions without a full mailbox re-pull. Fire-and-
 * forget (202); progress is in the server logs ("analyze-pending
 * progress"). Each row's AI call is bounded by the per-call timeout in
 * proposeActionsForProposal, so a stalled request can't freeze the sweep.
 */
router.post(
  "/admin/email-intel/:id/analyze-pending",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const targetUserId = paramId(req);
    void analyzePendingForUser(targetUserId)
      .then((r) =>
        logger.info({ userId: targetUserId, ...r }, "analyze-pending complete"),
      )
      .catch((err) => {
        logger.error(
          { err, userId: targetUserId },
          "analyze-pending route: failed",
        );
      });
    res.status(202).json({ ok: true, message: "Analysis started" });
  }),
);

export default router;
