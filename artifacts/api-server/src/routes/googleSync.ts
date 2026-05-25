import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { calendarSyncState, emailSyncState } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import { syncUserGmail } from "../lib/gmailSync";
import { syncUserCalendar } from "../lib/calendarSync";
import { withSyncLock } from "../lib/syncLock";

/**
 * Per-CRM-user Gmail (and eventually Calendar) sync controls. All
 * routes operate on the caller's own mailbox — the manual "Resync
 * now" button on Settings hits POST /google-sync/gmail. The cron
 * scheduler from T006 will call `syncUserGmail` directly without
 * going through HTTP.
 */
const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/google-sync/status",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const [emailRow, calRow] = await Promise.all([
      db
        .select()
        .from(emailSyncState)
        .where(eq(emailSyncState.mailboxUserId, user.id))
        .then((r) => r[0]),
      db
        .select()
        .from(calendarSyncState)
        .where(eq(calendarSyncState.calendarUserId, user.id))
        .then((r) => r[0]),
    ]);
    res.json({
      gmail: emailRow
        ? {
            lastHistoryId: emailRow.lastHistoryId,
            lastSyncedAt: emailRow.lastSyncedAt?.toISOString() ?? null,
            lastError: emailRow.lastError,
            bootstrapCompletedAt:
              emailRow.bootstrapCompletedAt?.toISOString() ?? null,
            bootstrapInProgress:
              !emailRow.bootstrapCompletedAt && !!emailRow.bootstrapPageToken,
          }
        : null,
      calendar: calRow
        ? {
            hasSyncToken: !!calRow.syncToken,
            lastSyncedAt: calRow.lastSyncedAt?.toISOString() ?? null,
            lastError: calRow.lastError,
            bootstrapCompletedAt:
              calRow.bootstrapCompletedAt?.toISOString() ?? null,
            bootstrapInProgress:
              !calRow.bootstrapCompletedAt && !!calRow.bootstrapPageToken,
          }
        : null,
    });
  }),
);

router.post(
  "/google-sync/gmail",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const lock = await withSyncLock(user.id, "gmail", () => syncUserGmail(user.id));
    if (!lock.ran) {
      res.status(409).json({
        error: "sync_in_progress",
        message: "A Gmail sync is already running for your account.",
      });
      return;
    }
    const outcome = lock.result!;
    if (!outcome.ok && outcome.notConnected) {
      res.status(409).json({
        error: "not_connected",
        message: "Connect your Google account in Settings before syncing.",
      });
      return;
    }
    if (!outcome.ok) {
      res.status(500).json({ error: "sync_failed", message: outcome.error ?? "Unknown error" });
      return;
    }
    res.json({ ok: true, report: outcome.report });
  }),
);

router.post(
  "/google-sync/calendar",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const lock = await withSyncLock(user.id, "calendar", () => syncUserCalendar(user.id));
    if (!lock.ran) {
      res.status(409).json({
        error: "sync_in_progress",
        message: "A Calendar sync is already running for your account.",
      });
      return;
    }
    const outcome = lock.result!;
    if (!outcome.ok && outcome.notConnected) {
      res.status(409).json({
        error: "not_connected",
        message: "Connect your Google account in Settings before syncing.",
      });
      return;
    }
    if (!outcome.ok) {
      res
        .status(500)
        .json({ error: "sync_failed", message: outcome.error ?? "Unknown error" });
      return;
    }
    res.json({ ok: true, report: outcome.report });
  }),
);

export default router;
