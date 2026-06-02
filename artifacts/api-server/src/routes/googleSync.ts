import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  calendarSyncState,
  emailSyncState,
  emailMessages,
  emailSyncSkip,
  calendarEvents,
} from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
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
    const toIso = (v: unknown): string | null =>
      v == null
        ? null
        : v instanceof Date
          ? v.toISOString()
          : new Date(v as string).toISOString();

    const [emailRow, calRow, matchedAgg, skippedAgg, calAgg] =
      await Promise.all([
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
        db
          .select({
            count: sql<number>`count(*)::int`,
            earliest: sql<Date | null>`min(${emailMessages.sentAt})`,
            latest: sql<Date | null>`max(${emailMessages.sentAt})`,
          })
          .from(emailMessages)
          .where(eq(emailMessages.mailboxUserId, user.id))
          .then((r) => r[0]),
        db
          .select({
            count: sql<number>`count(*)::int`,
            earliest: sql<Date | null>`min(${emailSyncSkip.sentAt})`,
            latest: sql<Date | null>`max(${emailSyncSkip.sentAt})`,
          })
          .from(emailSyncSkip)
          .where(eq(emailSyncSkip.mailboxUserId, user.id))
          .then((r) => r[0]),
        db
          .select({
            count: sql<number>`count(*)::int`,
            earliest: sql<Date | null>`min(${calendarEvents.startAt})`,
            latest: sql<Date | null>`max(${calendarEvents.startAt})`,
          })
          .from(calendarEvents)
          .where(eq(calendarEvents.calendarUserId, user.id))
          .then((r) => r[0]),
      ]);

    const matchedCount = matchedAgg?.count ?? 0;
    const skippedCount = skippedAgg?.count ?? 0;
    // Earliest/latest synced email spans both matched + skipped messages.
    const emailDates = [
      matchedAgg?.earliest,
      skippedAgg?.earliest,
      matchedAgg?.latest,
      skippedAgg?.latest,
    ]
      .map((d) => (d == null ? null : new Date(d as unknown as string)))
      .filter((d): d is Date => d != null);
    const gmailEarliest = emailDates.length
      ? new Date(Math.min(...emailDates.map((d) => d.getTime())))
      : null;
    const gmailLatest = emailDates.length
      ? new Date(Math.max(...emailDates.map((d) => d.getTime())))
      : null;

    const calCount = calAgg?.count ?? 0;

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
            counts: {
              matched: matchedCount,
              skipped: skippedCount,
              reviewed: matchedCount + skippedCount,
            },
            dateRange: {
              earliest: gmailEarliest?.toISOString() ?? null,
              latest: gmailLatest?.toISOString() ?? null,
            },
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
            counts: {
              // Calendar only stores matched events — there is no
              // per-event skip ledger, so "skipped" is not tracked.
              matched: calCount,
              skipped: null,
              reviewed: calCount,
            },
            dateRange: {
              earliest: toIso(calAgg?.earliest),
              latest: toIso(calAgg?.latest),
            },
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
