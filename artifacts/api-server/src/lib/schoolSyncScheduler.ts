import { db, pool } from "@workspace/db";
import { schoolSyncState, SCHOOL_SYNC_STATE_ID } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { syncSchoolsFromAirtable, type SchoolSyncSummary } from "./schoolSync";
import { isAirtableConfigured } from "./airtableClient";

/**
 * In-process scheduler for the Airtable → schools sync. Runs once a day during
 * off-hours (America/Chicago), consistent with the media-ingest and Flodesk
 * sweeps — the pull is cheap, but keeping it off business hours matches the
 * other source-of-truth syncs.
 *
 * Concurrency is guarded by a global pg advisory lock (a fixed key, distinct
 * from media ingest's (9001,1) and Flodesk's (9001,2)) so only one run happens
 * at a time even across instances. The `school_sync_state` singleton row records
 * the last run so "due" survives restarts and the result is observable without
 * trawling logs.
 */

const CHECK_INTERVAL_MS = 30 * 60_000; // re-evaluate every 30 min
const MIN_HOURS_BETWEEN_RUNS = 20;
// Off-hours window (CT) when the sync is allowed to start.
const RUN_HOUR_START = 3;
const RUN_HOUR_END = 5;

// Fixed advisory-lock key pair for the global school-sync lock. The first int
// reuses the off-hours-job namespace (9001); the second (3) distinguishes it
// from media ingest (9001,1) and Flodesk (9001,2).
const LOCK_KEY1 = 9_001;
const LOCK_KEY2 = 3;

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
    .select({ lastRunFinishedAt: schoolSyncState.lastRunFinishedAt })
    .from(schoolSyncState)
    .where(eq(schoolSyncState.id, SCHOOL_SYNC_STATE_ID))
    .then((r) => r[0]);
  return row?.lastRunFinishedAt ?? null;
}

async function markRunning(): Promise<void> {
  await db
    .insert(schoolSyncState)
    .values({
      id: SCHOOL_SYNC_STATE_ID,
      lastRunStartedAt: new Date(),
      lastStatus: "running",
      lastError: null,
    })
    .onConflictDoUpdate({
      target: schoolSyncState.id,
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
    schoolsFetched?: number;
    schoolsUpserted?: number;
    staleInDb?: number;
    lastError?: string | null;
  },
): Promise<void> {
  await db
    .update(schoolSyncState)
    .set({
      lastRunFinishedAt: new Date(),
      lastStatus: status,
      schoolsFetched: fields.schoolsFetched ?? null,
      schoolsUpserted: fields.schoolsUpserted ?? null,
      staleInDb: fields.staleInDb ?? null,
      lastError: fields.lastError ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schoolSyncState.id, SCHOOL_SYNC_STATE_ID));
}

/**
 * Attempt one sync under the global advisory lock. Returns the
 * `SchoolSyncSummary` when a run actually executed (lock acquired + due), or
 * `null` when skipped (lock contended, or not yet due and not forced). Exported
 * so the manual trigger reuses the same locking + state tracking.
 */
export async function runSchoolSyncIfDue(opts?: {
  force?: boolean;
  maxPages?: number;
  pageSize?: number;
}): Promise<SchoolSyncSummary | null> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4)",
      [LOCK_KEY1, LOCK_KEY2],
    );
    if (got.rows[0]?.pg_try_advisory_lock !== true) {
      logger.debug("School sync lock contended — another run in progress");
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
        const summary = await syncSchoolsFromAirtable({
          ...(opts?.maxPages != null ? { maxPages: opts.maxPages } : {}),
          ...(opts?.pageSize != null ? { pageSize: opts.pageSize } : {}),
        });
        await markFinished("ok", {
          schoolsFetched: summary.schoolsFetched,
          schoolsUpserted: summary.schoolsUpserted,
          staleInDb: summary.stale.length,
        });
        return summary;
      } catch (err) {
        await markFinished("error", {
          lastError: err instanceof Error ? err.message : String(err),
        });
        logger.error({ err }, "School sync run threw");
        throw err;
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [
          LOCK_KEY1,
          LOCK_KEY2,
        ]);
      } catch (err) {
        logger.warn({ err }, "School sync advisory unlock failed");
      }
    }
  } finally {
    client.release();
  }
}

async function tick(): Promise<void> {
  const hour = chicagoHour(Date.now());
  if (hour < RUN_HOUR_START || hour >= RUN_HOUR_END) return;
  if (!isAirtableConfigured()) return;
  void runSchoolSyncIfDue().catch((err) => {
    logger.error({ err }, "School sync tick failed");
  });
}

export function startSchoolSyncScheduler(): void {
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") return;
  if (process.env["DISABLE_SCHOOL_SYNC"] === "1") {
    logger.info("School sync scheduler disabled via DISABLE_SCHOOL_SYNC=1");
    return;
  }
  if (timer) return;
  logger.info(
    {
      checkIntervalMs: CHECK_INTERVAL_MS,
      runWindowCt: `${RUN_HOUR_START}-${RUN_HOUR_END}`,
    },
    "Starting school sync scheduler",
  );
  timer = setInterval(() => {
    tick().catch((err) =>
      logger.error({ err }, "Unhandled school sync tick error"),
    );
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopSchoolSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
