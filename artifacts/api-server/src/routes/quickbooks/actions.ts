import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  giftsAndPayments,
  entities,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
} from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import { validateGiftInvariants, type InvariantIssue } from "@workspace/api-zod";
import {
  ResolveStagedPaymentBody,
  ExcludeStagedPaymentBody,
  SetStagedPaymentEntityBody,
  SetStagedPaymentFundingSourceBody,
  GroupStagedPaymentsBody,
  UngroupStagedPaymentsBody,
} from "@workspace/api-zod";
import { buildGiftValuesFromStaged } from "../../lib/quickbooksGift";
import { applyGiftQbTieMany } from "../../lib/giftQbTie";
import { applyPaymentApplication } from "../../lib/paymentApplications";
import { respondInvariantFailure } from "./shared";

const router: IRouter = Router();

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
// Mint a real gifts_and_payments row from the staged payment (donor XOR). The
// minted gift's amount IS this QB evidence, so it is stamped at insert
// (final_amount_source='quickbooks', pointer → this staged row, no original
// human amount to snapshot). The staged row becomes permanent EVIDENCE tied to
// the gift: `reconciled`, not `approved` (never archived, never a second gift).
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
    if (existing.sourceGroupId != null) {
      res.status(409).json({
        error: "source_group_member",
        message:
          "This payment is part of a group. Reconcile the whole group from its card.",
      });
      return;
    }
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
        await tx.insert(giftsAndPayments).values({
          ...buildGiftValuesFromStaged(
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
          // Stamp provenance at insert: the gift's amount IS this QB evidence
          // (no prior human figure to snapshot). Pointer ties the gift to the
          // staged row permanently (single XOR pointer, qb side).
          finalAmountSource: "quickbooks",
          finalAmountQbStagedPaymentId: id,
          finalAmountStripeChargeId: null,
          originalHumanCrmAmount: null,
        });
        await tx
          .update(stagedPayments)
          .set({
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
          .where(eq(stagedPayments.id, id));

        // Dual-write (Phase 2): book the QB cash-application ledger row for the
        // freshly-minted gift (this staged payment created + fully applies to it).
        if (locked.amount && Number(locked.amount) > 0) {
          await applyPaymentApplication(tx, {
            paymentId: id,
            giftId,
            amountApplied: locked.amount,
            evidenceSource: "quickbooks",
            matchMethod: "human",
            confirmedByUserId: user.id,
            confirmedAt: new Date(),
            createdTheGift: true,
          });
        }
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

    // The newly minted gift now carries QB linkage — persist its tie status.
    await applyGiftQbTieMany(giftId);

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

// ─── POST /staged-payments/:id/set-entity ──────────────────────────────────
// Reviewer pins (or clears) the Wildflower-entity attribution by hand. Entity
// attribution is orthogonal to reconcile status, so this is allowed on a row in
// any state. Setting entitySource='manual' makes the choice survive every
// re-sync / reclassify — detectEntity never overwrites a manual attribution.
// Body: { entityId: string | null }. null clears the attribution back to the
// default Foundation bucket but KEEPS the manual pin (so detectEntity won't
// re-attribute it on the next pull — needed for "Sunlight" money that must not
// be auto-attributed).
router.post(
  "/staged-payments/:id/set-entity",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const parsed = SetStagedPaymentEntityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const entityId = parsed.data.entityId ?? null;

    const existing = await db
      .select({ id: stagedPayments.id })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");

    if (entityId !== null) {
      const entity = await db
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.id, entityId))
        .then((r) => r[0]);
      if (!entity) {
        res.status(400).json({
          error: "invalid_entity",
          message: "No such Wildflower entity.",
        });
        return;
      }
    }

    const [row] = await db
      .update(stagedPayments)
      .set({ entityId, entitySource: "manual", updatedAt: new Date() })
      .where(eq(stagedPayments.id, id))
      .returning();
    res.json(row);
  }),
);

// ─── POST /staged-payments/:id/set-funding-source ──────────────────────────
// Reviewer pins (or clears) the FUNDING SOURCE origin by hand. Orthogonal to
// reconcile status, so allowed on a row in any state. Setting
// fundingSourceProvenance='manual' makes the choice survive every re-sync /
// reclassify (detectFundingSource never overwrites a manual pin). Body:
// { fundingSource: enum | null }. null clears the value but KEEPS the manual
// pin, so detection won't re-seed it on the next pull.
router.post(
  "/staged-payments/:id/set-funding-source",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const parsed = SetStagedPaymentFundingSourceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const fundingSource = parsed.data.fundingSource ?? null;

    const existing = await db
      .select({ id: stagedPayments.id })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");

    const [row] = await db
      .update(stagedPayments)
      .set({
        fundingSource,
        fundingSourceProvenance: "manual",
        updatedAt: new Date(),
      })
      .where(eq(stagedPayments.id, id))
      .returning();
    res.json(row);
  }),
);

// ─── POST /staged-payments/group ───────────────────────────────────────────
// Mark two or more staged payments as ONE physical gift entered separately in
// QuickBooks (a "same physical gift" source group). Stamps a shared opaque
// sourceGroupId. Pure review state — it never changes donor or gift links and
// never reconciles by itself; the reconciliation card collapses the members
// into one group card and approval acts on the whole group.
router.post(
  "/staged-payments/group",
  asyncHandler(async (req, res) => {
    const parsed = GroupStagedPaymentsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const confirmDonorConflict = parsed.data.confirmDonorConflict === true;
    const ids = Array.from(new Set(parsed.data.stagedPaymentIds)).sort();
    if (ids.length < 2) {
      res.status(400).json({
        error: "group_too_small",
        message: "Group at least two distinct staged payments together.",
      });
      return;
    }

    const NOT_FOUND = "__not_found__";
    const NOT_GROUPABLE = "__not_groupable__";
    const DIFF_GROUP = "__diff_group__";
    const DONOR_CONFLICT = "__donor_conflict__";

    let result: {
      sourceGroupId: string;
      stagedPaymentIds: string[];
      representativeStagedPaymentId: string;
      totalAmount: string | null;
    } | null = null;
    try {
      await db.transaction(async (tx) => {
        const locked = await tx
          .select()
          .from(stagedPayments)
          .where(inArray(stagedPayments.id, ids))
          .for("update");
        if (locked.length !== ids.length) throw new Error(NOT_FOUND);

        // Only still-unreconciled rows can be grouped (a group is reconciled as
        // a unit; grouping resolved money is meaningless).
        for (const row of locked) {
          if (
            row.status === "reconciled" ||
            row.matchedGiftId != null ||
            row.createdGiftId != null ||
            row.groupReconciledGiftId != null
          ) {
            throw new Error(NOT_GROUPABLE);
          }
        }

        // Existing-group rule: forming a fresh group requires every member to be
        // currently ungrouped. If all members already share ONE group it is an
        // idempotent re-group (return that id). Any other mix (some grouped, or
        // two different groups) is rejected — ungroup first.
        const memberGroups = locked.map((r) => r.sourceGroupId);
        const distinctGroups = Array.from(
          new Set(memberGroups.filter((g): g is string => g != null)),
        );
        const anyUngrouped = memberGroups.some((g) => g == null);
        let sourceGroupId: string;
        if (distinctGroups.length === 0) {
          sourceGroupId = newId();
        } else if (distinctGroups.length === 1 && !anyUngrouped) {
          sourceGroupId = distinctGroups[0];
        } else {
          throw new Error(DIFF_GROUP);
        }

        // Donor-conflict guard: more than one distinct (non-null) donor key
        // across the members means they may be unrelated gifts.
        const donorKeys = new Set(
          locked
            .map(
              (r) =>
                r.organizationId ??
                r.individualGiverPersonId ??
                r.householdId ??
                null,
            )
            .filter((k): k is string => k != null),
        );
        if (donorKeys.size > 1 && !confirmDonorConflict) {
          throw new Error(DONOR_CONFLICT);
        }

        await tx
          .update(stagedPayments)
          .set({ sourceGroupId, updatedAt: new Date() })
          .where(inArray(stagedPayments.id, ids));

        // Recompute full membership (an idempotent re-group may already include
        // rows beyond the passed ids), the deterministic representative (min id
        // among members) and the combined total.
        const members = await tx
          .select({
            id: stagedPayments.id,
            amount: stagedPayments.amount,
          })
          .from(stagedPayments)
          .where(eq(stagedPayments.sourceGroupId, sourceGroupId));
        const memberIds = members.map((m) => m.id).sort();
        const total = members.reduce((acc, m) => acc + Number(m.amount ?? 0), 0);
        result = {
          sourceGroupId,
          stagedPaymentIds: memberIds,
          representativeStagedPaymentId: memberIds[0] ?? ids[0],
          totalAmount: members.length ? total.toFixed(2) : null,
        };
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_FOUND) {
        return notFound(res, "staged payment");
      }
      if (e instanceof Error && e.message === NOT_GROUPABLE) {
        res.status(409).json({
          error: "not_groupable",
          message:
            "Only non-archived, unreconciled staged payments can be grouped.",
        });
        return;
      }
      if (e instanceof Error && e.message === DIFF_GROUP) {
        res.status(409).json({
          error: "different_group",
          message:
            "One or more of these payments is already in a different group. Ungroup them first.",
        });
        return;
      }
      if (e instanceof Error && e.message === DONOR_CONFLICT) {
        res.status(400).json({
          error: "donor_conflict",
          message:
            "These payments resolve to more than one donor. Confirm you want to group them anyway.",
        });
        return;
      }
      throw e;
    }
    res.json(result);
  }),
);

// ─── POST /staged-payments/ungroup ─────────────────────────────────────────
// Clear sourceGroupId on the given rows, removing them from their source group.
// If this leaves a group with fewer than two non-archived members, the
// remaining orphan is cleared too (a group requires >= 2). Pure review state;
// a no-op for rows that aren't grouped.
router.post(
  "/staged-payments/ungroup",
  asyncHandler(async (req, res) => {
    const parsed = UngroupStagedPaymentsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }
    const ids = Array.from(new Set(parsed.data.stagedPaymentIds));

    const NOT_FOUND = "__not_found__";
    let result: {
      ungroupedIds: string[];
      dissolvedGroupIds: string[];
    } | null = null;
    try {
      await db.transaction(async (tx) => {
        const targets = await tx
          .select({
            id: stagedPayments.id,
            sourceGroupId: stagedPayments.sourceGroupId,
          })
          .from(stagedPayments)
          .where(inArray(stagedPayments.id, ids))
          .for("update");
        if (targets.length !== ids.length) throw new Error(NOT_FOUND);

        const affectedGroups = Array.from(
          new Set(
            targets
              .map((t) => t.sourceGroupId)
              .filter((g): g is string => g != null),
          ),
        );
        const toClear = targets
          .filter((t) => t.sourceGroupId != null)
          .map((t) => t.id);
        const ungroupedIds: string[] = [...toClear];
        if (toClear.length) {
          await tx
            .update(stagedPayments)
            .set({ sourceGroupId: null, updatedAt: new Date() })
            .where(inArray(stagedPayments.id, toClear));
        }

        // Auto-dissolve any affected group now left with < 2 members (a group
        // requires >= 2): clear the lone orphan too.
        const dissolvedGroupIds: string[] = [];
        for (const g of affectedGroups) {
          const remaining = await tx
            .select({ id: stagedPayments.id })
            .from(stagedPayments)
            .where(eq(stagedPayments.sourceGroupId, g))
            .for("update");
          if (remaining.length < 2) {
            if (remaining.length === 1) {
              await tx
                .update(stagedPayments)
                .set({ sourceGroupId: null, updatedAt: new Date() })
                .where(eq(stagedPayments.id, remaining[0].id));
              ungroupedIds.push(remaining[0].id);
            }
            dissolvedGroupIds.push(g);
          }
        }
        result = {
          ungroupedIds: Array.from(new Set(ungroupedIds)),
          dissolvedGroupIds,
        };
      });
    } catch (e) {
      if (e instanceof Error && e.message === NOT_FOUND) {
        return notFound(res, "staged payment");
      }
      throw e;
    }
    res.json(result);
  }),
);

export default router;
