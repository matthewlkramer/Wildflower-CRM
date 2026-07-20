import { pool } from "@workspace/db";
import { logger } from "./logger";
import { runDerivationHealthCheck } from "./derivationHealth";

/**
 * Nightly derivation health check — LOG-ONLY, REPORT-ONLY.
 *
 * Runs the read-only drift check once a day during off-hours (America/Chicago)
 * and logs the result: a warn with the per-field drift summary when drift is
 * found, an info line when clean. No state table on purpose — the check never
 * writes anything, and losing the "last ran" marker across a restart just
 * means one extra read-only run. The Admin page card runs the same check
 * on demand via GET /admin/derivation-health.
 *
 * Concurrency is guarded by a global pg advisory lock so multiple server
 * instances don't run it simultaneously (harmless if they did — read-only —
 * but pointless).
 */

const CHECK_INTERVAL_MS = 30 * 60_000; // re-evaluate every 30 min
const MIN_HOURS_BETWEEN_RUNS = 20;
// Off-hours window (CT) when the nightly run is allowed to start.
const RUN_HOUR_START = 2;
const RUN_HOUR_END = 5;

// Fixed advisory-lock key pair. Namespace distinct from syncLock's per-source
// tags (1, 2) and the media-ingest lock (9_001).
const LOCK_KEY1 = 9_002;
const LOCK_KEY2 = 1;

let timer: NodeJS.Timeout | null = null;
// In-memory only — see the module comment for why this isn't persisted.
let lastFinishedAtMs: number | null = null;

function chicagoHour(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(now));
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number(hourStr) % 24;
}

async function runNightlyDerivationHealth(): Promise<void> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4)",
      [LOCK_KEY1, LOCK_KEY2],
    );
    if (got.rows[0]?.pg_try_advisory_lock !== true) {
      logger.debug("Derivation health lock contended — another run in progress");
      return;
    }
    try {
      const report = await runDerivationHealthCheck();
      lastFinishedAtMs = Date.now();
      if (report.driftCount > 0) {
        logger.warn(
          {
            driftCount: report.driftCount,
            byField: report.byField,
            checkedOpportunities: report.checkedOpportunities,
            durationMs: report.durationMs,
            // First few rows for immediate context; the full list is one
            // admin-endpoint call away.
            sample: report.drift.slice(0, 10),
          },
          "Derivation health check found drift (stored ≠ derived) — some write path likely skipped its derivation applier",
        );
      } else {
        logger.info(
          {
            checkedOpportunities: report.checkedOpportunities,
            durationMs: report.durationMs,
          },
          "Derivation health check clean — all persisted derived fields match",
        );
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [
          LOCK_KEY1,
          LOCK_KEY2,
        ]);
      } catch (err) {
        logger.warn({ err }, "Derivation health advisory unlock failed");
      }
    }
  } finally {
    client.release();
  }
}

async function tick(): Promise<void> {
  const hour = chicagoHour(Date.now());
  if (hour < RUN_HOUR_START || hour >= RUN_HOUR_END) return;
  if (
    lastFinishedAtMs !== null &&
    (Date.now() - lastFinishedAtMs) / 3_600_000 < MIN_HOURS_BETWEEN_RUNS
  ) {
    return;
  }
  await runNightlyDerivationHealth();
}

export function startDerivationHealthScheduler(): void {
  if (process.env["NODE_ENV"] === "test") return;
  if (process.env["DISABLE_SYNC_SCHEDULER"] === "1") return;
  if (timer) return;
  logger.info(
    { checkIntervalMs: CHECK_INTERVAL_MS, runWindowCt: `${RUN_HOUR_START}-${RUN_HOUR_END}` },
    "Starting derivation health scheduler (nightly, report-only)",
  );
  timer = setInterval(() => {
    tick().catch((err) =>
      logger.error({ err }, "Derivation health tick failed"),
    );
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopDerivationHealthScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
