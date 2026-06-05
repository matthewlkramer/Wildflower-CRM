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
import { and, count, desc, eq, getTableColumns, sql } from "drizzle-orm";
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
  ExcludeStagedPaymentBody,
} from "@workspace/api-zod";
import { donorOf, donorsMatch, validateGiftLink } from "../lib/quickbooksLink";
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
      sql`${resolvedGift.id} = COALESCE(${stagedPayments.matchedGiftId}, ${stagedPayments.createdGiftId})`,
    );
}

type Queue = "needs_review" | "auto_matched" | "excluded" | "done" | "rejected";

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
    const { limit, offset, page } = parsePagination(req.query);
    const where = queueWhere(queue);

    const [rows, totalRow] = await Promise.all([
      withJoins(db.select(stagedSelect).from(stagedPayments).$dynamic())
        .where(where)
        // Payments / sales-receipts before bank deposits, then newest first, so
        // per-donor payments are never buried under a large pile of deposits.
        .orderBy(
          sql`CASE WHEN ${stagedPayments.qbEntityType} = 'deposit' THEN 1 ELSE 0 END`,
          desc(stagedPayments.dateReceived),
          desc(stagedPayments.createdAt),
        )
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
// matchedGiftId → the chosen gift, status approved, autoApplied=false. If the
// staged row has no donor yet, it adopts the gift's donor; otherwise the donors
// must match. Guards: row pending, gift exists, gift not already linked.
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

    const stagedDonor = donorOf(existing);
    const giftDonor = donorOf(gift);
    // Adopt the gift's donor when the staged row has no donor yet (window-based
    // reconcile). Otherwise require the donors to match.
    const stagedHasDonor =
      stagedDonor.organizationId != null ||
      stagedDonor.individualGiverPersonId != null ||
      stagedDonor.householdId != null;
    const finalDonor = stagedHasDonor ? stagedDonor : giftDonor;

    if (stagedHasDonor && !donorsMatch(stagedDonor, giftDonor)) {
      const issues = validateGiftLink({
        stagedDonor,
        giftDonor,
        alreadyLinkedStagedPaymentId: null,
      });
      res.status(400).json({
        error: "link_invalid",
        message: "Cannot reconcile this staged payment to that gift.",
        details: {
          issues: issues.map((i) => ({ path: ["giftId"], message: i.message })),
        },
      });
      return;
    }

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
