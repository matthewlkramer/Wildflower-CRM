import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  opportunitiesAndPledges,
  pledgeAllocations,
  pledgeExpectedPayments,
} from "@workspace/db/schema";
import {
  RecordVerbalCommitmentBody,
  FinalizePledgeBody,
} from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  notFound,
  paramId,
  parseOrBadRequest,
} from "../lib/helpers";
import { auditUpdate } from "../lib/audit";
import { applyDerivedOppFields, isConditionalPledge } from "../lib/pledgeStage";
import {
  resolvePledgeFreeze,
  respondFrozen,
  type FreezeDecision,
} from "../lib/freezeGuard";

const router: IRouter = Router();
router.use(requireAuth);

const RETIRED_ALLOCATION_STATUSES = [
  "abandoned",
  "superseded",
  "superseded_by_pledge",
  "superseded_by_gift",
] as const;

function money(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function sameMoney(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function lifecycleResult(row: typeof opportunitiesAndPledges.$inferSelect) {
  return {
    id: row.id,
    commitmentPath: row.commitmentPath,
    verbalCommitmentAt: row.verbalCommitmentAt,
    pledgeCommittedAt: row.pledgeCommittedAt,
    outcomeType:
      row.pledgeCommittedAt != null
        ? "pledge"
        : money(row.paid) > 0
          ? "gift"
          : null,
    status: row.status,
    stage: row.stage,
    awardedAmount: row.awardedAmount,
    paidAmount: row.paid,
  };
}

router.post(
  "/opportunities-and-pledges/:id/record-verbal-commitment",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(RecordVerbalCommitmentBody, req.body, res);
    if (!body) return;
    const id = paramId(req);

    const [before] = await db
      .select()
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, id))
      .limit(1);
    if (!before) return notFound(res, "opportunity");
    if (before.archivedAt) {
      res.status(409).json({
        error: "opportunity_archived",
        message: "Restore this opportunity before recording a commitment.",
      });
      return;
    }
    if (before.lossType) {
      res.status(409).json({
        error: "opportunity_closed",
        message: "Reopen this opportunity before recording a commitment.",
      });
      return;
    }
    if (before.pledgeCommittedAt || before.writtenPledge) {
      res.status(409).json({
        error: "pledge_already_finalized",
        message:
          "This record is already a pledge. Use an audited correction rather than changing its commitment path.",
      });
      return;
    }
    if (money(before.paid) > 0) {
      res.status(409).json({
        error: "gift_already_received",
        message:
          "Money has already arrived, so this opportunity has completed as a gift.",
      });
      return;
    }
    if (money(body.confirmedAmount) <= 0) {
      res.status(400).json({
        error: "validation_error",
        message: "Confirmed amount must be greater than zero.",
      });
      return;
    }
    const freeze = await resolvePledgeFreeze(before.actualCompletionDate);
    if (freeze.frozen) {
      respondFrozen(res, freeze);
      return;
    }

    const [updated] = await db
      .update(opportunitiesAndPledges)
      .set({
        commitmentPath: body.commitmentPath,
        verbalCommitmentAt: body.verbalCommitmentAt,
        awardedAmount: body.confirmedAmount,
        projectedCloseDate:
          body.expectedDate === undefined
            ? before.projectedCloseDate
            : body.expectedDate,
        stage: "verbal_confirmation",
        writtenPledge: false,
        updatedAt: new Date(),
      })
      .where(eq(opportunitiesAndPledges.id, id))
      .returning();

    await applyDerivedOppFields(id);
    const [after] = await db
      .select()
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, id))
      .limit(1);
    await auditUpdate(
      req,
      "opportunity",
      id,
      before as Record<string, unknown>,
      after as Record<string, unknown>,
      [
        "commitmentPath",
        "verbalCommitmentAt",
        "awardedAmount",
        "projectedCloseDate",
        "stage",
      ],
      `Recorded ${body.commitmentPath.replaceAll("_", " ")} verbal commitment`,
    );
    res.json(lifecycleResult(after ?? updated!));
  }),
);

router.post(
  "/opportunities-and-pledges/:id/finalize-pledge",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(FinalizePledgeBody, req.body, res);
    if (!body) return;
    const id = paramId(req);

    let before: typeof opportunitiesAndPledges.$inferSelect | undefined;
    let finalizationError:
      | { error: string; message: string; details?: unknown }
      | undefined;
    let freezeDecision: Extract<FreezeDecision, { frozen: true }> | undefined;

    await db.transaction(async (tx) => {
      before = await tx
        .select()
        .from(opportunitiesAndPledges)
        .where(eq(opportunitiesAndPledges.id, id))
        .for("update")
        .then((rows) => rows[0]);
      if (!before) return;

      const freeze = await resolvePledgeFreeze(
        before.actualCompletionDate,
        before.actualCompletionDate ?? body.pledgeCommittedAt,
      );
      if (freeze.frozen) {
        freezeDecision = freeze;
        return;
      }

      if (before.archivedAt) {
        finalizationError = {
          error: "opportunity_archived",
          message: "Restore this opportunity before finalizing the pledge.",
        };
        return;
      }
      if (before.lossType) {
        finalizationError = {
          error: "opportunity_closed",
          message: "Reopen this opportunity before finalizing the pledge.",
        };
        return;
      }
      if (before.pledgeCommittedAt) return;
      if (
        before.commitmentPath !== "written_pledge" &&
        before.commitmentPath !== "verbal_pledge"
      ) {
        finalizationError = {
          error: "pledge_path_required",
          message:
            "Record a written-pledge or verbal-pledge commitment before finalizing.",
        };
        return;
      }
      if (
        before.commitmentPath === "written_pledge" &&
        !before.grantLetterUrl
      ) {
        finalizationError = {
          error: "pledge_document_required",
          message:
            "A written pledge requires an uploaded pledge document before it can be finalized.",
        };
        return;
      }

      const awarded = money(before.awardedAmount);
      if (awarded <= 0) {
        finalizationError = {
          error: "awarded_amount_required",
          message: "Enter the confirmed pledge amount before finalizing.",
        };
        return;
      }

      const allocations = await tx
        .select()
        .from(pledgeAllocations)
        .where(eq(pledgeAllocations.pledgeOrOpportunityId, id));
      const retiredStatuses = new Set<string>(RETIRED_ALLOCATION_STATUSES);
      const activeAllocations = allocations.filter(
        (row) => !row.status || !retiredStatuses.has(row.status),
      );
      if (activeAllocations.length === 0) {
        finalizationError = {
          error: "pledge_allocations_required",
          message: "Add at least one allocation before finalizing the pledge.",
        };
        return;
      }

      const allocationTotal = activeAllocations.reduce(
        (sum, row) => sum + money(row.subAmount),
        0,
      );
      if (before.disbursementModel === "cost_reimbursement") {
        if (allocationTotal <= 0 || allocationTotal > awarded + 0.005) {
          finalizationError = {
            error: "invalid_reimbursement_plan",
            message:
              "Cost-reimbursement allocations must total more than zero and may not exceed the award ceiling.",
          };
          return;
        }
      } else if (!sameMoney(allocationTotal, awarded)) {
        finalizationError = {
          error: "allocation_total_mismatch",
          message:
            "Allocation amounts must total the confirmed pledge amount before finalizing.",
          details: {
            awardedAmount: awarded.toFixed(2),
            allocationTotal: allocationTotal.toFixed(2),
          },
        };
        return;
      }

      const missingCondition = activeAllocations.find(
        (row) =>
          isConditionalPledge(row.conditional) &&
          !row.conditions?.trim(),
      );
      if (missingCondition) {
        finalizationError = {
          error: "condition_details_required",
          message:
            "Every conditional allocation must describe its conditions before finalizing.",
          details: { allocationId: missingCondition.id },
        };
        return;
      }

      if (before.disbursementModel !== "cost_reimbursement") {
        const expected = await tx
          .select()
          .from(pledgeExpectedPayments)
          .where(eq(pledgeExpectedPayments.pledgeOrOpportunityId, id));
        if (expected.length === 0) {
          finalizationError = {
            error: "payment_schedule_required",
            message:
              "Add at least one expected payment before finalizing this fixed commitment.",
          };
          return;
        }
        if (expected.some((row) => money(row.amount) <= 0)) {
          finalizationError = {
            error: "payment_schedule_amount_required",
            message:
              "Every expected payment needs an amount greater than zero.",
          };
          return;
        }
        const expectedTotal = expected.reduce(
          (sum, row) => sum + money(row.amount),
          0,
        );
        if (!sameMoney(expectedTotal, awarded)) {
          finalizationError = {
            error: "payment_schedule_total_mismatch",
            message:
              "Expected payment amounts must total the confirmed pledge amount.",
            details: {
              awardedAmount: awarded.toFixed(2),
              expectedPaymentTotal: expectedTotal.toFixed(2),
            },
          };
          return;
        }
      }

      for (const allocation of activeAllocations) {
        await tx
          .update(pledgeAllocations)
          .set({
            status: isConditionalPledge(allocation.conditional)
              ? "committed_with_conditions"
              : "committed",
            updatedAt: new Date(),
          })
          .where(eq(pledgeAllocations.id, allocation.id));
      }

      await tx
        .update(opportunitiesAndPledges)
        .set({
          pledgeCommittedAt: body.pledgeCommittedAt,
          actualCompletionDate:
            before.actualCompletionDate ?? body.pledgeCommittedAt,
          writtenPledge: true,
          stage:
            before.stage === "complete"
              ? "verbal_confirmation"
              : before.stage,
          updatedAt: new Date(),
        })
        .where(eq(opportunitiesAndPledges.id, id));
    });

    if (!before) return notFound(res, "opportunity");
    if (freezeDecision) {
      respondFrozen(res, freezeDecision);
      return;
    }
    if (finalizationError) {
      res.status(409).json(finalizationError);
      return;
    }

    await applyDerivedOppFields(id);
    const [after] = await db
      .select()
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, id))
      .limit(1);
    if (!after) return notFound(res, "opportunity");

    await auditUpdate(
      req,
      "pledge",
      id,
      before as Record<string, unknown>,
      after as Record<string, unknown>,
      ["pledgeCommittedAt", "actualCompletionDate", "status"],
      `Finalized ${after.commitmentPath?.replaceAll("_", " ") ?? "pledge"}`,
    );

    res.json({
      ...lifecycleResult(after),
      promptForReportingDeadlines: true,
    });
  }),
);

export default router;
