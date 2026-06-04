import { db, pool } from "@workspace/db";
import { flodeskSyncState, FLODESK_SYNC_STATE_ID } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  reconcileFlodeskUnsubscribes,
  type FlodeskReconcileSummary,
} from "./flodeskSync";
import { isFlodeskConfigured } from "./flodeskClient";

/**
 * In-process scheduler for the inbound Flodesk unsubscribe reconcile. Runs
 * once a day during off-hours (America/Chicago), consistent with the media
 * ingest sweep — the subscriber scan is paginated and we'd rather keep it out
 * of business hours.
 *
 * Concurrency is guarded by a global pg advisory lock (a fixed key, distinct
 * from media ingest's and the per-user sync locks) so only one run happens at
 * a time even across instances. The `flodesk_sync_state` singleton row records
 * the last run so "due" survives restarts and the result is observable without
 * trawling logs.
 */

const CHECK_INTERVAL_MS = 30 * 60_000; // re-evaluate every 30 min
const MIN_HOURS_BETWEEN_RUNS = 20;
// Off-hours window (CT) when the reconcile is allowed to start.
const RUN_HOUR_START = 3;
const RUN_HOUR_END = 5;

// Fixed advisory-lock key pair for the global Flodesk reconcile lock. The
// first int reuses the off-hours-job namespace (9001); the second (2)
// distinguishes it from media ingest (9001, 1).
const LOCK_KEY1 = 9_001;
const LOCK_KEY2 = 2;

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

async function readLastFinishedAt(): Promise<Date | null> {
  const row = await db
    .select({ lastRunFinishedAt: flodeskSyncState.lastRunFinishedAt })
    .from(flodeskSyncState)
    .where(eq(flodeskSyncState.id, FLODESK_SYNC_STATE_ID))
    .then((r) => r[0]);
  return row?.lastRunFinishedAt ?? null;
}

async function markRunning(): Promise<void> {
  await db
    .insert(flodeskSyncState)
    .values({
      id: FLODESK_SYNC_STATE_ID,
      lastRunStartedAt: new Date(),
      lastStatus: "running",
      lastError: null,
    })
    .onConflictDoUpdate({
      target: flodeskSyncState.id,
      set: {
        lastRunStartedAt: new Date(),
        lastStatus: "running",
        lastError: null,
        updatedAt: new Date(),
      },
    });
}

async function markFinished(
  status: "ok" | "error",
  fields: {
    subscribersChecked?: number;
    unsubscribesApplied?: number;
    lastError?: string | null;
  },
): Promise<void> {
  await db
    .update(flodeskSyncState)
    .set({
      lastRunFinishedAt: new Date(),
      lastStatus: status,
      subscribersChecked: fields.subscribersChecked ?? null,
      unsubscribesApplied: fields.unsubscribesApplied ?? null,
      lastError: fields.lastError ?? null,
      updatedAt: new Date(),
    })
    .where(eq(flodeskSyncState.id, FLODESK_SYNC_STATE_ID));
}

/**
 * Attempt one reconcile under the global advisory lock. Returns the
 * `FlodeskReconcileSummary` when a run actually executed (lock acquired + due),
 * or `null` when skipped (lock contended, or not yet due and not forced).
 * Exported so the manual trigger reuses the same locking + state tracking.
 */
export async function runFlodeskSyncIfDue(opts?: {
  force?: boolean;
  maxPages?: number;
  perPage?: number;
}): Promise<FlodeskReconcileSummary | null> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4)",
      [LOCK_KEY1, LOCK_KEY2],
    );
    if (got.rows[0]?.pg_try_advisory_lock !== true) {
      logger.debug("Flodesk reconcile lock contended — another run in progress");
      return null;
    }
    try {
      if (!opts?.force) {
        const last = await readLastFinishedAt();
        if (last) {
          const hours = (Date.now() - last.getTime()) / 3_600_000;
          if (hours < MIN_HOURS_BETWEEN_RUNS) return null;
        }
      }
      await markRunning();
      try {
        const summary = await reconcileFlodeskUnsubscribes({
          ...(opts?.maxPages != null ? { maxPages: opts.maxPages } : {}),
          ...(opts?.perPage != null ? { perPage: opts.perPage } : {}),
        });
        await markFinished("ok", {
          subscribersChecked: summary.subscribersChecked,
          unsubscribesApplied: summary.unsubscribesApplied,
        });
        return summary;
      } catch (err) {
        await markFinished("error", {
          lastError: err instanceof Error ? err.message : String(err),
        });
        logger.error({ err }, "Flodesk reconcile run threw");
        throw err;
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [
          LOCK_KEY1,
          LOCK_KEY2,
        ]);
      } catch (err) {
        logger.warn({ err }, "Flodesk reconcile advisory unlock failed");
      }
    }
  } finally {
    client.release();
  }
}

async function tick(): Promise<void> {
  const hour = chicagoHour(Date.now());
  if (hour < RUN_HOUR_START || hour >= RUN_HOUR_END) return;
  if (!isFlodeskConfigured()) return;
  void runFlodeskSyncIfDue().catch((err) => {
    logger.error({ err }, "Flodesk reconcile tick failed");
  });
}

export function startFlodeskSyncScheduler(): void {
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") return;
  if (process.env["DISABLE_FLODESK_SYNC"] === "1") {
    logger.info("Flodesk sync scheduler disabled via DISABLE_FLODESK_SYNC=1");
    return;
  }
  if (timer) return;
  logger.info(
    {
      checkIntervalMs: CHECK_INTERVAL_MS,
      runWindowCt: `${RUN_HOUR_START}-${RUN_HOUR_END}`,
    },
    "Starting Flodesk sync scheduler",
  );
  timer = setInterval(() => {
    tick().catch((err) =>
      logger.error({ err }, "Unhandled Flodesk reconcile tick error"),
    );
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopFlodeskSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
