import { appFeedback, appFeedbackProposals, db } from "@workspace/db";
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import { newId } from "./helpers";
import { logger } from "./logger";
import { generateAppFeedbackProposal } from "./proposeFeedback";

const SWEEP_LIMIT = 5;
const STALE_GENERATION_MS = 15 * 60 * 1000;

export async function queueAppFeedbackProposal(feedbackId: string) {
  const [inserted] = await db
    .insert(appFeedbackProposals)
    .values({
      id: `feedback_proposal_${newId()}`,
      feedbackId,
      generationStatus: "queued",
    })
    .onConflictDoNothing({ target: appFeedbackProposals.feedbackId })
    .returning();
  if (inserted) return inserted;
  return (
    (await db.query.appFeedbackProposals.findFirst({
      where: eq(appFeedbackProposals.feedbackId, feedbackId),
    })) ?? null
  );
}

/** Atomically claim one queued row so multiple server instances never double-call AI. */
export async function processQueuedFeedbackProposal(
  proposalId: string,
): Promise<boolean> {
  const [claimed] = await db
    .update(appFeedbackProposals)
    .set({ generationStatus: "generating", error: null, updatedAt: new Date() })
    .where(
      and(
        eq(appFeedbackProposals.id, proposalId),
        eq(appFeedbackProposals.generationStatus, "queued"),
      ),
    )
    .returning({ id: appFeedbackProposals.id });
  if (!claimed) return false;
  await generateAppFeedbackProposal(proposalId);
  return true;
}

export async function queueAndGenerateFeedbackProposal(
  feedbackId: string,
): Promise<void> {
  const proposal = await queueAppFeedbackProposal(feedbackId);
  if (proposal) await processQueuedFeedbackProposal(proposal.id);
}

export type FeedbackProposalSweepSummary = {
  recovered: number;
  queued: number;
  processed: number;
};

/**
 * Bounded, resumable sweep for old feedback and interrupted generations.
 * Safe across multiple app instances: the unique feedback key de-duplicates
 * queue rows and the conditional queued→generating update claims AI work.
 */
export async function runFeedbackProposalSweep(
  limit = SWEEP_LIMIT,
): Promise<FeedbackProposalSweepSummary> {
  const cutoff = new Date(Date.now() - STALE_GENERATION_MS);
  const recovered = await db
    .update(appFeedbackProposals)
    .set({
      generationStatus: "queued",
      error: "Previous generation was interrupted and has been re-queued.",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appFeedbackProposals.generationStatus, "generating"),
        lt(appFeedbackProposals.updatedAt, cutoff),
      ),
    )
    .returning({ id: appFeedbackProposals.id });

  const missing = await db
    .select({ feedbackId: appFeedback.id })
    .from(appFeedback)
    .leftJoin(
      appFeedbackProposals,
      eq(appFeedbackProposals.feedbackId, appFeedback.id),
    )
    .where(isNull(appFeedbackProposals.id))
    .orderBy(asc(appFeedback.createdAt), asc(appFeedback.id))
    .limit(limit);

  let queued = 0;
  for (const row of missing) {
    const [inserted] = await db
      .insert(appFeedbackProposals)
      .values({
        id: `feedback_proposal_${newId()}`,
        feedbackId: row.feedbackId,
        generationStatus: "queued",
      })
      .onConflictDoNothing({ target: appFeedbackProposals.feedbackId })
      .returning({ id: appFeedbackProposals.id });
    if (inserted) queued += 1;
  }

  const readyToProcess = await db
    .select({ id: appFeedbackProposals.id })
    .from(appFeedbackProposals)
    .where(eq(appFeedbackProposals.generationStatus, "queued"))
    .orderBy(asc(appFeedbackProposals.createdAt), asc(appFeedbackProposals.id))
    .limit(limit);

  let processed = 0;
  for (const row of readyToProcess) {
    if (await processQueuedFeedbackProposal(row.id)) processed += 1;
  }

  return { recovered: recovered.length, queued, processed };
}

export function startFeedbackProposalScheduler(): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runFeedbackProposalSweep();
      if (summary.recovered || summary.queued || summary.processed) {
        logger.info({ summary }, "Feedback proposal sweep complete");
      }
    } catch (err) {
      logger.error({ err }, "Feedback proposal sweep failed");
    } finally {
      running = false;
    }
  };

  setTimeout(() => void run(), 5_000).unref();
  setInterval(() => void run(), 60_000).unref();
}
