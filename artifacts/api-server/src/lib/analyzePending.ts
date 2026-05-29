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

  while (true) {
    const rows = await db
      .select({ id: emailProposals.id })
      .from(emailProposals)
      .where(
        and(
          eq(emailProposals.mailboxUserId, userId),
          eq(emailProposals.status, "pending"),
          sql`${emailProposals.actionsAnalyzedAt} is null`,
        ),
      )
      .limit(50);
    if (rows.length === 0) break;
    for (const { id } of rows) {
      try {
        const r = await proposeActionsForProposal(id);
        if (r.error) errors++;
        else analyzed++;
      } catch (err) {
        errors++;
        logger.warn(
          { err, userId, proposalId: id },
          "analyze-pending: proposeActionsForProposal threw",
        );
      }
    }
    logger.info({ userId, analyzed, errors }, "analyze-pending progress");
  }
  return { analyzed, errors };
}
