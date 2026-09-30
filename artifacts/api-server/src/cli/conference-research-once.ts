import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  assertConferenceResearchSchemaReady,
  ConferenceResearchSchemaNotReadyError,
  enqueueScheduledResearch,
  invalidateStaleActiveRequests,
  recoverExpiredConferenceResearchLeases,
  runOneResearchJob,
} from "../lib/conferenceResearchWorker";
import { HARD_CONFERENCE_RUN_MS, runConferenceResearchOnce } from "../lib/conferenceResearchOnce";

// The worker child owns the session lock. If its supervisor is terminated, the
// child retains the lock until it finishes or its own hard watchdog exits.
const ADVISORY_LOCK_KEY = [13079, 267] as const;

async function runChild(): Promise<void> {
  let client: PoolClient | undefined;
  let locked = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    client = await pool.connect();
    client.on("error", () => {
      logger.error({ category: "lock_session_lost" }, "Conference research lock session was lost");
      process.exit(1);
    });
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired", [...ADVISORY_LOCK_KEY],
    );
    locked = result.rows[0]?.acquired === true;
    if (!locked) {
      logger.info({ skippedOverlap: true, jobsAttempted: 0 }, "Conference research run already in progress");
      return;
    }
    watchdog = setTimeout(() => {
      logger.error({ category: "hard_runtime_cap" }, "Conference research run exceeded its hard deadline");
      process.exit(1);
    }, HARD_CONFERENCE_RUN_MS);
    // Detect an otherwise silent connection loss on the lock-holding session,
    // instead of continuing work after another invocation can acquire it.
    heartbeat = setInterval(() => {
      void client?.query("SELECT 1").catch(() => {
        logger.error({ category: "lock_session_lost" }, "Conference research lock session was lost");
        process.exit(1);
      });
    }, 15_000);
    const summary = await runConferenceResearchOnce({
      assertSchemaReady: assertConferenceResearchSchemaReady,
      invalidateStale: invalidateStaleActiveRequests,
      enqueue: enqueueScheduledResearch,
      recover: recoverExpiredConferenceResearchLeases,
      runJob: runOneResearchJob,
      now: Date.now,
    });
    logger.info(summary, "Conference research scheduled run finished");
    process.exitCode = summary.exitCode;
  } catch (error) {
    // Never print provider messages, URLs, prompts, attendee data, or credentials.
    const schemaNotReady = error instanceof ConferenceResearchSchemaNotReadyError;
    logger.error({
      category: schemaNotReady ? "schema_not_ready" : "initialization_or_job_error",
    }, schemaNotReady
      ? "Conference research schema is not ready: publish migration 0267 before running the scheduled job."
      : "Conference research scheduled run failed; inspect database and provider health.");
    process.exitCode = 1;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (heartbeat) clearInterval(heartbeat);
    if (client) {
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock($1, $2)", [...ADVISORY_LOCK_KEY]);
        } catch {
          logger.error({ category: "lock_release" }, "Conference research lock release failed");
          process.exitCode = 1;
        }
      }
      client.release();
    }
    try {
      await pool.end();
    } catch {
      logger.error({ category: "database_shutdown" }, "Conference research database shutdown failed");
      process.exitCode = 1;
    }
  }
}

async function runParent(): Promise<void> {
  try {
    const child = spawn(process.execPath, [
      "--enable-source-maps", fileURLToPath(import.meta.url),
    ], {
      env: { ...process.env, CONFERENCE_RESEARCH_CHILD: "1" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    let timedOut = false;
    process.exitCode = await new Promise<0 | 1>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, HARD_CONFERENCE_RUN_MS);
      child.once("error", () => {
        clearTimeout(timer);
        logger.error({ category: "child_start_failed" }, "Conference research child could not start");
        resolve(1);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          logger.error({ category: "hard_runtime_cap" }, "Conference research run exceeded its hard deadline");
        }
        resolve(!timedOut && code === 0 ? 0 : 1);
      });
    });
  } catch {
    logger.error({ category: "child_initialization" }, "Conference research run could not initialize");
    process.exitCode = 1;
  }
}

void (process.env.CONFERENCE_RESEARCH_CHILD === "1" ? runChild() : runParent());