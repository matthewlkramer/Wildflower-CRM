import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { emailProposals } from "@workspace/db/schema";
import { proposeActionsForProposal } from "./proposeActions";
import { logger } from "./logger";

/**
 * Sequential AI analysis sweep over a user's pending, not-yet-analyzed
 * proposals. This is the Gmail-free "phase D" of the backfill, exposed
 * standalone so we can (re)run AI action-proposal on an existing pending
 * queue without re-pulling mail.
 *
 * Must run inside the API-server runtime: standalone tsx scripts in this
 * sandbox die after ~10 rows (memory growth) and, when the sync scheduler
 * is active, contend with its inline AI fan-out over the shared
 * integration proxy. In-process it shares the long-lived, optimized
 * bundle and the healthy proxy connection.
 *
 * Strictly sequential to keep token spend and proxy load bounded;
 * per-row errors are counted and logged, never aborting the sweep.
 */
export async function analyzePendingForUser(
  userId: string,
): Promise<{ analyzed: number; errors: number }> {
  let analyzed = 0;
  let errors = 0;

  // Stale-claim recovery. proposeActionsForProposal atomically claims a
  // row by stamping actionsAnalyzedAt with the unix epoch sentinel before
  // the AI call, then overwrites it with the real timestamp on success.
  // If a previous run died between claim and completion (process crash,
  // OOM) the row is stuck at the epoch sentinel and would never be picked
  // up again (it's no longer NULL). Reset any such sentinels for this user
  // back to NULL so they're retried. Safe because the sweep is sequential
  // and single-process: nothing else holds a live epoch claim for these
  // rows at sweep start.
  const recovered = await db
    .update(emailProposals)
    .set({ actionsAnalyzedAt: null })
    .where(
      and(
        eq(emailProposals.mailboxUserId, userId),
        eq(emailProposals.status, "pending"),
        sql`${emailProposals.actionsAnalyzedAt} = to_timestamp(0)`,
      ),
    )
    .returning({ id: emailProposals.id });
  if (recovered.length > 0) {
    logger.info(
      { userId, count: recovered.length },
      "analyze-pending: reset stale in-flight claims before sweep",
    );
  }

  // Two phases, each strictly sequential:
  //   - "fresh"  → rows never analyzed (actions_analyzed_at IS NULL).
  //   - "retry"  → rows that previously errored (actions_error IS NOT NULL).
  // Unlike the backfill's phase-D retry pass, this on-demand sweep does NOT
  // gate retries on the 24h cooldown: it's an operator-triggered cleanup
  // meant to drain the existing rate-limit error backlog immediately once
  // the backoff fix is in. A per-phase seenIds set prevents reprocessing a
  // row within the same sweep (a row that errors again would otherwise keep
  // matching the retry predicate forever).
  for (const phase of ["fresh", "retry"] as const) {
    const seenIds = new Set<string>();
    while (true) {
      const rows = await db
        .select({ id: emailProposals.id })
        .from(emailProposals)
        .where(
          and(
            eq(emailProposals.mailboxUserId, userId),
            eq(emailProposals.status, "pending"),
            phase === "fresh"
              ? sql`${emailProposals.actionsAnalyzedAt} is null`
              : sql`${emailProposals.actionsError} is not null`,
          ),
        )
        .limit(50);
      const fresh = rows.filter((r) => !seenIds.has(r.id));
      if (fresh.length === 0) break;
      for (const { id } of fresh) {
        seenIds.add(id);
        try {
          // The retry phase's rows still carry a real actions_analyzed_at,
          // so clear it first — proposeActionsForProposal's atomic claim
          // only takes rows where actions_analyzed_at IS NULL.
          if (phase === "retry") {
            await db
              .update(emailProposals)
              .set({ actionsAnalyzedAt: null, updatedAt: new Date() })
              .where(eq(emailProposals.id, id));
          }
          const r = await proposeActionsForProposal(id);
          if (r.error) errors++;
          else analyzed++;
        } catch (err) {
          errors++;
          logger.warn(
            { err, userId, proposalId: id, phase },
            "analyze-pending: proposeActionsForProposal threw",
          );
        }
      }
      logger.info({ userId, phase, analyzed, errors }, "analyze-pending progress");
    }
  }
  return { analyzed, errors };
}
