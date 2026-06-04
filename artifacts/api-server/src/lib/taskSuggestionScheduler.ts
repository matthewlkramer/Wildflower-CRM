import { db, pool } from "@workspace/db";
import { taskProposals } from "@workspace/db/schema";
import { and, eq, lt, or, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { type EntityRef, runTaskSuggestion } from "./taskProposalEngine";
import {
  markRunning,
  markFinished,
  readLastFinishedAt,
} from "./taskSuggestionRunState";

/**
 * In-process scheduler for the MONTHLY task-suggestion refresh. Any
 * non-low-priority entity whose cached suggestion hasn't been regenerated in
 * ~30 days gets refreshed so the next-step never goes stale. Mirrors the
 * media-ingestion scheduler: a 30-min tick gated to an off-hours window
 * (America/Chicago), a global pg advisory lock so only one sweep runs at a
 * time (shared with the backfill so the two never overlap), and a singleton
 * state row that records the last run so "due" survives restarts.
 *
 * Only existing PENDING suggestions are refreshed (mode "refresh-pending"):
 * resolved (accepted/dismissed) entities are never auto-resurfaced, and the
 * one-time backfill — not this sweep — is what first creates suggestions.
 */

const CHECK_INTERVAL_MS = 30 * 60_000; // re-evaluate every 30 min
const MIN_DAYS_BETWEEN_RUNS = 28;
// A suggestion is "stale" once it hasn't been (re)analyzed in this long.
const STALE_AFTER_DAYS = 30;
// Off-hours window (CT) when the sweep is allowed to start.
const RUN_HOUR_START = 2;
const RUN_HOUR_END = 5;

// Shared advisory-lock key with the backfill so a monthly sweep and a
// backfill can never run concurrently.
const LOCK_KEY1 = 9_002;
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

export interface RefreshSummary {
  entitiesProcessed: number;
  regenerated: number;
  skipped: number;
  errors: number;
}

/**
 * Find pending suggestions that are stale (analyzed before the cutoff, or
 * never finished generating) and map them to their target entities. Priority
 * is re-checked downstream in `runTaskSuggestion`, so a since-downgraded
 * low-priority entity is skipped there.
 */
async function buildStaleTargets(): Promise<EntityRef[]> {
  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000);
  const rows = await db
    .select({
      personId: taskProposals.targetPersonId,
      organizationId: taskProposals.targetOrganizationId,
    })
    .from(taskProposals)
    .where(
      and(
        eq(taskProposals.status, "pending"),
        or(
          isNull(taskProposals.analyzedAt),
          lt(taskProposals.analyzedAt, cutoff),
        ),
      ),
    );

  const targets: EntityRef[] = [];
  for (const r of rows) {
    if (r.personId) targets.push({ kind: "person", id: r.personId });
    else if (r.organizationId) {
      targets.push({ kind: "organization", id: r.organizationId });
    }
  }
  return targets;
}

/** Run one refresh sweep directly (no lock/state). Exposed for tests. */
export async function runMonthlyTaskRefresh(): Promise<RefreshSummary> {
  const targets = await buildStaleTargets();
  const summary: RefreshSummary = {
    entitiesProcessed: 0,
    regenerated: 0,
    skipped: 0,
    errors: 0,
  };

  logger.info(
    { targetCount: targets.length, staleAfterDays: STALE_AFTER_DAYS },
    "Monthly task-suggestion refresh starting",
  );

  for (const entity of targets) {
    try {
      const { outcome } = await runTaskSuggestion(entity, {
        trigger: "monthly",
        mode: "refresh-pending",
      });
      if (outcome === "regenerated") summary.regenerated += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.errors += 1;
      logger.warn({ err, entity }, "Monthly task-suggestion refresh entity failed");
    }
    summary.entitiesProcessed += 1;
  }

  logger.info({ summary }, "Monthly task-suggestion refresh finished");
  return summary;
}

/**
 * Attempt one refresh under the global advisory lock. Returns the summary
 * when a run executed, or `null` when skipped (lock contended, or not yet
 * due and not forced). Reused by the manual script so it shares the exact
 * same locking + state tracking.
 */
export async function runMonthlyTaskRefreshIfDue(opts?: {
  force?: boolean;
}): Promise<RefreshSummary | null> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4)",
      [LOCK_KEY1, LOCK_KEY2],
    );
    if (got.rows[0]?.pg_try_advisory_lock !== true) {
      logger.debug("Task-suggestion refresh lock contended — another run in progress");
      return null;
    }
    try {
      if (!opts?.force) {
        const last = await readLastFinishedAt();
        if (last) {
          const days = (Date.now() - last.getTime()) / 86_400_000;
          if (days < MIN_DAYS_BETWEEN_RUNS) return null;
        }
      }
      await markRunning("monthly");
      try {
        const summary = await runMonthlyTaskRefresh();
        await markFinished("ok", {
          entitiesProcessed: summary.entitiesProcessed,
          suggestionsRegenerated: summary.regenerated,
          suggestionsSkipped: summary.skipped,
          errors: summary.errors,
        });
        return summary;
      } catch (err) {
        await markFinished("error", {
          lastError: err instanceof Error ? err.message : String(err),
        });
        logger.error({ err }, "Monthly task-suggestion refresh threw");
        throw err;
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [
          LOCK_KEY1,
          LOCK_KEY2,
        ]);
      } catch (err) {
        logger.warn({ err }, "Task-suggestion refresh advisory unlock failed");
      }
    }
  } finally {
    client.release();
  }
}

async function tick(): Promise<void> {
  const hour = chicagoHour(Date.now());
  if (hour < RUN_HOUR_START || hour >= RUN_HOUR_END) return;
  void runMonthlyTaskRefreshIfDue().catch((err) => {
    logger.error({ err }, "Monthly task-suggestion refresh tick failed");
  });
}

export function startTaskSuggestionScheduler(): void {
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") return;
  if (process.env["DISABLE_TASK_SUGGESTIONS"] === "1") {
    logger.info("Task-suggestion scheduler disabled via DISABLE_TASK_SUGGESTIONS=1");
    return;
  }
  if (timer) return;
  logger.info(
    {
      checkIntervalMs: CHECK_INTERVAL_MS,
      runWindowCt: `${RUN_HOUR_START}-${RUN_HOUR_END}`,
      minDaysBetweenRuns: MIN_DAYS_BETWEEN_RUNS,
    },
    "Starting monthly task-suggestion scheduler",
  );
  timer = setInterval(() => {
    tick().catch((err) =>
      logger.error({ err }, "Unhandled task-suggestion tick error"),
    );
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopTaskSuggestionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
