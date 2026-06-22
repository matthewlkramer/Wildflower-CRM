import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  reconciliationProposals,
  stagedPayments,
  users,
} from "@workspace/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { CreateReconciliationProposalBody } from "@workspace/api-zod";
import {
  asyncHandler,
  newId,
  notFound,
  parseOrBadRequest,
} from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";

const router: IRouter = Router();

// Integer-coerce + clamp a pagination query param. Truncates decimals and
// falls back to `def` on non-finite input so a malformed `?limit=12.5` can
// never reach Postgres as a non-integer LIMIT/OFFSET (which would 500).
function clampInt(raw: unknown, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// Author display name: prefer the explicit display name, then first+last, then
// email — never expose null when a user row exists.
const authorName = sql<string | null>`COALESCE(
  NULLIF(TRIM(${users.displayName}), ''),
  NULLIF(TRIM(CONCAT_WS(' ', ${users.firstName}, ${users.lastName})), ''),
  ${users.email}
)`;

// The gift this staged row currently resolves to, if any.
const resolvedGiftId = sql<string | null>`COALESCE(
  ${stagedPayments.matchedGiftId},
  ${stagedPayments.createdGiftId},
  ${stagedPayments.groupReconciledGiftId}
)`;

// ─── POST /reconciliation/cards/:stagedPaymentId/proposals ──────────────────
// Capture a reviewer's free-text "propose alternative" comment for one card.
// Append-only: never mutates any match/donor/gift state.
router.post(
  "/reconciliation/cards/:stagedPaymentId/proposals",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const stagedPaymentId = String(req.params.stagedPaymentId);
    const body = parseOrBadRequest(
      CreateReconciliationProposalBody,
      req.body,
      res,
    );
    if (!body) return;

    const comment = body.comment.trim();
    if (comment.length === 0) {
      res.status(400).json({
        error: "validation_error",
        message: "Comment must not be empty.",
      });
      return;
    }

    const staged = await db
      .select({ id: stagedPayments.id })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, stagedPaymentId))
      .then((r) => r[0]);
    if (!staged) return notFound(res, "staged payment");

    const id = newId();
    await db.insert(reconciliationProposals).values({
      id,
      stagedPaymentId,
      comment,
      createdByUserId: user.id,
    });

    const created = await db
      .select({
        id: reconciliationProposals.id,
        stagedPaymentId: reconciliationProposals.stagedPaymentId,
        comment: reconciliationProposals.comment,
        createdByUserId: reconciliationProposals.createdByUserId,
        createdByUserName: authorName,
        createdAt: reconciliationProposals.createdAt,
      })
      .from(reconciliationProposals)
      .leftJoin(users, eq(users.id, reconciliationProposals.createdByUserId))
      .where(eq(reconciliationProposals.id, id))
      .then((r) => r[0]);

    res.status(201).json(serializeProposal(created));
  }),
);

// ─── GET /reconciliation/cards/:stagedPaymentId/proposals ───────────────────
// List one card's comments, newest first.
router.get(
  "/reconciliation/cards/:stagedPaymentId/proposals",
  asyncHandler(async (req, res) => {
    const stagedPaymentId = String(req.params.stagedPaymentId);

    const staged = await db
      .select({ id: stagedPayments.id })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, stagedPaymentId))
      .then((r) => r[0]);
    if (!staged) return notFound(res, "staged payment");

    const rows = await db
      .select({
        id: reconciliationProposals.id,
        stagedPaymentId: reconciliationProposals.stagedPaymentId,
        comment: reconciliationProposals.comment,
        createdByUserId: reconciliationProposals.createdByUserId,
        createdByUserName: authorName,
        createdAt: reconciliationProposals.createdAt,
      })
      .from(reconciliationProposals)
      .leftJoin(users, eq(users.id, reconciliationProposals.createdByUserId))
      .where(eq(reconciliationProposals.stagedPaymentId, stagedPaymentId))
      .orderBy(desc(reconciliationProposals.createdAt));

    res.json({ data: rows.map(serializeProposal) });
  }),
);

// ─── GET /reconciliation/proposals ──────────────────────────────────────────
// Cross-card feed of every comment, joined with staged-payment context, for
// later triage. Read-only.
router.get(
  "/reconciliation/proposals",
  asyncHandler(async (req, res) => {
    const stagedPaymentId =
      typeof req.query.stagedPaymentId === "string" &&
      req.query.stagedPaymentId.length > 0
        ? req.query.stagedPaymentId
        : undefined;
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const where = stagedPaymentId
      ? eq(reconciliationProposals.stagedPaymentId, stagedPaymentId)
      : undefined;

    const totalRow = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(reconciliationProposals)
      .where(where ?? sql`true`)
      .then((r) => r[0]);

    const rows = await db
      .select({
        id: reconciliationProposals.id,
        stagedPaymentId: reconciliationProposals.stagedPaymentId,
        comment: reconciliationProposals.comment,
        createdByUserId: reconciliationProposals.createdByUserId,
        createdByUserName: authorName,
        createdAt: reconciliationProposals.createdAt,
        payerName: stagedPayments.payerName,
        amount: stagedPayments.amount,
        dateReceived: stagedPayments.dateReceived,
        stagedStatus: stagedPayments.status,
        resolvedGiftId,
      })
      .from(reconciliationProposals)
      .leftJoin(users, eq(users.id, reconciliationProposals.createdByUserId))
      .leftJoin(
        stagedPayments,
        eq(stagedPayments.id, reconciliationProposals.stagedPaymentId),
      )
      .where(where ?? sql`true`)
      .orderBy(desc(reconciliationProposals.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      data: rows.map((r) => ({
        ...serializeProposal(r),
        payerName: r.payerName ?? null,
        amount: r.amount ?? null,
        dateReceived: r.dateReceived ?? null,
        stagedStatus: r.stagedStatus ?? null,
        resolvedGiftId: r.resolvedGiftId ?? null,
      })),
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total: totalRow?.count ?? 0,
      },
    });
  }),
);

interface ProposalRow {
  id: string;
  stagedPaymentId: string;
  comment: string;
  createdByUserId: string | null;
  createdByUserName: string | null;
  createdAt: Date;
}

function serializeProposal(row: ProposalRow) {
  return {
    id: row.id,
    stagedPaymentId: row.stagedPaymentId,
    comment: row.comment,
    createdByUserId: row.createdByUserId ?? null,
    createdByUserName: row.createdByUserName ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export default router;
