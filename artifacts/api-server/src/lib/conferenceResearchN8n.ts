import type { PoolClient } from "pg";
import { pool } from "@workspace/db";
import {
  CONFERENCE_RESEARCH_ADVISORY_LOCK_KEY,
  runConferenceResearchOnce,
  type ConferenceRunSummary,
} from "./conferenceResearchOnce";
import {
  assertConferenceResearchSchemaReady,
  enqueueScheduledResearch,
  invalidateStaleActiveRequests,
  recoverExpiredConferenceResearchLeases,
  runOneResearchJob,
} from "./conferenceResearchWorker";
import { logger } from "./logger";

export type ConferenceResearchIntegrationStatus = "idle" | "processed" | "busy";

export interface ConferenceResearchIntegrationTickResult {
  status: ConferenceResearchIntegrationStatus;
  hasMore: boolean;
  alertRequired: boolean;
  eventsScanned: number;
  windowsDue: number;
  enqueueFailures: number;
  contextInvalidated: number;
  staleRequeued: number;
  staleExhausted: number;
  jobsAttempted: number;
  completed: number;
  retrying: number;
  failed: number;
  skipped: number;
}

const EMPTY_COUNTS = {
  eventsScanned: 0,
  windowsDue: 0,
  enqueueFailures: 0,
  contextInvalidated: 0,
  staleRequeued: 0,
  staleExhausted: 0,
  jobsAttempted: 0,
  completed: 0,
  retrying: 0,
  failed: 0,
  skipped: 0,
} as const;

function responseFromSummary(
  summary: ConferenceRunSummary,
): ConferenceResearchIntegrationTickResult {
  return {
    status: summary.jobsAttempted > 0 ? "processed" : "idle",
    // One job per request keeps the HTTP call bounded. A processed job asks
    // n8n for one more pass; the final pass observes and reports an idle queue.
    hasMore: summary.jobCapReached,
    alertRequired: summary.exitCode !== 0,
    eventsScanned: summary.eventsScanned,
    windowsDue: summary.windowsDue,
    enqueueFailures: summary.enqueueFailures,
    contextInvalidated: summary.contextInvalidated,
    staleRequeued: summary.staleRequeued,
    staleExhausted: summary.staleExhausted,
    jobsAttempted: summary.jobsAttempted,
    completed: summary.completed,
    retrying: summary.retrying,
    failed: summary.failed,
    skipped: summary.skipped,
  };
}

/**
 * Run one n8n-triggered queue step while this process owns the same Postgres
 * session lock as the scheduled CLI. n8n never receives database or provider
 * credentials and overlapping workflow retries return a harmless busy result.
 */
export async function runConferenceResearchN8nTick(): Promise<ConferenceResearchIntegrationTickResult> {
  let client: PoolClient | undefined;
  let locked = false;
  try {
    client = await pool.connect();
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [...CONFERENCE_RESEARCH_ADVISORY_LOCK_KEY],
    );
    locked = result.rows[0]?.acquired === true;
    if (!locked) {
      return {
        status: "busy",
        hasMore: true,
        alertRequired: false,
        ...EMPTY_COUNTS,
      };
    }

    const summary = await runConferenceResearchOnce(
      {
        assertSchemaReady: assertConferenceResearchSchemaReady,
        invalidateStale: invalidateStaleActiveRequests,
        enqueue: enqueueScheduledResearch,
        recover: recoverExpiredConferenceResearchLeases,
        runJob: runOneResearchJob,
        now: Date.now,
      },
      { maxJobs: 1 },
    );
    return responseFromSummary(summary);
  } finally {
    if (client) {
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock($1, $2)", [
            ...CONFERENCE_RESEARCH_ADVISORY_LOCK_KEY,
          ]);
        } catch (error) {
          logger.error(
            { category: "lock_release", error },
            "Conference research n8n lock release failed",
          );
        }
      }
      client.release();
    }
  }
}

export const conferenceResearchIntegrationResultFromSummary =
  responseFromSummary;
