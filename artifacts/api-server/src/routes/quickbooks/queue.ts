import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { stagedPayments } from "@workspace/db/schema";
import { and, count, eq } from "drizzle-orm";
import { asyncHandler, parsePagination } from "../../lib/helpers";
import { deriveEvidenceLanes } from "../../lib/reconciliationLanes";
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
      [
        "needs_review",
        "fiscally_sponsored",
        "auto_matched",
        "excluded",
        "done",
      ] as const
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
      data: rows.map((row) => ({
        ...row,
        // Two-lane reconciliation status (INV-4), derived from existing fields.
        // The queue list does not compute candidate-gift suggestions (those live
        // on the consolidated reconciliation-card surface), so the optional
        // `giftProposed` signal is left unset here.
        reconciliationLanes: deriveEvidenceLanes({
          status: row.status,
          donorPresent:
            row.organizationId != null ||
            row.individualGiverPersonId != null ||
            row.householdId != null,
          donorConfirmed: row.matchConfirmedAt != null,
          giftLinked: row.resolvedGiftId != null,
        }),
      })),
      pagination: { page, limit, total: totalRow?.value ?? 0 },
    });
  }),
);

// ─── GET /staged-payments-summary ──────────────────────────────────────────
router.get(
  "/staged-payments-summary",
  asyncHandler(async (_req, res) => {
    const [
      excludedRow,
      reasonRows,
      doneRow,
      autoMatchedRow,
      needsReviewRow,
      fiscallySponsoredRow,
    ] = await Promise.all([
      db
        .select({ value: count() })
        .from(stagedPayments)
        .where(queueWhere("excluded"))
        .then((r) => r[0]),
      db
        .select({ reason: stagedPayments.exclusionReason, value: count() })
        .from(stagedPayments)
        .where(queueWhere("excluded"))
        .groupBy(stagedPayments.exclusionReason),
      db
        .select({ value: count() })
        .from(stagedPayments)
        .where(queueWhere("done"))
        .then((r) => r[0]),
      db
        .select({ value: count() })
        .from(stagedPayments)
        .where(queueWhere("auto_matched"))
        .then((r) => r[0]),
      // needs_review excludes fiscally sponsored money; count it via the same
      // where-clause the list uses so the badge matches the decluttered queue.
      db
        .select({ value: count() })
        .from(stagedPayments)
        .where(queueWhere("needs_review"))
        .then((r) => r[0]),
      db
        .select({ value: count() })
        .from(stagedPayments)
        .where(queueWhere("fiscally_sponsored"))
        .then((r) => r[0]),
    ]);

    const excludedByReason = {
      zero_amount: 0,
      // `loan` is a retired legacy reason kept for historical rows; new rows use
      // the split loan_repayment / loan_proceeds / note_payable reasons.
      loan: 0,
      loan_repayment: 0,
      loan_proceeds: 0,
      note_payable: 0,
      miscoded_withdrawal: 0,
      membership: 0,
      interest: 0,
      // `government_reimbursement` no longer excludes (rows flow into the queue);
      // kept here so any legacy excluded rows still surface in the summary.
      government_reimbursement: 0,
      tax_refund: 0,
      other_revenue: 0,
      earned_income: 0,
      // `fiscally_sponsored` exclusion retired (surfaced via the worklist now);
      // legacy excluded rows still counted.
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

    res.json({
      needsReview: needsReviewRow?.value ?? 0,
      fiscallySponsored: fiscallySponsoredRow?.value ?? 0,
      autoMatched: autoMatchedRow?.value ?? 0,
      // "done" = derived match_confirmed (queueWhere("done")): a gift link, a
      // confirmed settlement, or a counted ledger row (splits).
      done: doneRow?.value ?? 0,
      excluded: excludedRow?.value ?? 0,
      excludedByReason,
    });
  }),
);

export default router;
