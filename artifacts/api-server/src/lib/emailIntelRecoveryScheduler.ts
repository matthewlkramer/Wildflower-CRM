import { db, pool } from "@workspace/db";
import { emailProposals } from "@workspace/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { analyzePendingForUser } from "./analyzePending";
import { withSyncLock } from "./syncLock";

/**
 * In-process scheduler that auto-recovers errored, still-pending email
 * proposals. A rate-limit burst (or any transient AI failure) can leave
 * proposals stuck with a stored `actions_error` and `status='pending'`
 * — the inline sync fan-out only fires on brand-new rows and the
 * one-time backfill never re-runs, so without this sweep those failures
 * are frozen forever and the Email Intelligence pages keep showing red
 * "AI analysis failed" boxes.
 *
 * This sweep finds errored pending proposals across all mailboxes and
 * re-attempts them, cooldown-gated to once per 24h per row (mirrors the
 * backfill's phase-D cooldown) so a chronically-failing row can't burn
 * tokens indefinitely. Each AI call routes through the shared
 * concurrency limiter + rate-limit-retry wrapper inside
 * `proposeActionsForProposal`, so recovery itself can never re-create a
 * rate-limit storm.
 *
 * Guards (mirroring the other in-process schedulers):
 *   - off-hours window (America/Chicago) so the sequential sweep never
 *     competes with business-hours sync traffic,
 *   - a global pg advisory lock (distinct key) so the sweep never
 *     overlaps itself / another instance,
 *   - per-user `gmail` advisory lock around each mailbox's sub-sweep so
 *     recovery never overlaps that user's scheduled sync or the one-time
 *     backfill (which both take the same lock).
 */

const CHECK_INTERVAL_MS = 30 * 60_000; // re-evaluate every 30 min
// Off-hours window (CT) when the sequential recovery sweep may start.
const RUN_HOUR_START = 2;
const RUN_HOUR_END = 5;
// Per-row cooldown: only re-attempt a row whose last analysis is older
// than this. Mirrors the backfill's phase-D 24h retry cooldown.
const RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Fixed advisory-lock key pair for the global recovery lock. The first
// int is a namespace distinct from the media-ingest (9_001) and
// task-suggestion (9_002) sweeps and the per-source syncLock tags.
const LOCK_KEY1 = 9_003;
const LOCK_KEY2 = 1;

let timer: NodeJS.Timeout | null = null;

function chicagoHour(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(now));
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number(hourStr) % 24;
}

export interface RecoverySummary {
  mailboxesProcessed: number;
  analyzed: number;
  errors: number;
}

/**
 * Find every mailbox that currently has at least one errored, still-
 * pending proposal eligible for retry (past the cooldown), then run a
 * cooldown-gated retry-only sweep for each under that mailbox's `gmail`
 * lock. Exposed without the global lock so a manual trigger can reuse
 * the exact same retry mechanics.
 */
export async function recoverErroredEmailProposals(): Promise<RecoverySummary> {
  const retryAfter = new Date(Date.now() - RETRY_COOLDOWN_MS);
  const mailboxes = await db
    .selectDistinct({ userId: emailProposals.mailboxUserId })
    .from(emailProposals)
    .where(
      and(
        eq(emailProposals.status, "pending"),
        isNotNull(emailProposals.actionsError),
        sql`${emailProposals.actionsAnalyzedAt} < ${retryAfter}`,
      ),
    );

  const summary: RecoverySummary = {
    mailboxesProcessed: 0,
    analyzed: 0,
    errors: 0,
  };

  logger.info(
    { mailboxCount: mailboxes.length },
    "Email-intel recovery sweep starting",
  );

  for (const { userId } of mailboxes) {
    // Serialize against this user's scheduled sync + one-time backfill by
    // taking the same `gmail` advisory lock they use. If contended we
    // skip this mailbox this round — the next sweep will pick it up.
    const lock = await withSyncLock(userId, "gmail", () =>
      analyzePendingForUser(userId, {
        phases: ["retry"],
        retryCooldownMs: RETRY_COOLDOWN_MS,
      }),
    );
    if (!lock.ran) {
      logger.debug(
        { userId },
        "Email-intel recovery skipped — gmail lock contended",
      );
      continue;
    }
    summary.mailboxesProcessed += 1;
    if (lock.result) {
      summary.analyzed += lock.result.analyzed;
      summary.errors += lock.result.errors;
    }
  }

  logger.info({ summary }, "Email-intel recovery sweep finished");
  return summary;
}

/**
 * Run one recovery sweep under the global advisory lock. Returns the
 * summary when a sweep executed, or `null` when skipped (lock
 * contended). Reused by the manual script so it shares the exact same
 * locking.
 */
export async function recoverErroredEmailProposalsIfDue(): Promise<RecoverySummary | null> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4)",
      [LOCK_KEY1, LOCK_KEY2],
    );
    if (got.rows[0]?.pg_try_advisory_lock !== true) {
      logger.debug("Email-intel recovery lock contended — another run in progress");
      return null;
    }
    try {
      return await recoverErroredEmailProposals();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [
          LOCK_KEY1,
          LOCK_KEY2,
        ]);
      } catch (err) {
        logger.warn({ err }, "Email-intel recovery advisory unlock failed");
      }
    }
  } finally {
    client.release();
  }
}

async function tick(): Promise<void> {
  const hour = chicagoHour(Date.now());
  if (hour < RUN_HOUR_START || hour >= RUN_HOUR_END) return;
  // Fire-and-forget: the sequential sweep can be long; don't block the
  // interval timer. The advisory lock prevents overlapping runs.
  void recoverErroredEmailProposalsIfDue().catch((err) => {
    logger.error({ err }, "Email-intel recovery tick failed");
  });
}

export function startEmailIntelRecoveryScheduler(): void {
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") return;
  if (process.env["DISABLE_EMAIL_INTEL_RECOVERY"] === "1") {
    logger.info(
      "Email-intel recovery scheduler disabled via DISABLE_EMAIL_INTEL_RECOVERY=1",
    );
    return;
  }
  if (timer) return;
  logger.info(
    {
      checkIntervalMs: CHECK_INTERVAL_MS,
      runWindowCt: `${RUN_HOUR_START}-${RUN_HOUR_END}`,
      retryCooldownMs: RETRY_COOLDOWN_MS,
    },
    "Starting email-intel recovery scheduler",
  );
  timer = setInterval(() => {
    tick().catch((err) =>
      logger.error({ err }, "Unhandled email-intel recovery tick error"),
    );
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopEmailIntelRecoveryScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
