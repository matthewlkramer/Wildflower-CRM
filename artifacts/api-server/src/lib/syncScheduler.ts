import { db } from "@workspace/db";
import {
  calendarSyncState,
  emailSyncState,
  googleOauthTokens,
  users,
} from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { syncUserGmail } from "./gmailSync";
import { syncUserCalendar } from "./calendarSync";
import { withSyncLock } from "./syncLock";

/**
 * Per-user Gmail + Calendar sync scheduler. Runs in-process inside the
 * API server (no external cron). Every TICK_MS we sweep all users with
 * an active Google grant and trigger a sync for any user whose last
 * sync is older than SYNC_INTERVAL_MS — staggered by a per-user jitter
 * derived from their userId so all mailboxes don't hit Google
 * simultaneously after a server restart.
 *
 * Re-entrancy guard: a single in-flight tick is enforced via `running`.
 * If a previous tick takes longer than TICK_MS (e.g. someone with a
 * very large initial bootstrap), subsequent ticks no-op until it
 * settles. Gmail then Calendar run sequentially per user; errors in
 * one don't block the other.
 *
 * The scheduler never throws out of `tick()` — each user is wrapped in
 * try/catch and errors are persisted to google_oauth_tokens.last_error
 * by the sync workers themselves (see gmailSync.ts / calendarSync.ts).
 */

const TICK_MS = 60_000;
const SYNC_INTERVAL_MS = 15 * 60_000;
const JITTER_MS = 5 * 60_000;

// Stable per-user jitter (0..JITTER_MS-1). djb2-ish hash — we don't
// need crypto here, just a deterministic spread across users so they
// don't all tick at the same minute-of-hour.
function userJitter(userId: string): number {
  let h = 5381;
  for (let i = 0; i < userId.length; i++) {
    h = ((h << 5) + h + userId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % JITTER_MS;
}

let running = false;
let timer: NodeJS.Timeout | null = null;

interface DueRow {
  userId: string;
  lastEmailSyncedAt: Date | null;
  lastCalendarSyncedAt: Date | null;
}

export async function tick(now: number = Date.now()): Promise<void> {
  if (running) {
    logger.debug("Sync scheduler tick skipped — previous tick still running");
    return;
  }
  running = true;
  try {
    // Pull every active grant + its last-synced times in one query. The
    // sync-state rows may not exist yet for a freshly-connected user, so
    // we LEFT JOIN and treat NULL as "infinitely overdue".
    const rows: DueRow[] = await db
      .select({
        userId: googleOauthTokens.userId,
        lastEmailSyncedAt: emailSyncState.lastSyncedAt,
        lastCalendarSyncedAt: calendarSyncState.lastSyncedAt,
      })
      .from(googleOauthTokens)
      .leftJoin(
        emailSyncState,
        eq(emailSyncState.mailboxUserId, googleOauthTokens.userId),
      )
      .leftJoin(
        calendarSyncState,
        eq(calendarSyncState.calendarUserId, googleOauthTokens.userId),
      )
      .innerJoin(users, eq(users.id, googleOauthTokens.userId))
      .where(
        and(
          isNull(googleOauthTokens.revokedAt),
          // Archived staff lose all access; their tokens may still be
          // valid upstream but we shouldn't continue ingesting their
          // mail/calendar into the CRM after deprovisioning.
          isNull(users.archivedAt),
        ),
      );

    for (const r of rows) {
      const jitter = userJitter(r.userId);
      // We compute due time per-source. A new sync runs when EITHER
      // gmail or calendar is overdue — but we then run both, since
      // they share the same Google grant and rate limits.
      const emailDue =
        (r.lastEmailSyncedAt?.getTime() ?? 0) + SYNC_INTERVAL_MS + jitter;
      const calDue =
        (r.lastCalendarSyncedAt?.getTime() ?? 0) + SYNC_INTERVAL_MS + jitter;
      if (now < emailDue && now < calDue) continue;

      logger.info({ userId: r.userId }, "Sync scheduler firing for user");
      try {
        const lock = await withSyncLock(r.userId, "gmail", () =>
          syncUserGmail(r.userId),
        );
        if (!lock.ran) {
          logger.debug({ userId: r.userId }, "Scheduled Gmail sync skipped — locked");
        } else if (lock.result && !lock.result.ok) {
          logger.warn(
            { userId: r.userId, err: lock.result.error, notConnected: lock.result.notConnected },
            "Scheduled Gmail sync returned non-ok",
          );
        }
      } catch (err) {
        // syncUserGmail's contract is to never throw, but defensively
        // catch in case a future change leaks an exception — we don't
        // want one user's bug to stall the whole scheduler.
        logger.error({ err, userId: r.userId }, "Scheduled Gmail sync threw");
      }
      try {
        const lock = await withSyncLock(r.userId, "calendar", () =>
          syncUserCalendar(r.userId),
        );
        if (!lock.ran) {
          logger.debug({ userId: r.userId }, "Scheduled Calendar sync skipped — locked");
        } else if (lock.result && !lock.result.ok) {
          logger.warn(
            { userId: r.userId, err: lock.result.error, notConnected: lock.result.notConnected },
            "Scheduled Calendar sync returned non-ok",
          );
        }
      } catch (err) {
        logger.error({ err, userId: r.userId }, "Scheduled Calendar sync threw");
      }
    }
  } catch (err) {
    logger.error({ err }, "Sync scheduler tick failed");
  } finally {
    running = false;
  }
}

export function startSyncScheduler(): void {
  // Don't spin the scheduler in test environments — they're expected
  // to drive the workers directly.
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") {
    logger.info("Sync scheduler disabled via DISABLE_SYNC_SCHEDULER=1");
    return;
  }
  if (timer) return;
  logger.info(
    { tickMs: TICK_MS, syncIntervalMs: SYNC_INTERVAL_MS, jitterMs: JITTER_MS },
    "Starting sync scheduler",
  );
  timer = setInterval(() => {
    tick().catch((err) => {
      logger.error({ err }, "Unhandled error in scheduler tick");
    });
  }, TICK_MS);
  // Allow the process to exit cleanly during graceful shutdown.
  timer.unref?.();
}

export function stopSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
