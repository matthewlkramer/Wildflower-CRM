import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import {
  stripeStagedCharges,
  stripePayouts,
  stripeSyncState,
  stagedPayments,
  giftAllocations,
  giftsAndPayments,
  organizations,
  households,
  people,
  paymentIntermediaries,
} from "@workspace/db/schema";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { alias, type PgSelect } from "drizzle-orm/pg-core";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parsePagination,
} from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import {
  validateGiftInvariants,
  type InvariantIssue,
  ResolveStagedPaymentBody,
  ExcludeStagedPaymentBody,
} from "@workspace/api-zod";
import { buildGiftValuesFromStripeCharge } from "../lib/stripeGift";
import {
  unstampGiftFinalAmount,
  adjustSingleAllocationOrFlag,
} from "../lib/giftFinalAmount";
import { logger } from "../lib/logger";
import {
  syncStripe,
  rematchStripeCharges,
} from "../lib/stripeSync";
import {
  confirmPendingQbDeposit,
  confirmKeepApprovedQbGift,
  confirmReplaceApprovedQbGift,
  revertPayoutQbConfirmation,
  type ConfirmRevertResult,
} from "../lib/stripeConfirm";

/**
 * Review queue for incoming Stripe charges plus the manual sync / rematch
 * triggers. Mirrors the QuickBooks reconciler (routes/quickbooks.ts) but keyed
 * on Stripe ids and grouped under the payout each charge settled in.
 *
 * Queue buckets (derived from the shared status / autoApplied / matchConfirmedAt
 * columns, identical semantics to staged_payments):
 *   Needs review : status='pending'.
 *   Auto-matched : status='approved' AND autoApplied=true AND matchConfirmedAt
 *                  IS NULL — high-confidence reconciles the system applied.
 *   Done         : status='approved' a human confirmed or created.
 *   Excluded     : status='excluded' — non-gift noise.
 *   Rejected     : status='rejected'.
 *
 * Money: donors are credited the GROSS charge amount. The payout net is
 * gross − fees − refunds; the gap is processor fees (never a donor amount).
 *
 * Listing/resolving is open to any authenticated fundraiser; sync / rematch are
 * admin-gated.
 */
const router: IRouter = Router();
router.use(requireAuth);

function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
): boolean {
  const me = getAppUser(req);
  if (!me || me.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

function respondInvariantFailure(res: Response, issues: InvariantIssue[]): void {
  res.status(400).json({
    error: "validation_error",
    message: "Request validation failed",
    details: {
      issues: issues.map((i) => ({ path: [i.path], message: i.message })),
    },
  });
}

// The gift a staged charge resolved to (reconciled OR minted), for display.
const resolvedGift = alias(giftsAndPayments, "resolved_gift");

// Derived queue bucket for a staged charge (kept in sync with queueWhere below).
const queueExpr = sql<string>`
  CASE
    WHEN ${stripeStagedCharges.status} = 'excluded' THEN 'excluded'
    WHEN ${stripeStagedCharges.status} = 'rejected' THEN 'rejected'
    WHEN ${stripeStagedCharges.status} = 'pending'  THEN 'needs_review'
    WHEN ${stripeStagedCharges.status} = 'approved'
         AND ${stripeStagedCharges.autoApplied} = true
         AND ${stripeStagedCharges.matchConfirmedAt} IS NULL THEN 'auto_matched'
    ELSE 'done'
  END
`.as("queue");

// Verbatim raw Stripe charge JSON is stored for audit but excluded from every
// list/detail response — it is large and never needed by the UI.
const { rawCharge: _rawCharge, ...stagedColumns } =
  getTableColumns(stripeStagedCharges);

const stagedSelect = {
  ...stagedColumns,
  queue: queueExpr,
  organizationName: organizations.name,
  householdName: households.name,
  individualGiverPersonName: sql<string | null>`
    COALESCE(
      NULLIF(TRIM(${people.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
    )
  `.as("individual_giver_person_name"),
  intermediaryName: paymentIntermediaries.name,
  resolvedGiftId: resolvedGift.id,
  resolvedGiftName: resolvedGift.name,
  resolvedGiftAmount: resolvedGift.amount,
  resolvedGiftDate: resolvedGift.dateReceived,
  // Payout-level rollups (gross − fees − refunds = net) so the UI can group
  // charges under their payout and show the fee gap. Joined read-only.
  payoutAmount: stripePayouts.amount,
  payoutGrossTotal: stripePayouts.grossTotal,
  payoutFeeTotal: stripePayouts.feeTotal,
  payoutRefundTotal: stripePayouts.refundTotal,
  payoutNetTotal: stripePayouts.netTotal,
  payoutArrivalDate: stripePayouts.arrivalDate,
  payoutStatus: stripePayouts.status,
  // Non-destructive QuickBooks supersede audit (display-only; populated by the
  // gated supersede pass). 'conflict_approved' blocks minting a duplicate gift.
  payoutQbSupersedeStatus: stripePayouts.qbSupersedeStatus,
  payoutQbConflictGiftId: stripePayouts.qbConflictGiftId,
};

function withJoins<T extends PgSelect>(q: T) {
  return q
    .leftJoin(
      organizations,
      eq(organizations.id, stripeStagedCharges.organizationId),
    )
    .leftJoin(households, eq(households.id, stripeStagedCharges.householdId))
    .leftJoin(
      people,
      eq(people.id, stripeStagedCharges.individualGiverPersonId),
    )
    .leftJoin(
      paymentIntermediaries,
      eq(
        paymentIntermediaries.id,
        stripeStagedCharges.matchedPaymentIntermediaryId,
      ),
    )
    .leftJoin(
      resolvedGift,
      sql`${resolvedGift.id} = COALESCE(${stripeStagedCharges.matchedGiftId}, ${stripeStagedCharges.createdGiftId})`,
    )
    .leftJoin(
      stripePayouts,
      eq(stripePayouts.id, stripeStagedCharges.stripePayoutId),
    );
}

type Queue = "needs_review" | "auto_matched" | "excluded" | "done" | "rejected";

const STAGED_SORTS = [
  "date_desc",
  "date_asc",
  "amount_desc",
  "amount_asc",
  "payer_asc",
  "payer_desc",
] as const;
type StagedSort = (typeof STAGED_SORTS)[number];

function stagedOrderBy(sort: StagedSort) {
  switch (sort) {
    case "date_asc":
      return [
        asc(stripeStagedCharges.dateReceived),
        desc(stripeStagedCharges.createdAt),
      ];
    case "amount_desc":
      return [
        desc(stripeStagedCharges.grossAmount),
        desc(stripeStagedCharges.createdAt),
      ];
    case "amount_asc":
      return [
        asc(stripeStagedCharges.grossAmount),
        desc(stripeStagedCharges.createdAt),
      ];
    case "payer_asc":
      return [
        asc(stripeStagedCharges.payerName),
        desc(stripeStagedCharges.createdAt),
      ];
    case "payer_desc":
      return [
        desc(stripeStagedCharges.payerName),
        desc(stripeStagedCharges.createdAt),
      ];
    case "date_desc":
    default:
      return [
        desc(stripeStagedCharges.dateReceived),
        desc(stripeStagedCharges.createdAt),
      ];
  }
}

// Escape LIKE/ILIKE wildcards so "%"/"_" search for those literal characters.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function stagedSearchWhere(term: string) {
  const like = `%${escapeLike(term)}%`;
  return or(
    ilike(stripeStagedCharges.payerName, like),
    ilike(stripeStagedCharges.payerEmail, like),
    ilike(stripeStagedCharges.description, like),
    ilike(stripeStagedCharges.statementDescriptor, like),
  );
}

function queueWhere(queue: Queue) {
  switch (queue) {
    case "auto_matched":
      return and(
        eq(stripeStagedCharges.status, "approved"),
        eq(stripeStagedCharges.autoApplied, true),
        sql`${stripeStagedCharges.matchConfirmedAt} IS NULL`,
      );
    case "done":
      // A charge is "done" when it is settled work: an approved booking the
      // human has confirmed (or that was never auto-matched), OR a `reconciled`
      // evidence row (D4 — minted/reconciled a gift and is now permanent).
      return or(
        and(
          eq(stripeStagedCharges.status, "approved"),
          sql`(${stripeStagedCharges.matchConfirmedAt} IS NOT NULL OR ${stripeStagedCharges.autoApplied} = false)`,
        ),
        eq(stripeStagedCharges.status, "reconciled"),
      );
    case "excluded":
      return eq(stripeStagedCharges.status, "excluded");
    case "rejected":
      return eq(stripeStagedCharges.status, "rejected");
    case "needs_review":
    default:
      return eq(stripeStagedCharges.status, "pending");
  }
}

// ─── GET /stripe-staged-charges ────────────────────────────────────────────
router.get(
  "/stripe-staged-charges",
  asyncHandler(async (req, res) => {
    const raw = typeof req.query["queue"] === "string" ? req.query["queue"] : "";
    const queue: Queue = (
      ["needs_review", "auto_matched", "excluded", "done", "rejected"] as const
    ).includes(raw as Queue)
      ? (raw as Queue)
      : "needs_review";
    const rawSort =
      typeof req.query["sort"] === "string" ? req.query["sort"] : "";
    const sort: StagedSort = (STAGED_SORTS as readonly string[]).includes(
      rawSort,
    )
      ? (rawSort as StagedSort)
      : "date_desc";
    const { limit, offset, page } = parsePagination(req.query);
    const search =
      typeof req.query["search"] === "string" ? req.query["search"].trim() : "";
    const where = search
      ? and(queueWhere(queue), stagedSearchWhere(search))
      : queueWhere(queue);

    const [rows, totalRow] = await Promise.all([
      withJoins(db.select(stagedSelect).from(stripeStagedCharges).$dynamic())
        .where(where)
        .orderBy(...stagedOrderBy(sort))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(stripeStagedCharges)
        .where(where)
        .then((r) => r[0]),
    ]);

    res.json({
      data: rows,
      pagination: { page, limit, total: totalRow?.value ?? 0 },
    });
  }),
);

// ─── GET /stripe-staged-charges-summary ────────────────────────────────────
router.get(
  "/stripe-staged-charges-summary",
  asyncHandler(async (_req, res) => {
    const [statusRows, reasonRows, autoMatchedRow] = await Promise.all([
      db
        .select({ status: stripeStagedCharges.status, value: count() })
        .from(stripeStagedCharges)
        .groupBy(stripeStagedCharges.status),
      db
        .select({ reason: stripeStagedCharges.exclusionReason, value: count() })
        .from(stripeStagedCharges)
        .where(eq(stripeStagedCharges.status, "excluded"))
        .groupBy(stripeStagedCharges.exclusionReason),
      db
        .select({ value: count() })
        .from(stripeStagedCharges)
        .where(queueWhere("auto_matched"))
        .then((r) => r[0]),
    ]);

    const byStatus = {
      pending: 0,
      approved: 0,
      reconciled: 0,
      rejected: 0,
      excluded: 0,
    };
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
      // "done" = confirmed approved bookings (approved minus the auto-matched
      // still awaiting confirmation) PLUS reconciled D4 evidence rows.
      done: byStatus.approved - autoMatched + byStatus.reconciled,
      rejected: byStatus.rejected,
      excluded: byStatus.excluded,
      excludedByReason,
    });
  }),
);

// ─── POST /stripe-staged-charges/:id/resolve ───────────────────────────────
// Fundraiser fixes the donor match (sets exactly one donor FK). Keeps the row
// pending; switches matchStatus to "matched" and stamps human confirmation.
router.post(
  "/stripe-staged-charges/:id/resolve",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const parsed = ResolveStagedPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const body = parsed.data;

    const existing = await db
      .select({ status: stripeStagedCharges.status })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "stripe staged charge");
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "Only pending staged charges can be resolved.",
      });
      return;
    }

    const donor = {
      organizationId: body.organizationId ?? null,
      individualGiverPersonId: body.individualGiverPersonId ?? null,
      householdId: body.householdId ?? null,
    };
    const issues = validateGiftInvariants(donor);
    if (issues.length) return respondInvariantFailure(res, issues);

    const [row] = await db
      .update(stripeStagedCharges)
      .set({
        ...donor,
        matchStatus: "matched",
        matchMethod: "manual",
        matchedPaymentIntermediaryId: body.paymentIntermediaryId ?? null,
        matchConfirmedByUserId: user.id,
        matchConfirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stripeStagedCharges.id, id),
          eq(stripeStagedCharges.status, "pending"),
        ),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_pending",
        message: "This staged charge is no longer pending. Refresh and retry.",
      });
      return;
    }
    res.json(row);
  }),
);

// ─── POST /stripe-staged-charges/:id/create-gift ───────────────────────────
// Mint a real gifts_and_payments row (donor XOR) crediting the GROSS amount,
// then mark the staged row approved + done (autoApplied=false, human-confirmed).
router.post(
  "/stripe-staged-charges/:id/create-gift",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const existing = await db
      .select()
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "stripe staged charge");
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "This staged charge has already been resolved.",
      });
      return;
    }
    const preIssues = validateGiftInvariants({
      organizationId: existing.organizationId,
      individualGiverPersonId: existing.individualGiverPersonId,
      householdId: existing.householdId,
    });
    if (preIssues.length) return respondInvariantFailure(res, preIssues);

    const giftId = newId();
    // Lock + re-read inside the tx so the gift is always minted from the fresh
    // donor snapshot (a concurrent unmatch/resolve can change the donor while
    // status stays pending → TOCTOU).
    const NOT_PENDING = "__staged_not_pending__";
    const INVARIANT = "__staged_invariant__";
    const QB_CONFLICT = "__qb_conflict__";
    let lockedIssues: InvariantIssue[] = [];
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.id, id))
          .for("update")
          .then((r) => r[0]);
        if (!locked || locked.status !== "pending") throw new Error(NOT_PENDING);

        // Non-destructive QuickBooks reconciliation guard: if this charge's
        // payout was matched to an ALREADY-APPROVED QB net lump (a conflict
        // awaiting the human's KEEP/REPLACE decision), minting a per-charge gift
        // here would double-count. Block until that conflict is resolved in the
        // reconciliation queue (we never mutate QB data). Set by the proposal
        // pass; inert (unmatched) until a proposal lands on an approved lump.
        if (locked.stripePayoutId) {
          const payout = await tx
            .select({
              qb: stripePayouts.qbReconciliationStatus,
              conflictGiftId: stripePayouts.qbConflictGiftId,
            })
            .from(stripePayouts)
            .where(eq(stripePayouts.id, locked.stripePayoutId))
            .then((r) => r[0]);
          // Block when the payout's money is ALREADY booked as a QB-derived gift:
          // either an unresolved conflict (conflict_approved), or a confirmed
          // "keep" that left that gift in place (confirmed_reconciled WITH a
          // qbConflictGiftId pointer). A confirmed_reconciled payout whose
          // qbConflictGiftId is null reconciled a bare deposit into no gift, so
          // per-charge gifts are still the correct booking — allow it.
          if (
            payout?.qb === "conflict_approved" ||
            (payout?.qb === "confirmed_reconciled" && payout.conflictGiftId)
          ) {
            throw new Error(QB_CONFLICT);
          }
        }

        const donor = {
          organizationId: locked.organizationId,
          individualGiverPersonId: locked.individualGiverPersonId,
          householdId: locked.householdId,
        };
        const issues = validateGiftInvariants(donor);
        if (issues.length) {
          lockedIssues = issues;
          throw new Error(INVARIANT);
        }
        await tx.insert(giftsAndPayments).values(
          buildGiftValuesFromStripeCharge(
            giftId,
            {
              chargeId: locked.id,
              grossAmount: locked.grossAmount,
              feeAmount: locked.feeAmount,
              dateReceived: locked.dateReceived,
              payerName: locked.payerName,
              description: locked.description,
              organizationId: donor.organizationId,
              individualGiverPersonId: donor.individualGiverPersonId,
              householdId: donor.householdId,
              matchedPaymentIntermediaryId: locked.matchedPaymentIntermediaryId,
            },
            user.id,
          ),
        );
        await tx
          .update(stripeStagedCharges)
          .set({
            // D4: this charge is now permanent EVIDENCE tied to the gift it
            // minted — `reconciled`, never `approved` (which the queues treat as
            // a still-actionable booking).
            status: "reconciled",
            createdGiftId: giftId,
            matchedGiftId: null,
            autoApplied: false,
            matchStatus: "matched",
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: new Date(),
            approvedByUserId: user.id,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(stripeStagedCharges.id, id));
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_PENDING) {
        res.status(409).json({
          error: "not_pending",
          message: "This staged charge has already been resolved.",
        });
        return;
      }
      if (e instanceof Error && e.message === QB_CONFLICT) {
        res.status(409).json({
          error: "qb_conflict",
          message:
            "This payout is already booked as an approved QuickBooks lump. Resolve the QuickBooks side before creating per-charge gifts.",
        });
        return;
      }
      if (e instanceof Error && e.message === INVARIANT) {
        return respondInvariantFailure(res, lockedIssues);
      }
      throw e;
    }

    const [gift] = await db
      .select()
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId));
    res.status(201).json({ gift, stagedPaymentId: id });
  }),
);

// ─── POST /stripe-staged-charges/:id/reject ────────────────────────────────
router.post(
  "/stripe-staged-charges/:id/reject",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const existing = await db
      .select({ status: stripeStagedCharges.status })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "stripe staged charge");
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "This staged charge has already been resolved.",
      });
      return;
    }
    const [row] = await db
      .update(stripeStagedCharges)
      .set({
        status: "rejected",
        rejectedByUserId: user.id,
        rejectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stripeStagedCharges.id, id),
          eq(stripeStagedCharges.status, "pending"),
        ),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_pending",
        message: "This staged charge has already been resolved.",
      });
      return;
    }
    res.json(row);
  }),
);

// ─── POST /stripe-staged-charges/:id/exclude ───────────────────────────────
// Human-driven exclude: file a staged charge under a non-gift category. Pins
// classificationSource='manual'. Allowed from pending or excluded (reclassify).
router.post(
  "/stripe-staged-charges/:id/exclude",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const parsed = ExcludeStagedPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { exclusionReason } = parsed.data;

    const existing = await db
      .select({ status: stripeStagedCharges.status })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "stripe staged charge");
    if (existing.status !== "pending" && existing.status !== "excluded") {
      res.status(409).json({
        error: "not_excludable",
        message:
          "Only a pending or already-excluded staged charge can be excluded.",
      });
      return;
    }

    const [row] = await db
      .update(stripeStagedCharges)
      .set({
        status: "excluded",
        exclusionReason,
        classificationSource: "manual",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stripeStagedCharges.id, id),
          or(
            eq(stripeStagedCharges.status, "pending"),
            eq(stripeStagedCharges.status, "excluded"),
          ),
        ),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_excludable",
        message: "This staged charge can no longer be excluded. Refresh.",
      });
      return;
    }
    res.json(row);
  }),
);

// ─── POST /stripe-staged-charges/:id/re-include ────────────────────────────
// Move an excluded row back to pending (false positive). Pins
// classificationSource='manual' so the re-runnable classifier never re-excludes.
router.post(
  "/stripe-staged-charges/:id/re-include",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const existing = await db
      .select({ status: stripeStagedCharges.status })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "stripe staged charge");
    if (existing.status !== "excluded") {
      res.status(409).json({
        error: "not_excluded",
        message: "Only excluded staged charges can be re-included.",
      });
      return;
    }
    const [row] = await db
      .update(stripeStagedCharges)
      .set({
        status: "pending",
        exclusionReason: null,
        classificationSource: "manual",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stripeStagedCharges.id, id),
          eq(stripeStagedCharges.status, "excluded"),
        ),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_excluded",
        message: "This staged charge is no longer excluded. Refresh and retry.",
      });
      return;
    }
    res.json(row);
  }),
);

// ─── POST /stripe-staged-charges/:id/revert ────────────────────────────────
// Undo an approved row: unlink a reconciled gift (leave the gift intact) or
// delete a gift this row minted (clearing its allocations first — the gift
// belongs solely to this charge), returning the row to the pending queue.
router.post(
  "/stripe-staged-charges/:id/revert",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);

    const NOT_FOUND = "__not_found__";
    const NOT_REVERTIBLE = "__not_revertible__";
    let reverted: typeof stripeStagedCharges.$inferSelect | null = null;
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.id, id))
          .for("update")
          .then((r) => r[0]);
        if (!locked) throw new Error(NOT_FOUND);
        // D4: a row that minted/reconciled a gift is now `reconciled` evidence;
        // legacy approved rows are still revertible too.
        if (locked.status !== "approved" && locked.status !== "reconciled") {
          throw new Error(NOT_REVERTIBLE);
        }

        const hasDonor =
          !!locked.organizationId ||
          !!locked.individualGiverPersonId ||
          !!locked.householdId;
        const newMatchStatus = hasDonor ? "suggested" : "unmatched";

        if (locked.createdGiftId) {
          // This row minted the gift — remove it. Clear allocations first
          // (gift_allocations FK is RESTRICT; every gift has >= 1 only after a
          // human allocates). The gift is gone, so there's no stamp to unwind.
          await tx
            .delete(giftAllocations)
            .where(eq(giftAllocations.giftId, locked.createdGiftId));
          await tx
            .delete(giftsAndPayments)
            .where(eq(giftsAndPayments.id, locked.createdGiftId));
        } else if (locked.matchedGiftId) {
          // This row reconciled to an EXISTING gift — leave the gift in place but
          // undo any final-amount stamp THIS charge applied to it (strict no-op
          // unless the gift is still sourced from this exact charge), then
          // rebalance its allocations to the restored amount.
          const giftId = locked.matchedGiftId;
          const unstamped = await unstampGiftFinalAmount(tx, giftId, {
            source: "stripe",
            stripeChargeId: locked.id,
          });
          if (unstamped.restored) {
            await adjustSingleAllocationOrFlag(
              tx,
              giftId,
              unstamped.oldAmount,
              unstamped.newAmount,
              "stripe",
            );
          }
        } else {
          // Approved/reconciled with no gift linkage of its own — nothing to revert.
          throw new Error(NOT_REVERTIBLE);
        }

        const [row] = await tx
          .update(stripeStagedCharges)
          .set({
            status: "pending",
            matchedGiftId: null,
            createdGiftId: null,
            autoApplied: false,
            matchStatus: newMatchStatus,
            matchConfirmedAt: null,
            matchConfirmedByUserId: null,
            approvedAt: null,
            approvedByUserId: null,
            updatedAt: new Date(),
          })
          .where(eq(stripeStagedCharges.id, id))
          .returning();
        reverted = row ?? null;
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_FOUND) {
        return notFound(res, "stripe staged charge");
      }
      if (e instanceof Error && e.message === NOT_REVERTIBLE) {
        res.status(409).json({
          error: "not_revertible",
          message:
            "Only an auto-matched row or a row that minted/reconciled a gift can be reverted.",
        });
        return;
      }
      throw e;
    }
    void user;
    res.json(reverted);
  }),
);

// ─── POST /stripe/sync ─────────────────────────────────────────────────────
router.post(
  "/stripe/sync",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await syncStripe();
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "Stripe manual sync failed");
      res.status(502).json({
        error: "sync_failed",
        message: e instanceof Error ? e.message : "Stripe sync failed",
      });
    }
  }),
);

// ─── POST /stripe/rematch ──────────────────────────────────────────────────
router.post(
  "/stripe/rematch",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await rematchStripeCharges();
      req.log.info(
        { ran: summary.ran, scanned: summary.scanned, matched: summary.matched },
        "Stripe staged-charge rematch run",
      );
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "Stripe rematch failed");
      res.status(502).json({
        error: "rematch_failed",
        message: e instanceof Error ? e.message : "Stripe rematch failed",
      });
    }
  }),
);

// ─── GET /stripe/sync-status ───────────────────────────────────────────────
router.get(
  "/stripe/sync-status",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = await db.select().from(stripeSyncState);
    const state = rows[0] ?? null;
    res.json({
      configured: rows.length > 0,
      lastRunAt: state?.lastRunAt ?? null,
      lastRunStatus: state?.lastRunStatus ?? null,
      lastError: state?.lastError ?? null,
      consecutiveErrors: state?.consecutiveErrors ?? 0,
      payoutCreatedWatermark: state?.payoutCreatedWatermark ?? null,
    });
  }),
);

// ─── Stripe payout ↔ QuickBooks reconciliation queue ───────────────────────
// The proposal pass (stripeReconcile.ts) classifies each payout against the QB
// deposit lumps; humans confirm/revert here (stripeConfirm.ts). This queue lists
// payouts that need or have had a reconciliation decision. Under D4 a confirm
// stamps the gift's final amount and marks its QB/Stripe evidence `reconciled`
// (permanent — never archived or excluded); nothing changes until a human
// confirms — propose-then-confirm. The legacy confirmed_excluded/keep/replace
// statuses survive only to revert rows confirmed under the pre-D4 model.

type ReconQueue = "proposed" | "conflict" | "confirmed" | "all";
const RECON_QUEUES = ["proposed", "conflict", "confirmed", "all"] as const;
const CONFIRMED_STATUSES = [
  "confirmed_reconciled",
  "confirmed_excluded",
  "confirmed_keep",
  "confirmed_replace",
] as const;

function reconQueueWhere(queue: ReconQueue) {
  switch (queue) {
    case "proposed":
      return eq(stripePayouts.qbReconciliationStatus, "proposed");
    case "conflict":
      return eq(stripePayouts.qbReconciliationStatus, "conflict_approved");
    case "confirmed":
      return inArray(stripePayouts.qbReconciliationStatus, [
        ...CONFIRMED_STATUSES,
      ]);
    case "all":
      return inArray(stripePayouts.qbReconciliationStatus, [
        "proposed",
        "conflict_approved",
        ...CONFIRMED_STATUSES,
      ]);
  }
}

// The QB deposit currently relevant to the payout's state (matched once
// confirmed, else the proposed/conflicting candidate), and the already-approved
// gift a conflict would replace, joined read-only for display.
const activeDeposit = alias(stagedPayments, "active_deposit");
const conflictGift = alias(giftsAndPayments, "conflict_gift");
const conflictOrg = alias(organizations, "conflict_org");
const conflictHousehold = alias(households, "conflict_household");
const conflictPerson = alias(people, "conflict_person");

const reconSelect = {
  ...getTableColumns(stripePayouts),
  depositId: activeDeposit.id,
  depositAmount: activeDeposit.amount,
  depositDateReceived: activeDeposit.dateReceived,
  depositPayerName: activeDeposit.payerName,
  depositStatus: activeDeposit.status,
  conflictGiftAmount: conflictGift.amount,
  conflictGiftDate: conflictGift.dateReceived,
  conflictGiftArchivedAt: conflictGift.archivedAt,
  conflictGiftDonorName: sql<string | null>`
    COALESCE(
      ${conflictOrg.name},
      ${conflictHousehold.name},
      NULLIF(TRIM(${conflictPerson.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${conflictPerson.firstName}, ${conflictPerson.lastName})), '')
    )
  `.as("conflict_gift_donor_name"),
};

// ─── GET /stripe-payouts/reconciliation ────────────────────────────────────
router.get(
  "/stripe-payouts/reconciliation",
  asyncHandler(async (req, res) => {
    const raw =
      typeof req.query["queue"] === "string" ? req.query["queue"] : "";
    const queue: ReconQueue = (RECON_QUEUES as readonly string[]).includes(raw)
      ? (raw as ReconQueue)
      : "proposed";
    const { limit, offset, page } = parsePagination(req.query);
    const where = reconQueueWhere(queue);

    const [rows, totalRow] = await Promise.all([
      db
        .select(reconSelect)
        .from(stripePayouts)
        .leftJoin(
          activeDeposit,
          sql`${activeDeposit.id} = COALESCE(${stripePayouts.matchedQbStagedPaymentId}, ${stripePayouts.proposedQbStagedPaymentId}, ${stripePayouts.qbConflictStagedPaymentId})`,
        )
        .leftJoin(conflictGift, eq(conflictGift.id, stripePayouts.qbConflictGiftId))
        .leftJoin(conflictOrg, eq(conflictOrg.id, conflictGift.organizationId))
        .leftJoin(
          conflictHousehold,
          eq(conflictHousehold.id, conflictGift.householdId),
        )
        .leftJoin(
          conflictPerson,
          eq(conflictPerson.id, conflictGift.individualGiverPersonId),
        )
        .where(where)
        .orderBy(desc(stripePayouts.arrivalDate), desc(stripePayouts.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(stripePayouts)
        .where(where)
        .then((r) => r[0]),
    ]);

    res.json({
      data: rows,
      pagination: { page, limit, total: totalRow?.value ?? 0 },
    });
  }),
);

// Map a stripeConfirm discriminated result onto an HTTP response. not_found →
// 404; every other typed transition failure (stale state, charges booked) → 409.
function respondReconResult(res: Response, result: ConfirmRevertResult): void {
  if (result.ok) {
    res.json(result);
    return;
  }
  res
    .status(result.code === "not_found" ? 404 : 409)
    .json({ error: result.code, message: result.message });
}

// ─── POST /stripe-payouts/:id/confirm-exclude ──────────────────────────────
// proposed → confirmed_reconciled (D4): mark the pending QB deposit lump
// `reconciled` — permanent evidence, no longer excluded (processor_payout) or
// archived — and link it to this payout. (Route path is kept for client
// compatibility; the deposit is reconciled, not excluded.)
router.post(
  "/stripe-payouts/:id/confirm-exclude",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    respondReconResult(
      res,
      await confirmPendingQbDeposit({ payoutId: paramId(req), userId: user.id }),
    );
  }),
);

// ─── POST /stripe-payouts/:id/confirm-keep ─────────────────────────────────
// conflict_approved → confirmed_reconciled (D4): the existing approved QB gift
// stands; we only record the payout linkage. Touches no gift or deposit.
router.post(
  "/stripe-payouts/:id/confirm-keep",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    respondReconResult(
      res,
      await confirmKeepApprovedQbGift({ payoutId: paramId(req), userId: user.id }),
    );
  }),
);

// ─── POST /stripe-payouts/:id/confirm-replace ──────────────────────────────
// Retired under D4: the coarse QB-derived gift is never archived/replaced — a
// genuine coarse-vs-granular conflict returns manual_review_required (409).
// Route kept for client compatibility and to revert rows confirmed
// (confirmed_replace) under the pre-D4 model.
router.post(
  "/stripe-payouts/:id/confirm-replace",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    respondReconResult(
      res,
      await confirmReplaceApprovedQbGift({
        payoutId: paramId(req),
        userId: user.id,
      }),
    );
  }),
);

// ─── POST /stripe-payouts/:id/revert-reconciliation ────────────────────────
// Undo a confirm back to its prior proposal state. A confirmed_replace revert is
// refused (409 charges_already_booked) once any of the payout's Stripe charges
// have been booked into a gift.
router.post(
  "/stripe-payouts/:id/revert-reconciliation",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    respondReconResult(
      res,
      await revertPayoutQbConfirmation({
        payoutId: paramId(req),
        userId: user.id,
      }),
    );
  }),
);

export default router;
