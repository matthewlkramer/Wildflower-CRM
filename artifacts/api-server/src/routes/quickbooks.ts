import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
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
  notInArray,
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
import { validateGiftInvariants, type InvariantIssue } from "@workspace/api-zod";
import {
  ResolveStagedPaymentBody,
  ReconcileStagedPaymentBody,
  GroupReconcileStagedPaymentsBody,
  ExcludeStagedPaymentBody,
} from "@workspace/api-zod";
import { donorOf, hasExactlyOneDonor } from "../lib/quickbooksLink";
import { buildGiftValuesFromStaged } from "../lib/quickbooksGift";
import { logger } from "../lib/logger";
import {
  syncQuickbooks,
  rematchStagedPayments,
  reclassifyStagedPayments,
} from "../lib/quickbooksSync";

/**
 * Review queue for QuickBooks-sourced payments plus the manual sync / rematch /
 * reclassify triggers. The queue is organized into three derived buckets:
 *
 *   Auto-matched : status='approved' AND autoApplied=true AND
 *                  matchConfirmedAt IS NULL — high-confidence matches the system
 *                  already applied (reconciled to an existing gift OR minted a
 *                  new one). Reversible.
 *   Needs review : status='pending' — uncertain; nothing applied to the ledger.
 *   Excluded     : status='excluded' — non-donation noise (auto or manual).
 *   (Done        : status='approved' that a human confirmed or created.)
 *
 * Listing/resolving is open to any authenticated fundraiser; sync / rematch /
 * reclassify are admin-gated. The connection itself is admin-gated in
 * quickbooksOauth.ts.
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

// The gift a staged row resolved to (reconciled OR minted), for display.
const resolvedGift = alias(giftsAndPayments, "resolved_gift");

// Derived queue bucket for a staged row (kept in sync with the where-clauses
// in queueWhere below).
const queueExpr = sql<string>`
  CASE
    WHEN ${stagedPayments.status} = 'excluded' THEN 'excluded'
    WHEN ${stagedPayments.status} = 'rejected' THEN 'rejected'
    WHEN ${stagedPayments.status} = 'pending'  THEN 'needs_review'
    WHEN ${stagedPayments.status} = 'approved'
         AND ${stagedPayments.autoApplied} = true
         AND ${stagedPayments.matchConfirmedAt} IS NULL THEN 'auto_matched'
    ELSE 'done'
  END
`.as("queue");

// Donor + resolved-gift + intermediary display fields joined for the queue UI.
const stagedSelect = {
  ...getTableColumns(stagedPayments),
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
  // "Looks like a 2nd payment for one gift": this row has no gift of its own,
  // and every same-donor / similar-amount gift is already linked to a DIFFERENT
  // staged payment (no unlinked candidate is left to match). Signals the
  // fundraiser to create a new gift (or exclude a true duplicate) rather than
  // trusting a high match score that points at an already-claimed gift.
  giftAlreadyLinkedElsewhere: sql<boolean>`(
    ${stagedPayments.matchedGiftId} IS NULL
    AND ${stagedPayments.createdGiftId} IS NULL
    AND ${stagedPayments.amount} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM gifts_and_payments g
      WHERE (
        (${stagedPayments.organizationId} IS NOT NULL AND g.organization_id = ${stagedPayments.organizationId})
        OR (${stagedPayments.individualGiverPersonId} IS NOT NULL AND g.individual_giver_person_id = ${stagedPayments.individualGiverPersonId})
        OR (${stagedPayments.householdId} IS NOT NULL AND g.household_id = ${stagedPayments.householdId})
      )
      AND g.amount >= ${stagedPayments.amount}::numeric - 0.01
      AND g.amount <= ${stagedPayments.amount}::numeric * 1.10 + 1
      AND EXISTS (
        SELECT 1 FROM staged_payments sp2
        WHERE (sp2.matched_gift_id = g.id OR sp2.created_gift_id = g.id)
          AND sp2.id <> ${stagedPayments.id}
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM gifts_and_payments g2
      WHERE (
        (${stagedPayments.organizationId} IS NOT NULL AND g2.organization_id = ${stagedPayments.organizationId})
        OR (${stagedPayments.individualGiverPersonId} IS NOT NULL AND g2.individual_giver_person_id = ${stagedPayments.individualGiverPersonId})
        OR (${stagedPayments.householdId} IS NOT NULL AND g2.household_id = ${stagedPayments.householdId})
      )
      AND g2.amount >= ${stagedPayments.amount}::numeric - 0.01
      AND g2.amount <= ${stagedPayments.amount}::numeric * 1.10 + 1
      AND NOT EXISTS (
        SELECT 1 FROM staged_payments sp3
        WHERE (sp3.matched_gift_id = g2.id OR sp3.created_gift_id = g2.id)
      )
    )
  )`.as("gift_already_linked_elsewhere"),
};

function withJoins<T extends PgSelect>(q: T) {
  return q
    .leftJoin(organizations, eq(organizations.id, stagedPayments.organizationId))
    .leftJoin(households, eq(households.id, stagedPayments.householdId))
    .leftJoin(people, eq(people.id, stagedPayments.individualGiverPersonId))
    .leftJoin(
      paymentIntermediaries,
      eq(paymentIntermediaries.id, stagedPayments.matchedPaymentIntermediaryId),
    )
    .leftJoin(
      resolvedGift,
      sql`${resolvedGift.id} = COALESCE(${stagedPayments.matchedGiftId}, ${stagedPayments.createdGiftId}, ${stagedPayments.groupReconciledGiftId})`,
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

// Column ordering for the reconciler's sort dropdown. createdAt is the stable
// tiebreak so paging is deterministic within a sort key.
function stagedOrderBy(sort: StagedSort) {
  switch (sort) {
    case "date_asc":
      return [asc(stagedPayments.dateReceived), desc(stagedPayments.createdAt)];
    case "amount_desc":
      return [desc(stagedPayments.amount), desc(stagedPayments.createdAt)];
    case "amount_asc":
      return [asc(stagedPayments.amount), desc(stagedPayments.createdAt)];
    case "payer_asc":
      return [asc(stagedPayments.payerName), desc(stagedPayments.createdAt)];
    case "payer_desc":
      return [desc(stagedPayments.payerName), desc(stagedPayments.createdAt)];
    case "date_desc":
    default:
      return [desc(stagedPayments.dateReceived), desc(stagedPayments.createdAt)];
  }
}

// Escape LIKE/ILIKE wildcards so a user typing "%" or "_" searches for those
// literal characters instead of matching (nearly) everything. PostgreSQL's
// default ILIKE escape character is the backslash, so escaping the input is
// enough — no explicit ESCAPE clause needed.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Free-text filter for the reconciler's LEFT pane. Matches the payer, the raw
// memo/reference, the single-line description, and any of the line-detail array
// fields (items / accounts / classes). Array columns are flattened with
// array_to_string so a substring match works across all elements at once.
function stagedSearchWhere(term: string) {
  const like = `%${escapeLike(term)}%`;
  return or(
    ilike(stagedPayments.payerName, like),
    ilike(stagedPayments.rawReference, like),
    ilike(stagedPayments.lineDescription, like),
    sql`array_to_string(COALESCE(${stagedPayments.lineItemNames}, '{}'), ' ') ILIKE ${like}`,
    sql`array_to_string(COALESCE(${stagedPayments.lineAccountNames}, '{}'), ' ') ILIKE ${like}`,
    sql`array_to_string(COALESCE(${stagedPayments.lineClasses}, '{}'), ' ') ILIKE ${like}`,
  );
}

function queueWhere(queue: Queue) {
  switch (queue) {
    case "auto_matched":
      return and(
        eq(stagedPayments.status, "approved"),
        eq(stagedPayments.autoApplied, true),
        sql`${stagedPayments.matchConfirmedAt} IS NULL`,
      );
    case "done":
      return and(
        eq(stagedPayments.status, "approved"),
        sql`(${stagedPayments.matchConfirmedAt} IS NOT NULL OR ${stagedPayments.autoApplied} = false)`,
      );
    case "excluded":
      return eq(stagedPayments.status, "excluded");
    case "rejected":
      return eq(stagedPayments.status, "rejected");
    case "needs_review":
    default:
      return eq(stagedPayments.status, "pending");
  }
}

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
    const where = search
      ? and(queueWhere(queue), stagedSearchWhere(search))
      : queueWhere(queue);

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

// ─── POST /staged-payments/:id/resolve ─────────────────────────────────────
// Fundraiser fixes the donor match (sets exactly one donor FK). Keeps the row
// pending; switches matchStatus to "matched" and stamps human confirmation.
router.post(
  "/staged-payments/:id/resolve",
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
      .select({ status: stagedPayments.status })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "Only pending staged payments can be resolved.",
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
      .update(stagedPayments)
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
        and(eq(stagedPayments.id, id), eq(stagedPayments.status, "pending")),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_pending",
        message: "This staged payment is no longer pending. Refresh and retry.",
      });
      return;
    }
    res.json(row);
  }),
);

// ─── POST /staged-payments/:id/create-gift ─────────────────────────────────
// Mint a real gifts_and_payments row from the staged payment (donor XOR), then
// mark the staged row approved + done (autoApplied=false, human-confirmed).
router.post(
  "/staged-payments/:id/create-gift",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const existing = await db
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "This staged payment has already been resolved.",
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
    // Lock + re-read the row inside the tx so the gift is always minted from
    // the *fresh* donor snapshot (a concurrent unmatch/resolve can change the
    // donor while status stays pending → TOCTOU).
    const NOT_PENDING = "__staged_not_pending__";
    const INVARIANT = "__staged_invariant__";
    let lockedIssues: InvariantIssue[] = [];
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(stagedPayments)
          .where(eq(stagedPayments.id, id))
          .for("update")
          .then((r) => r[0]);
        if (!locked || locked.status !== "pending") throw new Error(NOT_PENDING);
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
          buildGiftValuesFromStaged(
            giftId,
            {
              qbEntityType: locked.qbEntityType,
              qbEntityId: locked.qbEntityId,
              amount: locked.amount,
              dateReceived: locked.dateReceived,
              payerName: locked.payerName,
              rawReference: locked.rawReference,
              organizationId: donor.organizationId,
              individualGiverPersonId: donor.individualGiverPersonId,
              householdId: donor.householdId,
              matchedPaymentIntermediaryId: locked.matchedPaymentIntermediaryId,
            },
            user.id,
          ),
        );
        await tx
          .update(stagedPayments)
          .set({
            status: "approved",
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
          .where(eq(stagedPayments.id, id));
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_PENDING) {
        res.status(409).json({
          error: "not_pending",
          message: "This staged payment has already been resolved.",
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

// ─── POST /staged-payments/:id/reject ──────────────────────────────────────
router.post(
  "/staged-payments/:id/reject",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const existing = await db
      .select({ status: stagedPayments.status })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "This staged payment has already been resolved.",
      });
      return;
    }
    const [row] = await db
      .update(stagedPayments)
      .set({
        status: "rejected",
        rejectedByUserId: user.id,
        rejectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(stagedPayments.id, id), eq(stagedPayments.status, "pending")),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_pending",
        message: "This staged payment has already been resolved.",
      });
      return;
    }
    res.json(row);
  }),
);

// ─── POST /staged-payments/:id/re-include ──────────────────────────────────
// Move an excluded row back to the pending queue (false positive). Pins
// classificationSource='manual' so the re-runnable classifier never re-excludes
// it. Only an excluded row can be re-included.
router.post(
  "/staged-payments/:id/re-include",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const existing = await db
      .select({ status: stagedPayments.status })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");
    if (existing.status !== "excluded") {
      res.status(409).json({
        error: "not_excluded",
        message: "Only excluded staged payments can be re-included.",
      });
      return;
    }
    const [row] = await db
      .update(stagedPayments)
      .set({
        status: "pending",
        exclusionReason: null,
        classificationSource: "manual",
        updatedAt: new Date(),
      })
      .where(
        and(eq(stagedPayments.id, id), eq(stagedPayments.status, "excluded")),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_excluded",
        message: "This staged payment is no longer excluded. Refresh and retry.",
      });
      return;
    }
    res.json(row);
  }),
);

// ─── POST /staged-payments/:id/exclude ─────────────────────────────────────
// Human-driven exclude: file a staged row under a non-gift category and move it
// to the excluded bucket. Pins classificationSource='manual' so it survives the
// re-runnable classifier. Allowed from pending or excluded (reclassify).
router.post(
  "/staged-payments/:id/exclude",
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
      .select({ status: stagedPayments.status })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");
    if (existing.status !== "pending" && existing.status !== "excluded") {
      res.status(409).json({
        error: "not_excludable",
        message:
          "Only pending or already-excluded staged payments can be excluded.",
      });
      return;
    }

    const [row] = await db
      .update(stagedPayments)
      .set({
        status: "excluded",
        exclusionReason,
        classificationSource: "manual",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stagedPayments.id, id),
          sql`${stagedPayments.status} IN ('pending', 'excluded')`,
        ),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_excludable",
        message:
          "This staged payment changed before it could be excluded. Refresh and retry.",
      });
      return;
    }
    res.json(row);
  }),
);

// Shared candidate-gift select (donor names + already-linked flag).
function giftCandidateSelect(excludeStagedId: string) {
  return {
    ...getTableColumns(giftsAndPayments),
    organizationName: organizations.name,
    householdName: households.name,
    individualGiverPersonName: people.fullName,
    alreadyLinkedStagedPaymentId: sql<string | null>`(
      SELECT sp2.id FROM staged_payments sp2
      WHERE (sp2.matched_gift_id = ${giftsAndPayments.id}
             OR sp2.created_gift_id = ${giftsAndPayments.id})
        AND sp2.id <> ${excludeStagedId}
      LIMIT 1
    )`,
  };
}

function giftCandidateJoins<T extends PgSelect>(q: T) {
  return q
    .leftJoin(
      organizations,
      eq(organizations.id, giftsAndPayments.organizationId),
    )
    .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
    .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId));
}

// ─── GET /staged-payments/:id/gift-candidates ──────────────────────────────
// Existing gifts for the staged row's saved donor whose amount is at or just
// above the staged amount (a Donorbox-style processor fee makes the CRM gross
// gift slightly larger than the QB net deposit). Empty when no donor/amount.
router.get(
  "/staged-payments/:id/gift-candidates",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const staged = await db
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!staged) return notFound(res, "staged payment");

    const donor = donorOf(staged);
    const donorFilter =
      donor.organizationId != null
        ? eq(giftsAndPayments.organizationId, donor.organizationId)
        : donor.individualGiverPersonId != null
          ? eq(
              giftsAndPayments.individualGiverPersonId,
              donor.individualGiverPersonId,
            )
          : donor.householdId != null
            ? eq(giftsAndPayments.householdId, donor.householdId)
            : null;

    if (donorFilter == null || staged.amount == null) {
      res.json({ data: [] });
      return;
    }

    const rows = await giftCandidateJoins(
      db.select(giftCandidateSelect(id)).from(giftsAndPayments).$dynamic(),
    )
      .where(
        and(
          donorFilter,
          sql`${giftsAndPayments.amount} >= ${staged.amount}::numeric - 0.01`,
          sql`${giftsAndPayments.amount} <= ${staged.amount}::numeric * 1.10 + 1`,
        ),
      )
      .orderBy(
        sql`ABS(${giftsAndPayments.amount} - ${staged.amount}::numeric) ASC`,
        sql`ABS(${giftsAndPayments.dateReceived} - ${staged.dateReceived}::date) ASC NULLS LAST`,
        desc(giftsAndPayments.dateReceived),
      )
      .limit(50);

    res.json({ data: rows });
  }),
);

// ─── GET /staged-payments/:id/gift-window ──────────────────────────────────
// Donor-AGNOSTIC entry point: existing gifts across ALL donors whose amount and
// date sit in a window around the staged payment. Lets a fundraiser reconcile
// to a gift even when the donor wasn't auto-resolved. Empty when no amount.
router.get(
  "/staged-payments/:id/gift-window",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const staged = await db
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!staged) return notFound(res, "staged payment");
    if (staged.amount == null) {
      res.json({ data: [] });
      return;
    }
    const days = Math.min(
      365,
      Math.max(
        1,
        Number(
          typeof req.query["days"] === "string" ? req.query["days"] : 30,
        ) || 30,
      ),
    );

    const dateClause = staged.dateReceived
      ? sql`AND (${giftsAndPayments.dateReceived} IS NULL OR ABS(${giftsAndPayments.dateReceived} - ${staged.dateReceived}::date) <= ${days})`
      : sql``;

    const rows = await giftCandidateJoins(
      db.select(giftCandidateSelect(id)).from(giftsAndPayments).$dynamic(),
    )
      .where(
        and(
          sql`${giftsAndPayments.amount} >= ${staged.amount}::numeric - 0.01`,
          sql`${giftsAndPayments.amount} <= ${staged.amount}::numeric * 1.10 + 1`,
          dateClause,
        ),
      )
      .orderBy(
        sql`ABS(${giftsAndPayments.amount} - ${staged.amount}::numeric) ASC`,
        sql`ABS(${giftsAndPayments.dateReceived} - ${staged.dateReceived}::date) ASC NULLS LAST`,
        desc(giftsAndPayments.dateReceived),
      )
      .limit(50);

    res.json({ data: rows });
  }),
);

// ─── GET /staged-payments-donor-search ─────────────────────────────────────
// Trigram donor search across organizations / people / households for the
// reconciler's manual donor picker.
router.get(
  "/staged-payments-donor-search",
  asyncHandler(async (req, res) => {
    const q =
      typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
    if (q.length < 2) {
      res.json({ data: [] });
      return;
    }
    const rows = (
      await db.execute(sql`
        SELECT id, kind, name, sim FROM (
          SELECT id, 'organization' AS kind, name AS name,
                 similarity(name, ${q}) AS sim
            FROM organizations WHERE name % ${q}
          UNION ALL
          SELECT id, 'person' AS kind, full_name AS name,
                 similarity(full_name, ${q}) AS sim
            FROM people WHERE full_name IS NOT NULL AND full_name % ${q}
          UNION ALL
          SELECT id, 'household' AS kind, name AS name,
                 similarity(name, ${q}) AS sim
            FROM households WHERE name % ${q}
        ) t
        ORDER BY sim DESC
        LIMIT 20
      `)
    ).rows as Array<{ id: string; kind: string; name: string }>;
    res.json({ data: rows });
  }),
);

// ─── POST /staged-payments/:id/reconcile ───────────────────────────────────
// Tie a staged payment to an EXISTING gift (no new gift minted). Sets
// matchedGiftId → the chosen gift, status approved, autoApplied=false. An
// explicit human Match treats the selected gift as authoritative: the staged
// row ADOPTS the gift's donor, overriding any auto-guessed donor. Guards: row
// pending, gift exists with a single valid donor, gift not already linked.
router.post(
  "/staged-payments/:id/reconcile",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const parsed = ReconcileStagedPaymentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { giftId } = parsed.data;

    const existing = await db
      .select()
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "This staged payment has already been resolved.",
      });
      return;
    }

    const gift = await db
      .select()
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId))
      .then((r) => r[0]);
    if (!gift) return notFound(res, "gift");

    // An explicit human Match treats the selected gift as authoritative: adopt
    // the gift's donor onto the staged row, overriding any auto-guessed donor
    // (e.g. a deposit auto-matched to an individual can link to that person's
    // household gift). Guard only that the gift itself carries a single valid
    // donor so the staged row keeps the Donor XOR invariant.
    const giftDonor = donorOf(gift);
    if (!hasExactlyOneDonor(giftDonor)) {
      res.status(400).json({
        error: "link_invalid",
        message: "Cannot reconcile this staged payment to that gift.",
        details: {
          issues: [
            {
              path: ["giftId"],
              message: "The selected gift has no donor to adopt.",
            },
          ],
        },
      });
      return;
    }
    const finalDonor = giftDonor;

    // Atomic: only succeeds if still pending AND no other staged row has grabbed
    // this gift (matched or created) since the pre-check. NOT EXISTS handles the
    // common case; the partial-unique index on matched_gift_id backstops a true
    // write-skew race (caught below as a 409).
    let updated: Array<{ id: string }>;
    try {
      updated = await db
        .update(stagedPayments)
        .set({
          ...finalDonor,
          status: "approved",
          matchedGiftId: giftId,
          createdGiftId: null,
          autoApplied: false,
          matchStatus: "matched",
          matchConfirmedByUserId: user.id,
          matchConfirmedAt: new Date(),
          approvedByUserId: user.id,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stagedPayments.id, id),
            eq(stagedPayments.status, "pending"),
            sql`NOT EXISTS (
              SELECT 1 FROM staged_payments sp2
              WHERE (sp2.matched_gift_id = ${giftId}
                     OR sp2.created_gift_id = ${giftId})
                AND sp2.id <> ${id}
            )`,
          ),
        )
        .returning({ id: stagedPayments.id });
    } catch (e) {
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code?: string }).code === "23505"
      ) {
        res.status(409).json({
          error: "link_conflict",
          message:
            "That gift was just linked to another payment. Refresh and try again.",
        });
        return;
      }
      throw e;
    }

    if (updated.length === 0) {
      res.status(409).json({
        error: "link_conflict",
        message:
          "This staged payment is no longer pending, or that gift was just linked to another payment. Refresh and try again.",
      });
      return;
    }

    res.json({ gift, stagedPaymentId: id });
  }),
);

// ─── POST /staged-payments/group-reconcile ─────────────────────────────────
// Manually group several staged payments that share ONE underlying bank Deposit
// into a single "deposit unit" and reconcile the GROUP to ONE existing CRM gift
// (which typically carries multiple allocations). No new gift is minted and
// QuickBooks is never written back. Guards: at least two rows; every row pending
// and not already resolved; all rows share the same non-null qbDepositId
// (never across deposits); the gift exists with a single valid donor and is not
// already linked to any other staged row; the members' combined total sits in
// the fee-band tolerance around the gift amount. On success EVERY member gets
// groupReconciledGiftId = the gift; exactly one deterministic "representative"
// also gets matchedGiftId = the gift (satisfying the one-staged↔one-gift
// partial-unique index and making the gift show linked). Reversible as a whole
// via the group-aware revert. Idempotent: re-running with the same rows already
// grouped is blocked by the not-pending guard.
router.post(
  "/staged-payments/group-reconcile",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = GroupReconcileStagedPaymentsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { giftId } = parsed.data;
    // De-dupe and sort for a deterministic representative (smallest id).
    const ids = Array.from(new Set(parsed.data.stagedPaymentIds)).sort();
    if (ids.length < 2) {
      res.status(400).json({
        error: "group_too_small",
        message:
          "Group at least two staged payments from the same deposit to reconcile as a unit.",
      });
      return;
    }

    const gift = await db
      .select()
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId))
      .then((r) => r[0]);
    if (!gift) return notFound(res, "gift");

    // The group adopts the gift's donor (Donor XOR). Guard the gift carries a
    // single valid donor, exactly like the single-row reconcile path.
    const giftDonor = donorOf(gift);
    if (!hasExactlyOneDonor(giftDonor)) {
      res.status(400).json({
        error: "link_invalid",
        message: "Cannot reconcile this deposit group to that gift.",
        details: {
          issues: [
            {
              path: ["giftId"],
              message: "The selected gift has no donor to adopt.",
            },
          ],
        },
      });
      return;
    }

    const NOT_FOUND = "__not_found__";
    const NOT_PENDING = "__not_pending__";
    const NOT_GROUPABLE = "__not_groupable__";
    const TOLERANCE = "__tolerance__";
    const CONFLICT = "__conflict__";

    const representativeId = ids[0];
    let toleranceDetail: { combinedTotal: number; giftAmount: number } | null =
      null;
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(stagedPayments)
          .where(inArray(stagedPayments.id, ids))
          .for("update");
        if (locked.length !== ids.length) throw new Error(NOT_FOUND);

        for (const row of locked) {
          if (
            row.status !== "pending" ||
            row.matchedGiftId != null ||
            row.createdGiftId != null ||
            row.groupReconciledGiftId != null
          ) {
            throw new Error(NOT_PENDING);
          }
        }

        // All members must share exactly one non-null deposit. Never group
        // across deposits, and never group rows with no known deposit.
        const depositIds = new Set(locked.map((r) => r.qbDepositId));
        if (depositIds.size !== 1 || locked[0].qbDepositId == null) {
          throw new Error(NOT_GROUPABLE);
        }

        // Combined member total must sit in the fee-band tolerance around the
        // gift: gift may be at most a hair under the sum (rounding) and at most
        // ~10% + $1 over (processor fees withheld before deposit).
        const sum = locked.reduce(
          (acc, r) => acc + Number(r.amount ?? 0),
          0,
        );
        const giftAmt = Number(gift.amount ?? 0);
        if (!(giftAmt >= sum - 0.01 && giftAmt <= sum * 1.1 + 1)) {
          toleranceDetail = { combinedTotal: sum, giftAmount: giftAmt };
          throw new Error(TOLERANCE);
        }

        // Gift must not already be linked to any staged row outside this group.
        const conflict = await tx
          .select({ id: stagedPayments.id })
          .from(stagedPayments)
          .where(
            and(
              or(
                eq(stagedPayments.matchedGiftId, giftId),
                eq(stagedPayments.createdGiftId, giftId),
                eq(stagedPayments.groupReconciledGiftId, giftId),
              ),
              notInArray(stagedPayments.id, ids),
            ),
          )
          .then((r) => r[0]);
        if (conflict) throw new Error(CONFLICT);

        const stamp = {
          ...giftDonor,
          status: "approved" as const,
          createdGiftId: null,
          autoApplied: false,
          matchStatus: "matched" as const,
          matchMethod: "manual" as const,
          matchConfirmedByUserId: user.id,
          matchConfirmedAt: new Date(),
          approvedByUserId: user.id,
          approvedAt: new Date(),
          groupReconciledGiftId: giftId,
          updatedAt: new Date(),
        };

        try {
          // Representative carries matchedGiftId (gift shows linked); the rest
          // reconcile via groupReconciledGiftId alone.
          await tx
            .update(stagedPayments)
            .set({ ...stamp, matchedGiftId: giftId })
            .where(eq(stagedPayments.id, representativeId));
          const memberIds = ids.filter((mid) => mid !== representativeId);
          await tx
            .update(stagedPayments)
            .set({ ...stamp, matchedGiftId: null })
            .where(inArray(stagedPayments.id, memberIds));
        } catch (e) {
          if (
            typeof e === "object" &&
            e !== null &&
            "code" in e &&
            (e as { code?: string }).code === "23505"
          ) {
            throw new Error(CONFLICT);
          }
          throw e;
        }
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_FOUND) {
        return notFound(res, "staged payment");
      }
      if (e instanceof Error && e.message === NOT_PENDING) {
        res.status(409).json({
          error: "not_pending",
          message:
            "One or more of these staged payments has already been resolved. Refresh and try again.",
        });
        return;
      }
      if (e instanceof Error && e.message === NOT_GROUPABLE) {
        res.status(400).json({
          error: "not_groupable",
          message:
            "These payments must all come from the same bank deposit to be grouped.",
        });
        return;
      }
      if (e instanceof Error && e.message === TOLERANCE) {
        res.status(400).json({
          error: "amount_mismatch",
          message:
            "The combined deposit total doesn't match the selected gift within the fee tolerance.",
          details: toleranceDetail,
        });
        return;
      }
      if (e instanceof Error && e.message === CONFLICT) {
        res.status(409).json({
          error: "link_conflict",
          message:
            "That gift was just linked to another payment. Refresh and try again.",
        });
        return;
      }
      throw e;
    }

    res.json({
      gift,
      stagedPaymentIds: ids,
      representativeStagedPaymentId: representativeId,
    });
  }),
);

// ─── POST /staged-payments/:id/confirm-match ───────────────────────────────
// Confirm a system-suggested donor match (auto-matched → human approved)
// without changing the donor or minting a gift. For auto-applied rows this is
// what graduates them from "Auto-matched" to "Done". Works on a pending row
// with a donor OR an auto-applied approved row.
router.post(
  "/staged-payments/:id/confirm-match",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);
    const [row] = await db
      .update(stagedPayments)
      .set({
        matchStatus: "matched",
        matchConfirmedByUserId: user.id,
        matchConfirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stagedPayments.id, id),
          sql`num_nonnulls(${stagedPayments.organizationId}, ${stagedPayments.individualGiverPersonId}, ${stagedPayments.householdId}) >= 1`,
          sql`(${stagedPayments.status} = 'pending'
               OR (${stagedPayments.status} = 'approved' AND ${stagedPayments.autoApplied} = true))`,
        ),
      )
      .returning();
    if (!row) {
      const exists = await db
        .select({ id: stagedPayments.id })
        .from(stagedPayments)
        .where(eq(stagedPayments.id, id))
        .then((r) => r[0]);
      if (!exists) return notFound(res, "staged payment");
      res.status(409).json({
        error: "conflict",
        message:
          "This staged payment can't be confirmed (no donor, or not in a confirmable state). Refresh and retry.",
      });
      return;
    }
    res.json(row);
  }),
);

// ─── POST /staged-payments/:id/unmatch ─────────────────────────────────────
// Clear the donor match and reset to unmatched. Only a pending row.
router.post(
  "/staged-payments/:id/unmatch",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const existing = await db
      .select({ status: stagedPayments.status })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");
    if (existing.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: "Only pending staged payments can be unmatched.",
      });
      return;
    }
    const [row] = await db
      .update(stagedPayments)
      .set({
        organizationId: null,
        individualGiverPersonId: null,
        householdId: null,
        matchedPaymentIntermediaryId: null,
        matchStatus: "unmatched",
        matchScore: null,
        matchMethod: null,
        matchConfirmedByUserId: null,
        matchConfirmedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(stagedPayments.id, id), eq(stagedPayments.status, "pending")),
      )
      .returning();
    if (!row) {
      res.status(409).json({
        error: "not_pending",
        message: "This staged payment is no longer pending. Refresh and retry.",
      });
      return;
    }
    res.json(row);
  }),
);

// ─── POST /staged-payments/:id/revert ──────────────────────────────────────
// Undo an approved reconciliation/creation, returning the row to the pending
// queue. Reversible cases:
//   - matchedGiftId set  → clear the link (pre-existing gift untouched).
//   - createdGiftId + autoApplied → delete the auto-minted gift + clear it.
// A MANUALLY created gift (createdGiftId, autoApplied=false) cannot be reverted
// — deleting it would orphan a fundraiser-created ledger row. The donor match
// is left intact so the row can be re-resolved.
router.post(
  "/staged-payments/:id/revert",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);

    const NOT_REVERTIBLE = "__not_revertible__";
    let result: typeof stagedPayments.$inferSelect | null = null;
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(stagedPayments)
          .where(eq(stagedPayments.id, id))
          .for("update")
          .then((r) => r[0]);
        if (!locked) throw new Error("__not_found__");
        if (locked.status !== "approved") throw new Error(NOT_REVERTIBLE);

        // Group-aware: a deposit-group member (incl. the representative, which
        // also carries matchedGiftId) reverts the WHOLE group back to pending.
        // No gift is deleted — a group reconciles to a pre-existing gift, never
        // a minted one. Check this first so the representative isn't handled by
        // the single-row branch (which would orphan the other members).
        if (locked.groupReconciledGiftId != null) {
          const gid = locked.groupReconciledGiftId;
          await tx
            .select({ id: stagedPayments.id })
            .from(stagedPayments)
            .where(eq(stagedPayments.groupReconciledGiftId, gid))
            .for("update");
          await tx
            .update(stagedPayments)
            .set({
              status: "pending",
              matchedGiftId: null,
              createdGiftId: null,
              groupReconciledGiftId: null,
              autoApplied: false,
              matchConfirmedByUserId: null,
              matchConfirmedAt: null,
              approvedByUserId: null,
              approvedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(stagedPayments.groupReconciledGiftId, gid));
          const [row] = await tx
            .select()
            .from(stagedPayments)
            .where(eq(stagedPayments.id, id));
          result = row ?? null;
          return;
        }

        const isReconcile = locked.matchedGiftId != null;
        const isAutoMint =
          locked.createdGiftId != null && locked.autoApplied === true;
        if (!isReconcile && !isAutoMint) throw new Error(NOT_REVERTIBLE);

        if (isAutoMint && locked.createdGiftId) {
          await tx
            .delete(giftsAndPayments)
            .where(eq(giftsAndPayments.id, locked.createdGiftId));
        }

        const [row] = await tx
          .update(stagedPayments)
          .set({
            status: "pending",
            matchedGiftId: null,
            createdGiftId: null,
            autoApplied: false,
            matchConfirmedByUserId: null,
            matchConfirmedAt: null,
            approvedByUserId: null,
            approvedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(stagedPayments.id, id))
          .returning();
        result = row ?? null;
      });
    } catch (e) {
      if (e instanceof Error && e.message === "__not_found__") {
        return notFound(res, "staged payment");
      }
      if (e instanceof Error && e.message === NOT_REVERTIBLE) {
        res.status(409).json({
          error: "not_revertible",
          message:
            "Only an auto-matched row or a reconciled-to-existing-gift row can be reverted.",
        });
        return;
      }
      throw e;
    }
    void user;
    res.json(result);
  }),
);

// ─── POST /quickbooks/sync ─────────────────────────────────────────────────
router.post(
  "/quickbooks/sync",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await syncQuickbooks();
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "QuickBooks manual sync failed");
      res.status(502).json({
        error: "sync_failed",
        message: e instanceof Error ? e.message : "QuickBooks sync failed",
      });
    }
  }),
);

// ─── POST /quickbooks/rematch ──────────────────────────────────────────────
router.post(
  "/quickbooks/rematch",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await rematchStagedPayments();
      req.log.info(
        { ran: summary.ran, scanned: summary.scanned, matched: summary.matched },
        "QuickBooks staged-payment rematch run",
      );
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "QuickBooks rematch failed");
      res.status(502).json({
        error: "rematch_failed",
        message: e instanceof Error ? e.message : "QuickBooks rematch failed",
      });
    }
  }),
);

// ─── POST /quickbooks/reclassify ───────────────────────────────────────────
// Admin-gated: re-run the noise classifier over auto-classified pending/excluded
// rows so refined rules retroactively clean up (or restore) staged rows. Never
// touches a manual include/exclude.
router.post(
  "/quickbooks/reclassify",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await reclassifyStagedPayments();
      req.log.info(
        {
          ran: summary.ran,
          scanned: summary.scanned,
          excluded: summary.excluded,
          included: summary.included,
        },
        "QuickBooks staged-payment reclassify run",
      );
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "QuickBooks reclassify failed");
      res.status(502).json({
        error: "reclassify_failed",
        message: e instanceof Error ? e.message : "QuickBooks reclassify failed",
      });
    }
  }),
);

export default router;
