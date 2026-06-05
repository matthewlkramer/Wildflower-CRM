import { Router, type IRouter, type Response } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  giftsAndPayments,
  organizations,
  households,
  people,
} from "@workspace/db/schema";
import { and, count, desc, eq, getTableColumns, sql } from "drizzle-orm";
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
import { ResolveStagedPaymentBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { syncQuickbooks } from "../lib/quickbooksSync";

/**
 * Review queue for QuickBooks-sourced payments plus the manual "sync now"
 * trigger. Listing/resolving is open to any authenticated fundraiser;
 * triggering a sync and approving/rejecting that mints ledger rows are
 * the day-to-day fundraiser workflow (auth-gated). The connection itself
 * is admin-gated in quickbooksOauth.ts.
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

// Donor display names joined for the review-queue UI.
const stagedSelect = {
  ...getTableColumns(stagedPayments),
  organizationName: organizations.name,
  householdName: households.name,
  individualGiverPersonName: sql<string | null>`
    COALESCE(
      NULLIF(TRIM(${people.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
    )
  `.as("individual_giver_person_name"),
};

// ─── GET /staged-payments ──────────────────────────────────────────────────
router.get(
  "/staged-payments",
  asyncHandler(async (req, res) => {
    const rawStatus =
      typeof req.query["status"] === "string" ? req.query["status"] : "pending";
    const status =
      rawStatus === "approved" ||
      rawStatus === "rejected" ||
      rawStatus === "excluded"
        ? rawStatus
        : "pending";
    const { limit, offset, page } = parsePagination(req.query);

    const where = eq(stagedPayments.status, status);
    const [rows, totalRow] = await Promise.all([
      db
        .select(stagedSelect)
        .from(stagedPayments)
        .leftJoin(
          organizations,
          eq(organizations.id, stagedPayments.organizationId),
        )
        .leftJoin(households, eq(households.id, stagedPayments.householdId))
        .leftJoin(
          people,
          eq(people.id, stagedPayments.individualGiverPersonId),
        )
        .where(where)
        .orderBy(desc(stagedPayments.dateReceived), desc(stagedPayments.createdAt))
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

// ─── POST /staged-payments/:id/resolve ─────────────────────────────────────
// Fundraiser fixes the donor match (sets exactly one donor FK). Keeps the
// row pending; switches matchStatus to "matched".
router.post(
  "/staged-payments/:id/resolve",
  asyncHandler(async (req, res) => {
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
      .select()
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
        updatedAt: new Date(),
      })
      .where(eq(stagedPayments.id, id))
      .returning();
    res.json(row);
  }),
);

// ─── POST /staged-payments/:id/approve ─────────────────────────────────────
// Mint a real gifts_and_payments row from the staged payment, then mark
// the staged row approved (idempotent: a second approve is a 409).
router.post(
  "/staged-payments/:id/approve",
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

    const donor = {
      organizationId: existing.organizationId,
      individualGiverPersonId: existing.individualGiverPersonId,
      householdId: existing.householdId,
    };
    const issues = validateGiftInvariants(donor);
    if (issues.length) return respondInvariantFailure(res, issues);

    const giftName =
      existing.payerName ??
      existing.rawReference ??
      `QuickBooks ${existing.qbEntityType}`;

    const giftId = newId();
    await db.transaction(async (tx) => {
      await tx.insert(giftsAndPayments).values({
        id: giftId,
        name: giftName,
        amount: existing.amount,
        dateReceived: existing.dateReceived,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        details: `Imported from QuickBooks (${existing.qbEntityType} #${existing.qbEntityId}).`,
        ownerUserId: user.id,
      });
      await tx
        .update(stagedPayments)
        .set({
          status: "approved",
          createdGiftId: giftId,
          approvedByUserId: user.id,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(stagedPayments.id, id));
    });

    const [gift] = await db
      .select()
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId));
    res.status(201).json({ gift, stagedPaymentId: id });
  }),
);

// ─── POST /staged-payments/:id/reject ──────────────────────────────────────
// Discard a staged payment. Kept (not deleted) so re-sync won't re-stage.
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
      .where(eq(stagedPayments.id, id))
      .returning();
    res.json(row);
  }),
);

// ─── POST /staged-payments/:id/re-include ──────────────────────────────────
// Move an auto-excluded row back to the pending queue (false positive). Clears
// the exclusion reason. Only an excluded row can be re-included.
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
        updatedAt: new Date(),
      })
      .where(eq(stagedPayments.id, id))
      .returning();
    res.json(row);
  }),
);

// ─── GET /staged-payments-summary ──────────────────────────────────────────
// Lightweight counts for badges.
router.get(
  "/staged-payments-summary",
  asyncHandler(async (_req, res) => {
    const [statusRows, reasonRows] = await Promise.all([
      db
        .select({ status: stagedPayments.status, value: count() })
        .from(stagedPayments)
        .groupBy(stagedPayments.status),
      db
        .select({
          reason: stagedPayments.exclusionReason,
          value: count(),
        })
        .from(stagedPayments)
        .where(eq(stagedPayments.status, "excluded"))
        .groupBy(stagedPayments.exclusionReason),
    ]);

    const summary = { pending: 0, approved: 0, rejected: 0, excluded: 0 };
    for (const r of statusRows) {
      if (r.status in summary) {
        summary[r.status as keyof typeof summary] = r.value;
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

    res.json({ ...summary, excludedByReason });
  }),
);

// ─── POST /quickbooks/sync ─────────────────────────────────────────────────
// Manual "sync now". Admin-gated. Same code path as the scheduler.
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

export default router;
