import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { taskProposals, tasks } from "@workspace/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  GetTaskProposalQueryParams,
  RefreshTaskProposalBody,
  AcceptTaskProposalBody,
  DismissTaskProposalBody,
  ReviseTaskProposalBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseOrBadRequest,
} from "../lib/helpers";
import { generateTaskProposal } from "../lib/proposeTask";
import {
  type EntityRef,
  dedupeKeyForEntity,
  loadEntityPriority,
  findPendingProposal,
  hasAnyProposal,
  loadProposalById,
  createAndGenerate,
} from "../lib/taskProposalEngine";

/**
 * Task intelligence — AI-suggested next-step cultivation tasks surfaced
 * inside the Tasks card on person / organization detail pages.
 *
 * On-demand hybrid, modeled on email-intelligence: the first time a detail
 * page renders we generate + cache one `pending` suggestion per entity;
 * later views read the cached row so it's instant. A refresh regenerates
 * the same pending row in place. Accepting spins up a real linked task and
 * flips the proposal → accepted; dismissing flips it → dismissed with an
 * optional note (audit trail). Low-priority entities are skipped (no row,
 * no AI call) — GET returns `{ data: null }`.
 */

const router: IRouter = Router();
router.use(requireAuth);

/**
 * Thrown inside the accept/dismiss transaction when the conditional
 * `status = 'pending'` claim matches no row — i.e. a concurrent request
 * already resolved the proposal. Caught by the handler to roll back and
 * return 409 instead of producing duplicate/ambiguous resolutions.
 */
class ProposalRaceLost extends Error {}

/**
 * Append a new reviewer note to the existing one rather than overwriting it,
 * so successive corrections (a "propose alternative" comment, then a later
 * accept/dismiss verdict note) all survive for prompt tuning. Mirrors the
 * email-proposal append-note semantics.
 */
function appendReviewerNoteSql(addition: string): SQL {
  return sql`case
    when ${taskProposals.reviewerNote} is null or ${taskProposals.reviewerNote} = ''
      then ${addition}
    else ${taskProposals.reviewerNote} || ${"\n\n---\n\n"} || ${addition}
  end`;
}

/**
 * Resolve exactly one of personId / organizationId into a normalized
 * entity ref. Returns null (and the caller should 400) when neither or both
 * are supplied. The per-entity bookkeeping (dedupe / priority / find /
 * create) lives in `../lib/taskProposalEngine` and is shared with the
 * automated backfill, signal, and monthly-refresh paths.
 */
function resolveTarget(
  personId: string | undefined,
  organizationId: string | undefined,
): EntityRef | null {
  const hasPerson = typeof personId === "string" && personId.length > 0;
  const hasOrg =
    typeof organizationId === "string" && organizationId.length > 0;
  if (hasPerson === hasOrg) return null; // neither or both
  if (hasPerson) return { kind: "person", id: personId! };
  return { kind: "organization", id: organizationId! };
}

/**
 * GET /task-proposals?personId=&organizationId=
 *
 * Returns the current pending suggestion for an entity, generating + caching
 * one on first view. Low-priority entities are skipped → { data: null }.
 */
router.get(
  "/task-proposals",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const q = parseOrBadRequest(GetTaskProposalQueryParams, req.query, res);
    if (!q) return;
    const target = resolveTarget(q.personId, q.organizationId);
    if (!target) {
      res.status(400).json({
        error: "Provide exactly one of personId or organizationId.",
      });
      return;
    }
    const dedupeKey = dedupeKeyForEntity(target);

    const existing = await findPendingProposal(dedupeKey);
    if (existing) {
      res.json({ data: existing });
      return;
    }

    // No pending suggestion. Only auto-generate on a TRUE first view: if the
    // user already accepted/dismissed a prior suggestion for this entity we
    // return null instead of silently burning another AI call — they can hit
    // Refresh to get a fresh one.
    if (await hasAnyProposal(dedupeKey)) {
      res.json({ data: null });
      return;
    }

    // First view — gate on priority before spending an AI call.
    const { found, priority } = await loadEntityPriority(target);
    if (!found) {
      res.status(404).json({ error: "entity not found" });
      return;
    }
    if (priority === "low") {
      res.json({ data: null });
      return;
    }

    const row = await createAndGenerate(target, dedupeKey);
    res.json({ data: row ?? null });
  }),
);

/**
 * POST /task-proposals/refresh
 *
 * Regenerate the suggestion for an entity. If a pending row exists, rerun
 * generation in place; otherwise create one (unless low-priority).
 */
router.post(
  "/task-proposals/refresh",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = parseOrBadRequest(RefreshTaskProposalBody, req.body, res);
    if (!body) return;
    const target = resolveTarget(body.personId, body.organizationId);
    if (!target) {
      res.status(400).json({
        error: "Provide exactly one of personId or organizationId.",
      });
      return;
    }
    const dedupeKey = dedupeKeyForEntity(target);

    const { found, priority } = await loadEntityPriority(target);
    if (!found) {
      res.status(404).json({ error: "entity not found" });
      return;
    }
    if (priority === "low") {
      res.json({ data: null });
      return;
    }

    const existing = await findPendingProposal(dedupeKey);
    if (existing) {
      await generateTaskProposal(existing.id);
      const row = await loadProposalById(existing.id);
      res.json({ data: row ?? null });
      return;
    }

    const row = await createAndGenerate(target, dedupeKey);
    res.json({ data: row ?? null });
  }),
);

/**
 * POST /task-proposals/:id/accept
 *
 * Create a real linked task from the suggestion and flip the proposal to
 * accepted. The created task inherits the suggested title / description /
 * due date and links to the same target entity.
 */
router.post(
  "/task-proposals/:id/accept",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    const body = parseOrBadRequest(AcceptTaskProposalBody, req.body ?? {}, res);
    if (!body) return;

    const id = paramId(req);
    const proposal = await loadProposalById(id);
    if (!proposal) return notFound(res, "task proposal");
    if (proposal.status !== "pending") {
      res.status(400).json({ error: "proposal already resolved" });
      return;
    }
    if (!proposal.title) {
      res.status(400).json({
        error: "proposal has no suggestion to accept yet",
      });
      return;
    }

    let result: { task: typeof tasks.$inferSelect; proposal: typeof taskProposals.$inferSelect } | null = null;
    try {
      result = await db.transaction(async (tx) => {
        const [task] = await tx
          .insert(tasks)
          .values({
            id: newId(),
            title: proposal.title!,
            description: proposal.description ?? null,
            dueDate: proposal.suggestedDueDate ?? null,
            kind: "general",
            status: "open",
            createdByUserId: user.id,
            assigneeUserId: body.assigneeUserId ?? null,
            personIds: proposal.targetPersonId ? [proposal.targetPersonId] : null,
            organizationIds: proposal.targetOrganizationId
              ? [proposal.targetOrganizationId]
              : null,
          })
          .returning();

        // Atomically claim the proposal: only succeeds if it is still pending.
        // A concurrent accept that already flipped it loses this race and the
        // task insert above is rolled back, so we never create duplicate tasks.
        const note = body.reviewerNote?.trim();
        const [updated] = await tx
          .update(taskProposals)
          .set({
            status: "accepted",
            acceptedTaskId: task.id,
            // Append the verdict note so any earlier "propose alternative"
            // comments survive; leave the column untouched when no note.
            ...(note ? { reviewerNote: appendReviewerNoteSql(note) } : {}),
            resolvedAt: new Date(),
            resolvedByUserId: user.id,
            updatedAt: new Date(),
          })
          .where(and(eq(taskProposals.id, id), eq(taskProposals.status, "pending")))
          .returning();

        if (!updated) throw new ProposalRaceLost();
        return { task, proposal: updated };
      });
    } catch (err) {
      if (err instanceof ProposalRaceLost) {
        res.status(409).json({ error: "proposal already resolved" });
        return;
      }
      throw err;
    }

    res.json(result);
  }),
);

/**
 * POST /task-proposals/:id/dismiss
 *
 * Flip the proposal to dismissed, recording an optional reviewer note for
 * later prompt tuning. No real task is created.
 */
router.post(
  "/task-proposals/:id/dismiss",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    const body = parseOrBadRequest(DismissTaskProposalBody, req.body ?? {}, res);
    if (!body) return;

    const id = paramId(req);
    const proposal = await loadProposalById(id);
    if (!proposal) return notFound(res, "task proposal");
    if (proposal.status !== "pending") {
      res.status(400).json({ error: "proposal already resolved" });
      return;
    }

    // Atomically claim: only dismiss if still pending, so a competing
    // accept/dismiss can't produce an ambiguous resolution.
    const note = body.reviewerNote?.trim();
    const [updated] = await db
      .update(taskProposals)
      .set({
        status: "dismissed",
        // Append the verdict note so any earlier "propose alternative"
        // comments survive; leave the column untouched when no note.
        ...(note ? { reviewerNote: appendReviewerNoteSql(note) } : {}),
        resolvedAt: new Date(),
        resolvedByUserId: user.id,
        updatedAt: new Date(),
      })
      .where(and(eq(taskProposals.id, id), eq(taskProposals.status, "pending")))
      .returning();

    if (!updated) {
      res.status(409).json({ error: "proposal already resolved" });
      return;
    }

    res.json(updated);
  }),
);

/**
 * POST /task-proposals/:id/revise
 *
 * Re-run the AI suggestion for one PENDING proposal, folding in a human
 * reviewer's plain-English correction (e.g. "this prospect already gave
 * this year — suggest a stewardship thank-you instead of an ask"). The
 * reviewer's comment is appended to `reviewer_note` (not overwritten) so
 * successive corrections — and any later accept/dismiss verdict note — all
 * survive for prompt tuning. We reset `error` + `analyzed_at` so the row
 * reads as "generating" while the synchronous re-run executes, then return
 * the refreshed row (new suggestion, or a fresh error). The proposal stays
 * pending. Mirrors the email-proposal /revise handler, including the
 * 404-vs-409 distinction.
 */
router.post(
  "/task-proposals/:id/revise",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) return notFound(res, "user");
    const body = parseOrBadRequest(ReviseTaskProposalBody, req.body ?? {}, res);
    if (!body) return;
    const guidance = body.reviewerGuidance.trim();
    if (!guidance) {
      res.status(400).json({
        error: "reviewerGuidance must not be empty.",
      });
      return;
    }

    const id = paramId(req);
    // Claim the row for re-analysis: append the reviewer's comment, clear
    // the stored error, and reset analyzed_at to NULL — scoped to a pending
    // proposal. The conditional UPDATE doubles as the state guard (a
    // non-pending row matches zero rows).
    const [reset] = await db
      .update(taskProposals)
      .set({
        reviewerNote: appendReviewerNoteSql(`Proposed alternative: ${guidance}`),
        error: null,
        analyzedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(taskProposals.id, id), eq(taskProposals.status, "pending")))
      .returning({ id: taskProposals.id });

    if (!reset) {
      // Distinguish "doesn't exist" (404) from "already resolved" (409).
      const existing = await loadProposalById(id);
      if (!existing) return notFound(res, "task proposal");
      res.status(409).json({ error: "proposal already resolved" });
      return;
    }

    // Re-run generation WITH the reviewer's guidance. Errors are recorded on
    // the row (never thrown), so we just re-read the refreshed state.
    await generateTaskProposal(id, { reviewerGuidance: guidance });
    const row = await loadProposalById(id);
    res.json({ data: row ?? null });
  }),
);

export default router;
