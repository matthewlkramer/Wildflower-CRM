import { db, pool } from "@workspace/db";
import { people, organizations } from "@workspace/db/schema";
import { ne, or, isNull } from "drizzle-orm";
import { logger } from "./logger";
import {
  type EntityRef,
  runTaskSuggestion,
} from "./taskProposalEngine";
import { markRunning, markFinished } from "./taskSuggestionRunState";

/**
 * One-time upfront backfill: ensure every non-low-priority person and
 * organization has a cached next-step suggestion ready in its Tasks card,
 * so the very first detail-page view is instant (no on-demand AI wait).
 *
 * Idempotent + resumable: each entity goes through the shared
 * `runTaskSuggestion` entry point in mode "ensure", which creates a pending
 * suggestion only when the entity has NO proposal of any status yet. Already
 * generated, already pending, or already resolved (accepted/dismissed)
 * entities are skipped — so re-running after an interruption naturally picks
 * up where it left off without burning duplicate AI calls or resurfacing a
 * suggestion the user already dealt with.
 *
 * Sequential by design: the AI concurrency cap + rate-limit retry live in
 * `generateTaskProposal`, and a steady one-at-a-time sweep keeps the backlog
 * diagnosable and friendly to the shared proxy. The same global advisory
 * lock as the monthly refresh prevents a backfill and a monthly sweep from
 * overlapping.
 */

const LOCK_KEY1 = 9_002;
const LOCK_KEY2 = 1;

export interface BackfillOptions {
  /** Cap the number of entities processed (for verification/testing). */
  maxEntities?: number;
}

export interface BackfillSummary {
  entitiesProcessed: number;
  generated: number;
  skipped: number;
  errors: number;
}

/** All non-low-priority people + organizations, as entity refs. */
async function buildBackfillTargets(): Promise<EntityRef[]> {
  // priority IS NULL counts as "not low" — only an explicit 'low' is skipped.
  const notLow = (col: typeof people.priority | typeof organizations.priority) =>
    or(isNull(col), ne(col, "low"));

  const [personRows, orgRows] = await Promise.all([
    db
      .select({ id: people.id })
      .from(people)
      .where(notLow(people.priority)),
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(notLow(organizations.priority)),
  ]);

  const targets: EntityRef[] = [];
  for (const p of personRows) targets.push({ kind: "person", id: p.id });
  for (const o of orgRows) targets.push({ kind: "organization", id: o.id });
  return targets;
}

/**
 * Run the backfill sweep directly (no lock/state bookkeeping). Exposed for
 * tests; production callers should use `runTaskSuggestionBackfillIfDue`.
 */
export async function runTaskSuggestionBackfill(
  opts: BackfillOptions = {},
): Promise<BackfillSummary> {
  const all = await buildBackfillTargets();
  const targets =
    opts.maxEntities != null ? all.slice(0, opts.maxEntities) : all;

  const summary: BackfillSummary = {
    entitiesProcessed: 0,
    generated: 0,
    skipped: 0,
    errors: 0,
  };

  logger.info(
    { targetCount: targets.length },
    "Task-suggestion backfill starting",
  );

  for (const entity of targets) {
    try {
      const { outcome } = await runTaskSuggestion(entity, {
        trigger: "backfill",
        mode: "ensure",
      });
      if (outcome === "generated") summary.generated += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.errors += 1;
      logger.warn({ err, entity }, "Task-suggestion backfill entity failed");
    }
    summary.entitiesProcessed += 1;
    if (summary.entitiesProcessed % 50 === 0) {
      logger.info(
        { ...summary, targetCount: targets.length },
        "Task-suggestion backfill progress",
      );
    }
  }

  logger.info({ summary }, "Task-suggestion backfill finished");
  return summary;
}

/**
 * Run the backfill under the global advisory lock with run-state tracking,
 * mirroring `runMediaIngestIfDue`. Returns the summary when a run executed,
 * or `null` when the lock was contended (a monthly/backfill run is already
 * in progress).
 */
export async function runTaskSuggestionBackfillIfDue(
  opts: BackfillOptions = {},
): Promise<BackfillSummary | null> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1::int4, $2::int4)",
      [LOCK_KEY1, LOCK_KEY2],
    );
    if (got.rows[0]?.pg_try_advisory_lock !== true) {
      logger.info("Task-suggestion backfill lock contended — skipping");
      return null;
    }
    try {
      await markRunning("backfill");
      try {
        const summary = await runTaskSuggestionBackfill(opts);
        await markFinished("ok", {
          entitiesProcessed: summary.entitiesProcessed,
          suggestionsGenerated: summary.generated,
          suggestionsSkipped: summary.skipped,
          errors: summary.errors,
        });
        return summary;
      } catch (err) {
        await markFinished("error", {
          lastError: err instanceof Error ? err.message : String(err),
        });
        logger.error({ err }, "Task-suggestion backfill threw");
        throw err;
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [
          LOCK_KEY1,
          LOCK_KEY2,
        ]);
      } catch (err) {
        logger.warn({ err }, "Task-suggestion backfill advisory unlock failed");
      }
    }
  } finally {
    client.release();
  }
}
