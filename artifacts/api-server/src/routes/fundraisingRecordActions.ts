import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  giftAllocations,
  giftsAndPayments,
  opportunitiesAndPledges,
  paymentUnits,
  pledgeAllocations,
  pledgeExpectedPayments,
  stripeStagedCharges,
} from "@workspace/db/schema";
import {
  RevertPledgeToOpportunityBody,
  RevertPledgeToVerbalGiftBody,
} from "@workspace/api-zod";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import {
  asyncHandler,
  notFound,
  paramId,
  parseOrBadRequest,
} from "../lib/helpers";
import { recordAudit } from "../lib/audit";
import {
  applyDerivedOppFields,
  applyDerivedOppFieldsMany,
} from "../lib/pledgeStage";
import {
  freezeMessage,
  resolveGiftFreeze,
  resolvePledgeFreeze,
  resolvePledgeFreezeById,
  type FreezeDecision,
} from "../lib/freezeGuard";

const router: IRouter = Router();
router.use(requireAuth);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ActionFailure = {
  status: number;
  body: Record<string, unknown>;
};

function freezeFailure(decision: FreezeDecision): ActionFailure | null {
  if (!decision.frozen) return null;
  return {
    status: 409,
    body: {
      error: "fiscal_year_frozen",
      message: freezeMessage(decision),
      details: {
        side: decision.side,
        fiscalYearId: decision.fiscalYearId,
        fiscalYearLabel: decision.fiscalYearLabel,
      },
    },
  };
}

type PledgeConversionOutcome =
  | { ok: true; giftId: string }
  | ({ ok: false } & ActionFailure);

const CorrectionReasonBody = z.object({
  reason: z.string().nullable().optional(),
});

function cents(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function appendReason(
  existing: string | null,
  reason: string | null | undefined,
) {
  const correction = reason?.trim()
    ? `Correction: ${reason.trim()}`
    : "Correction: record was mischaracterized.";
  return [existing?.trim(), correction].filter(Boolean).join("\n\n");
}

async function ensureRevertiblePledge(
  tx: Tx,
  id: string,
): Promise<
  | { ok: true; pledge: typeof opportunitiesAndPledges.$inferSelect }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const pledge = await tx
    .select()
    .from(opportunitiesAndPledges)
    .where(eq(opportunitiesAndPledges.id, id))
    .for("update")
    .then((rows) => rows[0]);
  if (!pledge) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }
  if (pledge.archivedAt) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "pledge_archived",
        message: "Restore this pledge before correcting its lifecycle.",
      },
    };
  }
  if (!pledge.pledgeCommittedAt && !pledge.writtenPledge) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "not_a_pledge",
        message: "This record is not a finalized pledge.",
      },
    };
  }
  if (pledge.isWriteOff || pledge.writeOffOfPledgeId) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "write_off_pledge",
        message:
          "Write-off pledges require their dedicated correction workflow.",
      },
    };
  }
  const frozen = freezeFailure(
    await resolvePledgeFreeze(pledge.actualCompletionDate),
  );
  if (frozen) return { ok: false, ...frozen };
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.opportunityId, id));
  if (n > 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "pledge_has_payments",
        message:
          "This pledge already has a linked payment. Correct the payment or convert the one-payment pledge to a stand-alone gift instead.",
      },
    };
  }
  return { ok: true, pledge };
}

async function resetAllocationStatuses(tx: Tx, pledgeId: string) {
  await tx
    .update(pledgeAllocations)
    .set({ status: "working", updatedAt: new Date() })
    .where(eq(pledgeAllocations.pledgeOrOpportunityId, pledgeId));
}

router.post(
  "/opportunities-and-pledges/:id/convert-to-standalone-gift",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(CorrectionReasonBody, req.body ?? {}, res);
    if (!body) return;
    const id = paramId(req);

    let outcome: PledgeConversionOutcome | null = null;

    await db.transaction(async (tx) => {
      const pledge = await tx
        .select()
        .from(opportunitiesAndPledges)
        .where(eq(opportunitiesAndPledges.id, id))
        .for("update")
        .then((rows) => rows[0]);
      if (!pledge) {
        outcome = { ok: false, status: 404, body: { error: "not_found" } };
        return;
      }
      if (pledge.archivedAt) {
        outcome = {
          ok: false,
          status: 409,
          body: {
            error: "pledge_archived",
            message: "Restore this pledge before converting it.",
          },
        };
        return;
      }
      if (!pledge.pledgeCommittedAt && !pledge.writtenPledge) {
        outcome = {
          ok: false,
          status: 409,
          body: {
            error: "not_a_pledge",
            message: "Only a finalized pledge can be converted to a gift.",
          },
        };
        return;
      }
      if (pledge.disbursementModel !== "fixed_commitment") {
        outcome = {
          ok: false,
          status: 409,
          body: {
            error: "not_fixed_commitment",
            message:
              "Cost-reimbursement awards cannot be rewritten as a one-payment stand-alone gift.",
          },
        };
        return;
      }
      if (pledge.isWriteOff || pledge.writeOffOfPledgeId) {
        outcome = {
          ok: false,
          status: 409,
          body: {
            error: "write_off_pledge",
            message: "Write-off pledges cannot be converted to gifts.",
          },
        };
        return;
      }

      const linkedGifts = await tx
        .select()
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.opportunityId, id))
        .for("update");
      if (linkedGifts.length !== 1 || linkedGifts[0]!.archivedAt) {
        outcome = {
          ok: false,
          status: 409,
          body: {
            error: "one_payment_required",
            message:
              "Conversion requires exactly one active gift/payment and no additional archived payments.",
          },
        };
        return;
      }
      const gift = linkedGifts[0]!;
      if (
        cents(gift.amount) <= 0 ||
        cents(pledge.awardedAmount) <= 0 ||
        cents(gift.amount) !== cents(pledge.awardedAmount)
      ) {
        outcome = {
          ok: false,
          status: 409,
          body: {
            error: "amount_not_fully_paid",
            message:
              "The single gift must equal the pledge's full committed amount.",
          },
        };
        return;
      }

      const units = await tx
        .select()
        .from(paymentUnits)
        .where(eq(paymentUnits.giftId, gift.id))
        .for("update");
      if (
        units.length !== 1 ||
        units[0]!.lifecycle !== "received" ||
        cents(units[0]!.grossAmount ?? units[0]!.netAmount) !==
          cents(gift.amount)
      ) {
        outcome = {
          ok: false,
          status: 409,
          body: {
            error: "one_received_payment_required",
            message:
              "Conversion requires exactly one received payment unit whose amount equals the gift.",
          },
        };
        return;
      }
      const unit = units[0]!;
      if (unit.stripeChargeId) {
        const [charge] = await tx
          .select({
            refunded: stripeStagedCharges.refunded,
            disputed: stripeStagedCharges.disputed,
            amountRefunded: stripeStagedCharges.amountRefunded,
          })
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.id, unit.stripeChargeId))
          .limit(1);
        if (
          charge?.refunded ||
          charge?.disputed ||
          cents(charge?.amountRefunded) > 0
        ) {
          outcome = {
            ok: false,
            status: 409,
            body: {
              error: "payment_refunded_or_disputed",
              message:
                "The one payment has refund or dispute activity and cannot be flattened into a stand-alone gift.",
            },
          };
          return;
        }
      }

      // This correction changes both the gift's classification metadata and
      // the pledge's audited lifecycle. It must not rewrite either side of a
      // closed fiscal year, nor move the pledge's recognition date into one.
      const giftFrozen = freezeFailure(
        await resolveGiftFreeze(gift.dateReceived),
      );
      if (giftFrozen) {
        outcome = { ok: false, ...giftFrozen };
        return;
      }
      const targetCompletionDate =
        gift.dateReceived ??
        unit.receivedDate ??
        pledge.actualCompletionDate ??
        null;
      const pledgeFrozen = freezeFailure(
        await resolvePledgeFreeze(
          pledge.actualCompletionDate,
          targetCompletionDate,
        ),
      );
      if (pledgeFrozen) {
        outcome = { ok: false, ...pledgeFrozen };
        return;
      }

      const [writeOffChild, surplusChild] = await Promise.all([
        tx
          .select({ id: opportunitiesAndPledges.id })
          .from(opportunitiesAndPledges)
          .where(
            and(
              eq(opportunitiesAndPledges.writeOffOfPledgeId, id),
              isNull(opportunitiesAndPledges.archivedAt),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
        tx
          .select({ id: giftsAndPayments.id })
          .from(giftsAndPayments)
          .where(
            and(
              eq(giftsAndPayments.overpayOfGiftId, gift.id),
              isNull(giftsAndPayments.archivedAt),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
      ]);
      if (writeOffChild || gift.overpayOfGiftId || surplusChild) {
        outcome = {
          ok: false,
          status: 409,
          body: {
            error: "correction_chain_exists",
            message:
              "A pledge write-off or gift overpayment correction already exists, so this record cannot be flattened safely.",
          },
        };
        return;
      }

      const allocations = await tx
        .select({ amount: giftAllocations.subAmount })
        .from(giftAllocations)
        .where(eq(giftAllocations.giftId, gift.id));
      const allocationTotal = allocations.reduce(
        (sum, row) => sum + cents(row.amount),
        0,
      );
      if (allocations.length === 0 || allocationTotal !== cents(gift.amount)) {
        outcome = {
          ok: false,
          status: 409,
          body: {
            error: "gift_allocations_incomplete",
            message:
              "The gift's allocations must be complete and equal the gift amount before conversion.",
          },
        };
        return;
      }

      await tx
        .update(giftsAndPayments)
        .set({
          // Keep the originating opportunity link. Once the pledge boundary is
          // removed below, this becomes an ordinary stand-alone gift outcome,
          // not a pledge payment (gift type is derived from the linked record).
          name: gift.name ?? pledge.name,
          details: gift.details ?? pledge.usageNotes,
          grantLetterUrl: gift.grantLetterUrl ?? pledge.grantLetterUrl,
          grantLetterFilename:
            gift.grantLetterFilename ?? pledge.grantLetterFilename,
          grantLetterUploadedAt:
            gift.grantLetterUploadedAt ?? pledge.grantLetterUploadedAt,
          primaryContactPersonId:
            gift.primaryContactPersonId ?? pledge.primaryContactPersonId,
          advisorPersonId:
            gift.advisorPersonId ?? pledge.individualAdvisorPersonId,
          ownerUserId: gift.ownerUserId ?? pledge.ownerUserId,
          updatedAt: new Date(),
        })
        .where(eq(giftsAndPayments.id, gift.id));

      // Rewrite the lifecycle exactly as though the donor had committed to one
      // stand-alone gift and then paid it. The fundraising history remains on
      // this row, but it is no longer a pledge and no installment schedule
      // survives the correction.
      await tx
        .delete(pledgeExpectedPayments)
        .where(eq(pledgeExpectedPayments.pledgeOrOpportunityId, id));
      await resetAllocationStatuses(tx, id);
      const giftCommitmentDate =
        pledge.verbalCommitmentAt ??
        pledge.pledgeCommittedAt ??
        gift.dateReceived ??
        unit.receivedDate ??
        null;
      if (!giftCommitmentDate) {
        outcome = {
          ok: false,
          status: 409,
          body: {
            error: "payment_date_missing",
            message:
              "The received payment needs a date before the pledge can be rewritten as an original stand-alone gift.",
          },
        };
        return;
      }
      await tx
        .update(opportunitiesAndPledges)
        .set({
          commitmentPath: "gift",
          verbalCommitmentAt: giftCommitmentDate,
          pledgeCommittedAt: null,
          writtenPledge: false,
          stage: "verbal_confirmation",
          lossType: null,
          askAmount: pledge.askAmount ?? pledge.awardedAmount ?? gift.amount,
          awardedAmount: gift.amount,
          actualCompletionDate:
            gift.dateReceived ??
            unit.receivedDate ??
            pledge.actualCompletionDate,
          awardClosedAt: null,
          awardCloseReason: null,
          usageNotes: appendReason(pledge.usageNotes, body.reason),
          archivedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(opportunitiesAndPledges.id, id));

      await recordAudit(tx, req, {
        action: "update",
        entityType: "gift",
        entityId: gift.id,
        summary: "Rewrote pledge payment as original stand-alone gift",
        metadata: {
          rewrittenOpportunityId: id,
          reason: body.reason ?? null,
          paymentEvidenceChanged: false,
          accountingEvidenceChanged: false,
        },
      });
      await recordAudit(tx, req, {
        action: "update",
        entityType: "opportunity",
        entityId: id,
        summary: "Rewrote mischaracterized pledge as stand-alone gift outcome",
        changes: [
          {
            field: "commitmentPath",
            from: pledge.commitmentPath,
            to: "gift",
          },
          {
            field: "pledgeCommittedAt",
            from: pledge.pledgeCommittedAt,
            to: null,
          },
        ],
        metadata: {
          survivingGiftId: gift.id,
          reason: body.reason ?? null,
        },
      });
      outcome = { ok: true, giftId: gift.id };
    });

    const result = outcome as PledgeConversionOutcome | null;
    if (!result) throw new Error("pledge_conversion_no_outcome");
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    await applyDerivedOppFields(id);
    res.json({ giftId: result.giftId, opportunityId: id });
  }),
);

router.post(
  "/opportunities-and-pledges/:id/revert-to-verbal-gift",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(RevertPledgeToVerbalGiftBody, req.body, res);
    if (!body) return;
    const id = paramId(req);
    let failure: { status: number; body: Record<string, unknown> } | null =
      null;

    await db.transaction(async (tx) => {
      const checked = await ensureRevertiblePledge(tx, id);
      if (!checked.ok) {
        failure = { status: checked.status, body: checked.body };
        return;
      }
      const before = checked.pledge;
      await tx
        .delete(pledgeExpectedPayments)
        .where(eq(pledgeExpectedPayments.pledgeOrOpportunityId, id));
      await resetAllocationStatuses(tx, id);
      await tx
        .update(opportunitiesAndPledges)
        .set({
          commitmentPath: "gift",
          verbalCommitmentAt: body.commitmentDate,
          pledgeCommittedAt: null,
          writtenPledge: false,
          stage: "verbal_confirmation",
          lossType: null,
          actualCompletionDate: null,
          awardClosedAt: null,
          awardCloseReason: null,
          projectedCloseDate: body.expectedDate ?? null,
          usageNotes: appendReason(before.usageNotes, body.reason),
          updatedAt: new Date(),
        })
        .where(eq(opportunitiesAndPledges.id, id));
      await recordAudit(tx, req, {
        action: "update",
        entityType: "opportunity",
        entityId: id,
        summary: "Reverted pledge to verbal gift commitment awaiting payment",
        metadata: { reason: body.reason ?? null },
      });
    });

    const result = failure as ActionFailure | null;
    if (result) {
      res.status(result.status).json(result.body);
      return;
    }
    await applyDerivedOppFields(id);
    const row = await db
      .select()
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, id))
      .then((rows) => rows[0]);
    if (!row) return notFound(res, "opportunity");
    res.json(row);
  }),
);

router.post(
  "/opportunities-and-pledges/:id/revert-to-opportunity",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(
      RevertPledgeToOpportunityBody,
      req.body,
      res,
    );
    if (!body) return;
    const id = paramId(req);
    let failure: { status: number; body: Record<string, unknown> } | null =
      null;

    await db.transaction(async (tx) => {
      const checked = await ensureRevertiblePledge(tx, id);
      if (!checked.ok) {
        failure = { status: checked.status, body: checked.body };
        return;
      }
      const before = checked.pledge;
      await tx
        .delete(pledgeExpectedPayments)
        .where(eq(pledgeExpectedPayments.pledgeOrOpportunityId, id));
      await resetAllocationStatuses(tx, id);
      await tx
        .update(opportunitiesAndPledges)
        .set({
          askAmount: before.askAmount ?? before.awardedAmount,
          awardedAmount: null,
          commitmentPath: null,
          verbalCommitmentAt: null,
          pledgeCommittedAt: null,
          writtenPledge: false,
          stage: body.stage ?? "in_conversation",
          lossType: null,
          actualCompletionDate: null,
          awardClosedAt: null,
          awardCloseReason: null,
          projectedCloseDate:
            body.projectedCloseDate === undefined
              ? before.projectedCloseDate
              : body.projectedCloseDate,
          usageNotes: appendReason(before.usageNotes, body.reason),
          updatedAt: new Date(),
        })
        .where(eq(opportunitiesAndPledges.id, id));
      await recordAudit(tx, req, {
        action: "update",
        entityType: "opportunity",
        entityId: id,
        summary: "Reverted pledge to general opportunity",
        metadata: { reason: body.reason ?? null },
      });
    });

    const result = failure as ActionFailure | null;
    if (result) {
      res.status(result.status).json(result.body);
      return;
    }
    await applyDerivedOppFields(id);
    const row = await db
      .select()
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, id))
      .then((rows) => rows[0]);
    if (!row) return notFound(res, "opportunity");
    res.json(row);
  }),
);

router.post(
  "/gifts-and-payments/:id/detach-from-pledge",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(CorrectionReasonBody, req.body ?? {}, res);
    if (!body) return;
    const id = paramId(req);
    let formerOpportunityId: string | null = null;

    const changed = await db.transaction(async (tx) => {
      const gift = await tx
        .select()
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, id))
        .for("update")
        .then((rows) => rows[0]);
      if (!gift) return null;
      if (!gift.opportunityId) return { kind: "not_linked" as const };

      // Detaching changes both the gift's audited pledge relationship and the
      // former pledge's derived paid/lifecycle state. Either closed side makes
      // the correction immutable.
      const giftFrozen = freezeFailure(
        await resolveGiftFreeze(gift.dateReceived),
      );
      if (giftFrozen) {
        return { kind: "frozen" as const, failure: giftFrozen };
      }
      const pledgeFrozen = freezeFailure(
        await resolvePledgeFreezeById(gift.opportunityId),
      );
      if (pledgeFrozen) {
        return { kind: "frozen" as const, failure: pledgeFrozen };
      }
      formerOpportunityId = gift.opportunityId;
      await tx
        .update(giftsAndPayments)
        .set({ opportunityId: null, updatedAt: new Date() })
        .where(eq(giftsAndPayments.id, id));
      await recordAudit(tx, req, {
        action: "update",
        entityType: "gift",
        entityId: id,
        summary:
          "Detached mislinked pledge payment and restored stand-alone gift",
        changes: [
          { field: "opportunityId", from: gift.opportunityId, to: null },
        ],
        metadata: {
          reason: body.reason ?? null,
          paymentEvidenceChanged: false,
          accountingEvidenceChanged: false,
        },
      });
      return { kind: "ok" as const };
    });

    if (!changed) return notFound(res, "gift");
    if (changed.kind === "not_linked") {
      res.status(409).json({
        error: "gift_not_on_pledge",
        message: "This gift is already a stand-alone gift.",
      });
      return;
    }
    if (changed.kind === "frozen") {
      res.status(changed.failure.status).json(changed.failure.body);
      return;
    }
    await applyDerivedOppFieldsMany(formerOpportunityId);
    res.json({ giftId: id, formerOpportunityId: formerOpportunityId! });
  }),
);

export default router;
