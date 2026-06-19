import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { stagedPayments } from "@workspace/db/schema";
import { and, count, eq } from "drizzle-orm";
import { asyncHandler, parsePagination } from "../../lib/helpers";
import {
  entityWhere,
  queueWhere,
  stagedOrderBy,
  stagedSearchWhere,
  stagedSelect,
  STAGED_SORTS,
  withJoins,
  type Queue,
  type StagedSort,
} from "./shared";

const router: IRouter = Router();

// ─── GET /staged-payments ──────────────────────────────────────────────────
router.get(
  "/staged-payments",
  asyncHandler(async (req, res) => {
    const raw = typeof req.query["queue"] === "string" ? req.query["queue"] : "";
    const queue: Queue = (
      ["needs_review", "auto_matched", "excluded", "done", "rejected"] as const
    ).includes(raw as Queue)
      ? (raw as Queue)
      : "needs_review";
    const rawSort =
      typeof req.query["sort"] === "string" ? req.query["sort"] : "";
    const sort: StagedSort = (STAGED_SORTS as readonly string[]).includes(rawSort)
      ? (rawSort as StagedSort)
      : "date_desc";
    const { limit, offset, page } = parsePagination(req.query);
    const search =
      typeof req.query["search"] === "string" ? req.query["search"].trim() : "";
    const entity =
      typeof req.query["entity"] === "string" ? req.query["entity"].trim() : "";
    const where = and(
      queueWhere(queue),
      search ? stagedSearchWhere(search) : undefined,
      entityWhere(entity),
    );

    const [rows, totalRow] = await Promise.all([
      withJoins(db.select(stagedSelect).from(stagedPayments).$dynamic())
        .where(where)
        .orderBy(...stagedOrderBy(sort))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(stagedPayments)
        .where(where)
        .then((r) => r[0]),
    ]);

    res.json({
      data: rows,
      pagination: { page, limit, total: totalRow?.value ?? 0 },
    });
  }),
);

// ─── GET /staged-payments-summary ──────────────────────────────────────────
router.get(
  "/staged-payments-summary",
  asyncHandler(async (_req, res) => {
    const [statusRows, reasonRows, autoMatchedRow] = await Promise.all([
      db
        .select({ status: stagedPayments.status, value: count() })
        .from(stagedPayments)
        .groupBy(stagedPayments.status),
      db
        .select({ reason: stagedPayments.exclusionReason, value: count() })
        .from(stagedPayments)
        .where(eq(stagedPayments.status, "excluded"))
        .groupBy(stagedPayments.exclusionReason),
      db
        .select({ value: count() })
        .from(stagedPayments)
        .where(queueWhere("auto_matched"))
        .then((r) => r[0]),
    ]);

    const byStatus = { pending: 0, approved: 0, rejected: 0, excluded: 0 };
    for (const r of statusRows) {
      if (r.status in byStatus) {
        byStatus[r.status as keyof typeof byStatus] = r.value;
      }
    }

    const excludedByReason = {
      zero_amount: 0,
      loan: 0,
      membership: 0,
      interest: 0,
      government_reimbursement: 0,
      tax_refund: 0,
      other_revenue: 0,
      earned_income: 0,
      fiscally_sponsored: 0,
      intercompany_transfer: 0,
      other: 0,
      insurance: 0,
      expense_refund: 0,
      expensify: 0,
      returned_wire: 0,
    };
    for (const r of reasonRows) {
      if (r.reason && r.reason in excludedByReason) {
        excludedByReason[r.reason as keyof typeof excludedByReason] = r.value;
      }
    }

    const autoMatched = autoMatchedRow?.value ?? 0;
    res.json({
      needsReview: byStatus.pending,
      autoMatched,
      done: byStatus.approved - autoMatched,
      rejected: byStatus.rejected,
      excluded: byStatus.excluded,
      excludedByReason,
    });
  }),
);

export default router;
