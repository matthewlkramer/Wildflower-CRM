import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  emailProposals,
  emails,
  people,
} from "@workspace/db/schema";
import { and, count, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  ListEmailProposalsQueryParams,
  AcceptEmailProposalBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  notFound,
  paramId,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";
import { applyAction, validateAction, type ApplyActionResult } from "../lib/applyProposalActions";

/**
 * Email-intelligence proposal queue.
 *
 * Per-mailbox-owner: every list / mutation is implicitly scoped to the
 * caller as mailbox owner. We do NOT let one user accept/reject another
 * user's proposals — these encode private email content.
 *
 * Acceptance is per-kind:
 *   - bounce_invalid: flip emails.validity → "invalid"
 *   - bounce_soft:    no auto side-effect, just mark applied (review-only)
 *   - signature_update / linkedin_job_change / auto_responder_move:
 *     no auto side-effect in this first cut — surfaces the data, the
 *     user edits the person/funder record manually with the proposal as
 *     context. (Auto-apply of these requires careful UX; deferred.)
 *
 * Reject simply transitions status → rejected so the row stops
 * appearing in the pending queue but remains as audit trail.
 */

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/email-proposals",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const q = parseOrBadRequest(ListEmailProposalsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);

    // Hard scope to the caller's mailbox. An explicit `mailboxUserId`
    // param is only respected when it matches the caller — keeps the
    // generated client API symmetric without opening a cross-user
    // read.
    const callerScope = q.mailboxUserId && q.mailboxUserId !== user.id
      ? q.mailboxUserId  // will yield 0 rows because of the eq below
      : user.id;

    const filters: SQL[] = [eq(emailProposals.mailboxUserId, user.id)];
    if (callerScope !== user.id) {
      // Explicitly mismatched mailboxUserId — short-circuit empty.
      res.json({ data: [], pagination: { page, limit, total: 0 } });
      return;
    }
    if (q.kind) filters.push(eq(emailProposals.kind, q.kind));
    if (q.status) filters.push(eq(emailProposals.status, q.status));
    const where = and(...filters);

    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(emailProposals)
        .where(where)
        .orderBy(desc(emailProposals.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(emailProposals).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/email-proposals/summary",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const rows = await db
      .select({
        kind: emailProposals.kind,
        pending: count(),
      })
      .from(emailProposals)
      .where(
        and(
          eq(emailProposals.mailboxUserId, user.id),
          eq(emailProposals.status, "pending"),
        ),
      )
      .groupBy(emailProposals.kind);
    const byKind = rows.map((r) => ({ kind: r.kind, pending: Number(r.pending) }));
    const totalPending = byKind.reduce((s, r) => s + r.pending, 0);
    res.json({ byKind, totalPending });
  }),
);

router.post(
  "/email-proposals/:id/accept",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // Body is per-kind options — kept as an opaque record by codegen.
    // We parse so an obviously malformed JSON still 400s, but the
    // accept handlers themselves read only the keys they care about.
    const body = parseOrBadRequest(AcceptEmailProposalBody, req.body ?? {}, res);
    if (!body) return;

    // Atomic state-transition: claim the proposal by flipping status
    // pending → applied inside the same transaction that runs the
    // AI-proposed action dispatcher. Conditional UPDATE on
    // status='pending' means a concurrent accept/reject loses the
    // race deterministically. Action dispatcher errors abort the
    // transaction so partial mutations never land.
    const outcome = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(emailProposals)
        .set({
          status: "applied",
          resolvedAt: new Date(),
          resolvedByUserId: user.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(emailProposals.id, paramId(req)),
            eq(emailProposals.mailboxUserId, user.id),
            eq(emailProposals.status, "pending"),
          ),
        )
        .returning();
      if (!claimed) return undefined;
      const proposal = claimed;

      const rawActions = Array.isArray(proposal.proposedActions)
        ? (proposal.proposedActions as unknown[])
        : [];
      const applyResults: ApplyActionResult[] = [];
      for (const raw of rawActions) {
        const validated = validateAction(raw);
        if (!validated.ok) {
          // The stored action set is malformed (older row, manual
          // edit, drifted schema). Refuse to apply the whole set
          // rather than partially apply what we can parse.
          const failed: ApplyActionResult = {
            type: ((raw as { type?: string })?.type ?? "unknown") as ApplyActionResult["type"],
            status: "failed",
            message: `Invalid stored action: ${validated.message}`,
          };
          applyResults.push(failed);
          throw new ProposalApplyError(failed, applyResults);
        }
        const result = await applyAction(tx, validated.action, {
          mailboxUserId: user.id,
        });
        applyResults.push(result);
        if (result.status === "failed") {
          // Abort the whole transaction. The user will get the
          // failure message and the proposal stays pending.
          throw new ProposalApplyError(result, applyResults);
        }
      }

      // Always touch updated_at on the target person (if any) so the
      // person resorts to the top of "recently touched" lists when
      // the reviewer acknowledges a signal — even when no AI actions
      // ran.
      if (proposal.targetPersonId) {
        await tx
          .update(people)
          .set({ updatedAt: new Date() })
          .where(eq(people.id, proposal.targetPersonId));
      }

      return { proposal, applyResults };
    }).catch((err) => {
      if (err instanceof ProposalApplyError) return { error: err };
      throw err;
    });

    if (!outcome) {
      // Either the id doesn't exist for this mailbox, or another
      // request already resolved it.
      return notFound(res, "pending email proposal");
    }
    if ("error" in outcome) {
      const { failed, partial } = outcome.error;
      res.status(422).json({
        error: "action_failed",
        message: failed.message ?? "Action failed to apply.",
        failedAction: failed.type,
        attemptedResults: partial,
      });
      return;
    }
    res.json({ ...outcome.proposal, appliedActions: outcome.applyResults });
  }),
);

class ProposalApplyError extends Error {
  failed: ApplyActionResult;
  partial: ApplyActionResult[];
  constructor(failed: ApplyActionResult, partial: ApplyActionResult[]) {
    super(failed.message ?? `Failed to apply ${failed.type}`);
    this.failed = failed;
    this.partial = partial;
  }
}

router.post(
  "/email-proposals/:id/reject",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const [row] = await db
      .update(emailProposals)
      .set({
        status: "rejected",
        resolvedAt: new Date(),
        resolvedByUserId: user.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailProposals.id, paramId(req)),
          eq(emailProposals.mailboxUserId, user.id),
          eq(emailProposals.status, "pending"),
        ),
      )
      .returning();
    if (!row) return notFound(res, "email proposal");
    res.json(row);
  }),
);

// Touch sql to silence unused-import warnings when the per-kind apply
// logic above doesn't reach the raw-SQL branch.
void sql;

export default router;
