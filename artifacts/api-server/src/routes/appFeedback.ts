import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { appFeedback, appFeedbackProposals, db, users } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { getAppUser } from "../lib/appRequest";
import { canStartFeedbackImplementation } from "../lib/feedbackImplementationAuth";
import { asyncHandler, newId } from "../lib/helpers";
import {
  processQueuedFeedbackProposal,
  queueAppFeedbackProposal,
} from "../lib/feedbackProposalEngine";
import { generateAppFeedbackProposal } from "../lib/proposeFeedback";

const router: IRouter = Router();
router.use(requireAuth);

const FeedbackCategory = z.enum(["bug", "question", "suggestion", "other"]);
const FeedbackStatus = z.enum(["open", "in_progress", "resolved", "dismissed"]);
const ScreenshotStatus = z.enum(["captured", "failed", "skipped"]);
const ScreenshotUrl = z
  .string()
  .max(2048)
  .regex(
    /^\/api\/storage\/objects\//,
    "Screenshot must use private object storage.",
  );

const CreateFeedbackBody = z.object({
  category: FeedbackCategory.default("bug"),
  message: z.string().trim().min(1).max(10_000),
  pageUrl: z.string().trim().min(1).max(5000),
  pagePath: z.string().trim().min(1).max(3000),
  pageTitle: z.string().trim().max(500).nullable().optional(),
  context: z.record(z.string(), z.unknown()).default({}),
  screenshotUrl: ScreenshotUrl.nullable().optional(),
  screenshotFilename: z.string().trim().max(500).nullable().optional(),
  screenshotStatus: ScreenshotStatus.default("skipped"),
  screenshotError: z.string().trim().max(2000).nullable().optional(),
});

const ListFeedbackQuery = z.object({
  status: z.union([FeedbackStatus, z.literal("all")]).default("open"),
  category: z.union([FeedbackCategory, z.literal("all")]).default("all"),
  search: z.string().trim().max(500).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const UpdateFeedbackBody = z
  .object({
    status: FeedbackStatus.optional(),
    adminNotes: z.string().trim().max(20_000).nullable().optional(),
  })
  .refine(
    (value) => value.status !== undefined || value.adminNotes !== undefined,
    {
      message: "At least one feedback field must be updated.",
    },
  );

const ReviseFeedbackProposalBody = z.object({
  reviewerGuidance: z.string().trim().min(1).max(20_000),
});

class FeedbackImplementationConflict extends Error {}

function parseOr400<T>(
  schema: z.ZodType<T>,
  value: unknown,
  res: Response,
): T | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    res.status(400).json({
      error: "validation_error",
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
    return null;
  }
  return parsed.data;
}

type UserSummary = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
};

function displayName(user: UserSummary | undefined): string | null {
  if (!user) return null;
  return (
    user.displayName?.trim() ||
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.email
  );
}

async function usersById(ids: Array<string | null>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map<string, UserSummary>();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      displayName: users.displayName,
    })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

function serializeFeedback(
  row: typeof appFeedback.$inferSelect,
  userMap: Map<string, UserSummary>,
  proposalRow: typeof appFeedbackProposals.$inferSelect | null = null,
  viewerCanImplement = false,
) {
  const reporter = userMap.get(row.createdByUserId);
  const resolver = row.resolvedByUserId
    ? userMap.get(row.resolvedByUserId)
    : undefined;
  return {
    ...row,
    reporter: {
      id: row.createdByUserId,
      name: displayName(reporter),
      email: reporter?.email ?? null,
    },
    resolver: row.resolvedByUserId
      ? {
          id: row.resolvedByUserId,
          name: displayName(resolver),
          email: resolver?.email ?? null,
        }
      : null,
    proposal: proposalRow
      ? {
          ...proposalRow,
          implementationRequestedBy: proposalRow.implementationRequestedByUserId
            ? (() => {
                const user = userMap.get(
                  proposalRow.implementationRequestedByUserId,
                );
                return {
                  id: proposalRow.implementationRequestedByUserId,
                  name: displayName(user),
                  email: user?.email ?? null,
                };
              })()
            : null,
        }
      : null,
    viewerCanImplement,
  };
}

async function proposalsByFeedbackId(feedbackIds: string[]) {
  if (!feedbackIds.length) {
    return new Map<string, typeof appFeedbackProposals.$inferSelect>();
  }
  const rows = await db
    .select()
    .from(appFeedbackProposals)
    .where(inArray(appFeedbackProposals.feedbackId, feedbackIds));
  return new Map(rows.map((row) => [row.feedbackId, row]));
}

router.post(
  "/feedback",
  asyncHandler(async (req, res) => {
    const actor = getAppUser(req);
    if (!actor?.id) {
      res
        .status(401)
        .json({ error: "unauthorized", message: "Sign in required." });
      return;
    }
    const body = parseOr400(CreateFeedbackBody, req.body, res);
    if (!body) return;
    if (Buffer.byteLength(JSON.stringify(body.context), "utf8") > 200_000) {
      res.status(400).json({
        error: "context_too_large",
        message: "Captured page context is too large.",
      });
      return;
    }

    const [row] = await db
      .insert(appFeedback)
      .values({
        id: `feedback_${newId()}`,
        createdByUserId: actor.id,
        category: body.category,
        message: body.message,
        pageUrl: body.pageUrl,
        pagePath: body.pagePath,
        pageTitle: body.pageTitle ?? null,
        context: body.context,
        screenshotUrl: body.screenshotUrl ?? null,
        screenshotFilename: body.screenshotFilename ?? null,
        screenshotStatus: body.screenshotStatus,
        screenshotError: body.screenshotError ?? null,
      })
      .returning();
    const proposal = await queueAppFeedbackProposal(row.id);
    const userMap = await usersById([row.createdByUserId]);
    res.status(201).json(serializeFeedback(row, userMap, proposal));
    if (proposal && process.env.NODE_ENV !== "test") {
      void processQueuedFeedbackProposal(proposal.id).catch(() => {
        // Generation records its own failures; the scheduler also recovers a
        // process interruption. Feedback submission must never fail because AI
        // is unavailable.
      });
    }
  }),
);

router.get(
  "/admin/feedback",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const viewerCanImplement = canStartFeedbackImplementation(getAppUser(req));
    const query = parseOr400(ListFeedbackQuery, req.query, res);
    if (!query) return;

    const status = query.status ?? "open";
    const category = query.category ?? "all";
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const filters: SQL[] = [];
    if (status !== "all") filters.push(eq(appFeedback.status, status));
    if (category !== "all") {
      filters.push(eq(appFeedback.category, category));
    }
    if (query.search) {
      const escapedSearch = query.search.replace(
        /[\\%_]/g,
        (character) => `\\${character}`,
      );
      const term = `%${escapedSearch}%`;
      filters.push(sql`(
        ${appFeedback.message} ILIKE ${term} ESCAPE '\\'
        OR ${appFeedback.pagePath} ILIKE ${term} ESCAPE '\\'
        OR COALESCE(${appFeedback.pageTitle}, '') ILIKE ${term} ESCAPE '\\'
        OR COALESCE(${appFeedback.adminNotes}, '') ILIKE ${term} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM users feedback_user
          WHERE feedback_user.id = ${appFeedback.createdByUserId}
            AND (
              feedback_user.email ILIKE ${term} ESCAPE '\\'
              OR COALESCE(feedback_user.display_name, '') ILIKE ${term} ESCAPE '\\'
              OR (COALESCE(feedback_user.first_name, '') || ' ' || COALESCE(feedback_user.last_name, '')) ILIKE ${term} ESCAPE '\\'
            )
        )
      )`);
    }
    const where = filters.length ? and(...filters) : undefined;
    const offset = (page - 1) * limit;
    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(appFeedback)
        .where(where)
        .orderBy(desc(appFeedback.createdAt), desc(appFeedback.id))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(appFeedback).where(where),
    ]);
    const proposalMap = await proposalsByFeedbackId(rows.map((row) => row.id));
    const userMap = await usersById(
      rows.flatMap((row) => {
        const proposal = proposalMap.get(row.id);
        return [
          row.createdByUserId,
          row.resolvedByUserId,
          proposal?.implementationRequestedByUserId ?? null,
        ];
      }),
    );
    res.json({
      data: rows.map((row) =>
        serializeFeedback(
          row,
          userMap,
          proposalMap.get(row.id) ?? null,
          viewerCanImplement,
        ),
      ),
      pagination: {
        page,
        limit,
        total: Number(totalRows[0]?.value ?? 0),
      },
    });
  }),
);

router.patch(
  "/admin/feedback/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const actor = getAppUser(req);
    if (!actor?.id) {
      res
        .status(401)
        .json({ error: "unauthorized", message: "Sign in required." });
      return;
    }
    const id = String(req.params.id ?? "");
    const body = parseOr400(UpdateFeedbackBody, req.body, res);
    if (!body) return;

    const current = await db.query.appFeedback.findFirst({
      where: eq(appFeedback.id, id),
    });
    if (!current) {
      res
        .status(404)
        .json({ error: "not_found", message: "Feedback item not found." });
      return;
    }
    const nextStatus = body.status ?? current.status;
    const terminal = nextStatus === "resolved" || nextStatus === "dismissed";
    const [row] = await db
      .update(appFeedback)
      .set({
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.adminNotes !== undefined
          ? { adminNotes: body.adminNotes }
          : {}),
        resolvedByUserId: terminal ? actor.id : null,
        resolvedAt: terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(appFeedback.id, id))
      .returning();
    const proposalMap = await proposalsByFeedbackId([row.id]);
    const proposal = proposalMap.get(row.id) ?? null;
    const userMap = await usersById([
      row.createdByUserId,
      row.resolvedByUserId,
      proposal?.implementationRequestedByUserId ?? null,
    ]);
    res.json(
      serializeFeedback(
        row,
        userMap,
        proposal,
        canStartFeedbackImplementation(actor),
      ),
    );
  }),
);

router.post(
  "/admin/feedback/:id/proposal/revise",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const actor = getAppUser(req);
    if (!actor?.id) {
      res
        .status(401)
        .json({ error: "unauthorized", message: "Sign in required." });
      return;
    }
    const feedbackId = String(req.params.id ?? "");
    const body = parseOr400(ReviseFeedbackProposalBody, req.body, res);
    if (!body) return;

    const current = await db.query.appFeedbackProposals.findFirst({
      where: eq(appFeedbackProposals.feedbackId, feedbackId),
    });
    if (!current) {
      res.status(404).json({
        error: "not_found",
        message: "Feedback proposal not found.",
      });
      return;
    }
    if (current.implementationRequestedAt) {
      res.status(409).json({
        error: "implementation_already_requested",
        message: "Implementation has already been requested for this proposal.",
      });
      return;
    }

    const appendedGuidance = current.reviewerGuidance?.trim()
      ? `${current.reviewerGuidance.trim()}\n\n---\n\nRevision ${current.revision + 1}: ${body.reviewerGuidance}`
      : `Revision ${current.revision + 1}: ${body.reviewerGuidance}`;
    const [claimed] = await db
      .update(appFeedbackProposals)
      .set({
        generationStatus: "generating",
        revision: sql`${appFeedbackProposals.revision} + 1`,
        proposal: null,
        reviewerGuidance: appendedGuidance,
        analyzedAt: null,
        model: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appFeedbackProposals.id, current.id),
          inArray(appFeedbackProposals.generationStatus, ["ready", "error"]),
          isNull(appFeedbackProposals.implementationRequestedAt),
        ),
      )
      .returning({ id: appFeedbackProposals.id });
    if (!claimed) {
      res.status(409).json({
        error: "proposal_generating",
        message: "This proposal is already being generated.",
      });
      return;
    }

    await generateAppFeedbackProposal(claimed.id);
    const [feedbackRow, proposalRow] = await Promise.all([
      db.query.appFeedback.findFirst({
        where: eq(appFeedback.id, feedbackId),
      }),
      db.query.appFeedbackProposals.findFirst({
        where: eq(appFeedbackProposals.id, claimed.id),
      }),
    ]);
    if (!feedbackRow || !proposalRow) {
      res.status(404).json({
        error: "not_found",
        message: "Feedback item not found.",
      });
      return;
    }
    const userMap = await usersById([
      feedbackRow.createdByUserId,
      feedbackRow.resolvedByUserId,
      proposalRow.implementationRequestedByUserId,
    ]);
    res.json(
      serializeFeedback(
        feedbackRow,
        userMap,
        proposalRow,
        canStartFeedbackImplementation(actor),
      ),
    );
  }),
);

router.post(
  "/admin/feedback/:id/proposal/implement",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const actor = getAppUser(req);
    if (!actor?.id) {
      res
        .status(401)
        .json({ error: "unauthorized", message: "Sign in required." });
      return;
    }
    if (!canStartFeedbackImplementation(actor)) {
      res.status(403).json({
        error: "feedback_implementer_required",
        message:
          "Only the configured feedback implementer can start implementation.",
      });
      return;
    }
    const feedbackId = String(req.params.id ?? "");

    let result:
      | {
          feedback: typeof appFeedback.$inferSelect;
          proposal: typeof appFeedbackProposals.$inferSelect;
        }
      | undefined;
    try {
      result = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(appFeedbackProposals)
          .where(eq(appFeedbackProposals.feedbackId, feedbackId))
          .limit(1);
        if (!current) return undefined;
        if (
          current.generationStatus !== "ready" ||
          !current.proposal?.implementationBrief ||
          current.implementationRequestedAt
        ) {
          throw new FeedbackImplementationConflict();
        }

        const now = new Date();
        const [proposal] = await tx
          .update(appFeedbackProposals)
          .set({
            implementationRequestedAt: now,
            implementationRequestedByUserId: actor.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(appFeedbackProposals.id, current.id),
              eq(appFeedbackProposals.generationStatus, "ready"),
              isNull(appFeedbackProposals.implementationRequestedAt),
            ),
          )
          .returning();
        if (!proposal) throw new FeedbackImplementationConflict();

        const [feedback] = await tx
          .update(appFeedback)
          .set({
            status: "in_progress",
            resolvedByUserId: null,
            resolvedAt: null,
            updatedAt: now,
          })
          .where(eq(appFeedback.id, feedbackId))
          .returning();
        if (!feedback) throw new FeedbackImplementationConflict();
        return { feedback, proposal };
      });
    } catch (err) {
      if (err instanceof FeedbackImplementationConflict) {
        res.status(409).json({
          error: "proposal_not_ready",
          message:
            "The proposal is not ready or implementation has already been requested.",
        });
        return;
      }
      throw err;
    }
    if (!result) {
      res.status(404).json({
        error: "not_found",
        message: "Feedback proposal not found.",
      });
      return;
    }

    const userMap = await usersById([
      result.feedback.createdByUserId,
      result.feedback.resolvedByUserId,
      result.proposal.implementationRequestedByUserId,
    ]);
    res.json(
      serializeFeedback(result.feedback, userMap, result.proposal, true),
    );
  }),
);

export default router;
