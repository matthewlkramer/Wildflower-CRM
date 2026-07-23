import { Router, type IRouter } from "express";
import { requireFinance } from "../../lib/financeGuard";
import { db } from "@workspace/db";
import {
  stagedPayments,
  giftsAndPayments,
  entities,
} from "@workspace/db/schema";
import { and, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
} from "../../lib/helpers";
import {
  seedInitialGiftAllocation,
  assertGiftHasAllocations,
} from "../../lib/giftAllocationSeed";
import { isGovernmentReimbursement } from "../../lib/quickbooksExclusionRules";
import { getAppUser } from "../../lib/appRequest";
import { validateGiftInvariants, type InvariantIssue } from "@workspace/api-zod";
import {
  ResolveStagedPaymentBody,
  ExcludeStagedPaymentBody,
  SetStagedPaymentEntityBody,
  SetStagedPaymentFundingSourceBody,
  SetStagedPaymentCodingBody,
} from "@workspace/api-zod";
import { buildGiftValuesFromStaged } from "../../lib/quickbooksGift";
import { applyPaymentApplication } from "../../lib/paymentApplications";
import {
  respondInvariantFailure,
  stagedReturnColumns,
  stagedRowWithStatus,
} from "./shared";
import {
  stagedStatusSql,
  stagedStatusWhere,
  stagedStatusIn,
} from "../../lib/derivedStatus";
import { giftHeaderColumns } from "../giftsAndPayments";
import {
  reconAudit,
  fmtMoney,
  payerLabel,
} from "../../lib/reconciliationAudit";

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
      .select({ status: stagedStatusSql.as("status") })
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
      .where(and(eq(stagedPayments.id, id), stagedStatusWhere.pending))
      .returning(stagedReturnColumns);
    if (!row) {
      res.status(409).json({
        error: "not_pending",
        message: "This staged payment is no longer pending. Refresh and retry.",
      });
      return;
    }
    // Donor-only resolve on a pending row: no counted ledger row exists.
    // No safe single-call undo: there is no "un-resolve" endpoint (revert
    // requires a gift link), so the rail shows this entry without an Undo.
    await reconAudit(req, {
      action: "update",
      entityType: "staged_payment",
      entityId: id,
      summary: `Set the donor on the QuickBooks payment from ${payerLabel(row.payerName)} (${fmtMoney(row.amount)})`,
      undo: null,
    });
    res.json(stagedRowWithStatus(row, false));
  }),
);

// ─── POST /staged-payments/:id/create-gift ─────────────────────────────────
// Mint a real gifts_and_payments row from the staged payment (donor XOR). The
// minted gift's amount IS this QB evidence.
// The staged row becomes permanent EVIDENCE tied to the gift via the counted
// payment_applications ledger row (created_the_gift = true; derived status
// match_confirmed — never archived, never a second gift).
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
      .select({
        ...getTableColumns(stagedPayments),
        status: stagedStatusSql.as("status"),
      })
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
          .select({
            ...getTableColumns(stagedPayments),
            status: stagedStatusSql.as("status"),
          })
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
          // Provenance is the counted ledger row (created_the_gift = true,
          // booked below); the transitional final-amount columns are retired
          // (Task #757) and never written.
        });
        // Every gift needs at least one allocation (the sole home of money
        // scope). Seed a default full-amount line carrying the staged row's
        // attributed entity + goal-counting signal (mirrors the auto-create rule).
        await seedInitialGiftAllocation(tx, {
          giftId,
          amount: locked.amount,
          dateReceived: locked.dateReceived,
          entityId: locked.entityId,
          countsTowardGoal: !isGovernmentReimbursement(locked),
        });
        await assertGiftHasAllocations(tx, giftId);
        await tx
          .update(stagedPayments)
          .set({
            // The counted ledger row (created_the_gift = true, booked below) +
            // the confirmation stamps derive the terminal match_confirmed; the
            // legacy gift-link columns are @deprecated and no longer written.
            autoApplied: false,
            matchStatus: "matched",
            matchConfirmedByUserId: user.id,
            matchConfirmedAt: new Date(),
            approvedByUserId: user.id,
            approvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(stagedPayments.id, id));

        // Book the QB cash-application ledger row — the SOLE resolution record —
        // for the freshly-minted gift (this staged payment created + fully applies to it).
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

    const [gift] = await db
      .select(giftHeaderColumns)
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId));
    // No safe undo: a MANUALLY minted gift is not revertible via the staged
    // revert (shared.ts would orphan a fundraiser-created ledger row).
    await reconAudit(req, {
      action: "create",
      entityType: "staged_payment",
      entityId: id,
      summary: `Created gift "${gift?.name ?? giftId}" from the QuickBooks payment from ${payerLabel(existing.payerName)} (${fmtMoney(existing.amount)})`,
      undo: null,
      extra: { giftId },
    });
    res.status(201).json({ gift, stagedPaymentId: id });
  }),
);

// ─── POST /staged-payments/:id/re-include ──────────────────────────────────
// Move an excluded row back to the pending queue (false positive). Pins
// classificationSource='manual' so the re-runnable classifier never re-excludes
// it. Only an excluded row can be re-included.
router.post(
  "/staged-payments/:id/re-include",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const id = paramId(req);
    const existing = await db
      .select({ status: stagedStatusSql.as("status") })
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
    // Clearing exclusion_reason IS the re-include (status derives from it).
    const [row] = await db
      .update(stagedPayments)
      .set({
        exclusionReason: null,
        classificationSource: "manual",
        updatedAt: new Date(),
      })
      .where(and(eq(stagedPayments.id, id), stagedStatusWhere.excluded))
      .returning(stagedReturnColumns);
    if (!row) {
      res.status(409).json({
        error: "not_excluded",
        message: "This staged payment is no longer excluded. Refresh and retry.",
      });
      return;
    }
    // Excluded → pending: an excluded row never carries counted ledger rows.
    // No safe undo: re-excluding needs a reason the rail can't supply.
    await reconAudit(req, {
      action: "update",
      entityType: "staged_payment",
      entityId: id,
      summary: `Re-included the QuickBooks record from ${payerLabel(row.payerName)} (${fmtMoney(row.amount)}) back into the queue`,
      undo: null,
    });
    res.json(stagedRowWithStatus(row, false));
  }),
);

// ─── POST /staged-payments/:id/exclude ─────────────────────────────────────
// Human-driven exclude: file a staged row under a non-gift category and move it
// to the excluded bucket. Pins classificationSource='manual' so it survives the
// re-runnable classifier. Allowed from pending or excluded (reclassify).
router.post(
  "/staged-payments/:id/exclude",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
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
      .select({ status: stagedStatusSql.as("status") })
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

    // Setting exclusion_reason IS the exclusion (status derives from it).
    const [row] = await db
      .update(stagedPayments)
      .set({
        exclusionReason,
        classificationSource: "manual",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stagedPayments.id, id),
          stagedStatusIn(["pending", "excluded"]),
        ),
      )
      .returning(stagedReturnColumns);
    if (!row) {
      res.status(409).json({
        error: "not_excludable",
        message:
          "This staged payment changed before it could be excluded. Refresh and retry.",
      });
      return;
    }
    // Excludable only from pending/excluded — neither carries counted rows.
    await reconAudit(req, {
      action: "update",
      entityType: "staged_payment",
      entityId: id,
      summary: `Excluded the QuickBooks record from ${payerLabel(row.payerName)} (${fmtMoney(row.amount)}) — ${exclusionReason.replace(/_/g, " ")}`,
      undo: { kind: "reinclude_staged_payment", targetId: id },
      extra: { exclusionReason },
    });
    res.json(stagedRowWithStatus(row, false));
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
      .returning(stagedReturnColumns);
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
      .returning(stagedReturnColumns);
    res.json(row);
  }),
);

// ─── POST /staged-payments/:id/set-coding ──────────────────────────────────
// Reviewer captures/edits the revenue-coding snapshot for this QuickBooks
// payment record. The snapshot moved off the allocation onto the staged row
// (Task #449); a live per-allocation derivation is available at
// /gift-allocations/{id}/coding-preview. Only fields present in the body are
// written; passing null clears that field. Orthogonal to reconcile status, so
// allowed on a row in any state.
router.post(
  "/staged-payments/:id/set-coding",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const id = paramId(req);
    const parsed = SetStagedPaymentCodingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Request validation failed",
        details: parsed.error.flatten(),
      });
      return;
    }

    const existing = await db
      .select({ id: stagedPayments.id })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .then((r) => r[0]);
    if (!existing) return notFound(res, "staged payment");

    // Only write fields the caller actually sent (partial update); a present
    // null clears the column, an absent key leaves it untouched.
    const b = parsed.data;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if ("objectCode" in b) set.objectCode = b.objectCode ?? null;
    if ("objectCodeOverride" in b)
      set.objectCodeOverride = b.objectCodeOverride ?? null;
    if ("revenueLocation" in b) set.revenueLocation = b.revenueLocation ?? null;
    if ("revenueLocationOverride" in b)
      set.revenueLocationOverride = b.revenueLocationOverride ?? null;
    if ("revenueClass" in b) set.revenueClass = b.revenueClass ?? null;
    if ("revenueClassOverride" in b)
      set.revenueClassOverride = b.revenueClassOverride ?? null;
    if ("codingFlags" in b) set.codingFlags = b.codingFlags ?? null;
    if ("deferredRevenue" in b) set.deferredRevenue = b.deferredRevenue ?? null;
    if ("deferredRevenueReason" in b)
      set.deferredRevenueReason = b.deferredRevenueReason ?? null;

    const [row] = await db
      .update(stagedPayments)
      .set(set)
      .where(eq(stagedPayments.id, id))
      .returning(stagedReturnColumns);
    res.json(row);
  }),
);

// ─── POST /staged-payments/group (RETIRED) ─────────────────────────────────
// Tombstone: pre-match "same physical gift" groups are retired
// (docs/adr-linear-money-model.md). Select the rows together in the workbench
// and match them in one call with POST /staged-payments/multi-match. Stale
// legacy unit_groups/unit_group_members rows remain in the DB until the
// schema-drop step, but no behavior writes or dismantles them anymore.
router.post("/staged-payments/group", (_req, res) => {
  res.status(410).json({
    error: "group_creation_retired",
    message:
      "Pre-match groups are retired. Select the rows together and match them with POST /staged-payments/multi-match.",
  });
});

// ─── POST /staged-payments/ungroup (RETIRED) ───────────────────────────────
// Tombstone: unit groups are retired (docs/adr-linear-money-model.md). There
// is no group state to dismantle — a pending row is already independent, and
// a matched member is undone individually with POST /staged-payments/:id/revert
// (its counted payment_applications ledger row is the sole record of the
// combined match).
router.post("/staged-payments/ungroup", (_req, res) => {
  res.status(410).json({
    error: "group_creation_retired",
    message:
      "Unit groups are retired. Pending rows are already independent; revert a matched row individually with POST /staged-payments/:id/revert.",
  });
});

export default router;
