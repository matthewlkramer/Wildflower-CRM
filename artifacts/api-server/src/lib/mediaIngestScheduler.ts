import { db, pool } from "@workspace/db";
import { mediaIngestState, MEDIA_INGEST_STATE_ID } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { ingestMediaMentions, type IngestSummary } from "./mediaIngest";

/**
 * In-process scheduler for the GDELT media-mention ingestion job. Runs once a
 * day during off-hours (America/Chicago) — a full sweep of ~1000 entities is
 * throttled and takes a while, so we deliberately avoid business hours.
 *
 * Concurrency is guarded by a global pg advisory lock (a fixed key, distinct
 * from the per-user sync locks) so that even with multiple server instances
 * only one run happens at a time. The `media_ingest_state` singleton row
 * records the last run so "due" survives restarts and the result is
 * observable without trawling logs.
 */

const CHECK_INTERVAL_MS = 30 * 60_000; // re-evaluate every 30 min
const MIN_HOURS_BETWEEN_RUNS = 20;
// Off-hours window (CT) when the long throttled sweep is allowed to start.
const RUN_HOUR_START = 2;
const RUN_HOUR_END = 5;

// Fixed advisory-lock key pair for the global ingest lock. The first int is a
// namespace that won't collide with syncLock's per-source tags (1, 2).
const LOCK_KEY1 = 9_001;
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

async function readLastFinishedAt(): Promise<Date | null> {
  const row = await db
    .select({ lastRunFinishedAt: mediaIngestState.lastRunFinishedAt })
    .from(mediaIngestState)
    .where(eq(mediaIngestState.id, MEDIA_INGEST_STATE_ID))
    .then((r) => r[0]);
  return row?.lastRunFinishedAt ?? null;
}

async function markRunning(): Promise<void> {
  await db
    .insert(mediaIngestState)
    .values({
      id: MEDIA_INGEST_STATE_ID,
      lastRunStartedAt: new Date(),
      lastStatus: "running",
      lastError: null,
    })
    .onConflictDoUpdate({
      target: mediaIngestState.id,
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
    entitiesProcessed?: number;
    mentionsCreated?: number;
    mentionsLinked?: number;
    lastError?: string | null;
  },
): Promise<void> {
  await db
    .update(mediaIngestState)
    .set({
      lastRunFinishedAt: new Date(),
      lastStatus: status,
      entitiesProcessed: fields.entitiesProcessed ?? null,
      mentionsCreated: fields.mentionsCreated ?? null,
      mentionsLinked: fields.mentionsLinked ?? null,
      lastError: fields.lastError ?? null,
      updatedAt: new Date(),
    })
    .where(eq(mediaIngestState.id, MEDIA_INGEST_STATE_ID));
}

/**
 * Attempt one run under the global advisory lock. Returns the run `IngestSummary`
 * when a run actually executed (lock acquired + due), or `null` when it was
 * skipped (lock contended, or not yet due and not forced). Exported so a manual
 * trigger / script can reuse the exact same locking + state-tracking instead of
 * calling `ingestMediaMentions` directly and bypassing the lock.
 */
export async function runMediaIngestIfDue(opts?: {
  force?: boolean;
  maxEntities?: number;
  timespanDays?: number;
  throttleMs?: number;
}): Promise<IngestSummary | null> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4)",
      [LOCK_KEY1, LOCK_KEY2],
    );
    if (got.rows[0]?.pg_try_advisory_lock !== true) {
      logger.debug("Media ingest lock contended — another run in progress");
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
        const summary = await ingestMediaMentions({
          ...(opts?.maxEntities != null ? { maxEntities: opts.maxEntities } : {}),
          ...(opts?.timespanDays != null ? { timespanDays: opts.timespanDays } : {}),
          ...(opts?.throttleMs != null ? { throttleMs: opts.throttleMs } : {}),
        });
        await markFinished("ok", {
          entitiesProcessed: summary.entitiesProcessed,
          mentionsCreated: summary.mentionsCreated,
          mentionsLinked: summary.mentionsLinked,
        });
        return summary;
      } catch (err) {
        await markFinished("error", {
          lastError: err instanceof Error ? err.message : String(err),
        });
        logger.error({ err }, "Media ingest run threw");
        throw err;
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [
          LOCK_KEY1,
          LOCK_KEY2,
        ]);
      } catch (err) {
        logger.warn({ err }, "Media ingest advisory unlock failed");
      }
    }
  } finally {
    client.release();
  }
}

async function tick(): Promise<void> {
  const hour = chicagoHour(Date.now());
  if (hour < RUN_HOUR_START || hour >= RUN_HOUR_END) return;
  // Fire-and-forget: the sweep is long; don't block the interval timer.
  void runMediaIngestIfDue().catch((err) => {
    logger.error({ err }, "Media ingest tick failed");
  });
}

export function startMediaIngestScheduler(): void {
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") return;
  if (process.env["DISABLE_MEDIA_INGEST"] === "1") {
    logger.info("Media ingest scheduler disabled via DISABLE_MEDIA_INGEST=1");
    return;
  }
  if (timer) return;
  logger.info(
    { checkIntervalMs: CHECK_INTERVAL_MS, runWindowCt: `${RUN_HOUR_START}-${RUN_HOUR_END}` },
    "Starting media ingest scheduler",
  );
  timer = setInterval(() => {
    tick().catch((err) => logger.error({ err }, "Unhandled media ingest tick error"));
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopMediaIngestScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
