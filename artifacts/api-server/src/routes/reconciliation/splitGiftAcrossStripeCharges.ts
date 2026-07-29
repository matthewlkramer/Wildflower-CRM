import { Router, type IRouter } from "express";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import {
  db,
  giftAllocations,
  giftsAndPayments,
  paymentUnits,
  stripePayouts,
  stripeStagedCharges,
} from "@workspace/db";
import {
  SplitGiftAcrossStripeChargesBody,
  SplitGiftAcrossStripeChargesParams,
} from "@workspace/api-zod";
import { requireFinance } from "../../lib/financeGuard";
import { getAppUser } from "../../lib/appRequest";
import { asyncHandler, newId, parseOrBadRequest } from "../../lib/helpers";
import {
  applyPaymentApplication,
  CLEARED_TIE_FACTS,
} from "../../lib/paymentApplications";
import { reconAudit, fmtMoney } from "../../lib/reconciliationAudit";
import { resolveGiftFreezeById, respondFrozen } from "../../lib/freezeGuard";

const router: IRouter = Router();

const toCents = (value: string | number | null | undefined): number =>
  Math.round(Number(value ?? 0) * 100);

const normalizedPayer = (value: string | null): string =>
  (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

type DonorIdentity = {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
};

const donorKey = (record: DonorIdentity): string | null => {
  const keys = [
    record.organizationId ? `organization:${record.organizationId}` : null,
    record.individualGiverPersonId
      ? `person:${record.individualGiverPersonId}`
      : null,
    record.householdId ? `household:${record.householdId}` : null,
  ].filter((value): value is string => value != null);
  return keys.length === 1 ? keys[0]! : null;
};

router.post(
  "/reconciliation/deposits/:bankDepositId/split-gift-across-stripe-charges",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const actor = getAppUser(req);
    if (!actor) {
      res
        .status(401)
        .json({ error: "unauthorized", message: "Sign in required." });
      return;
    }
    const params = parseOrBadRequest(
      SplitGiftAcrossStripeChargesParams,
      req.params,
      res,
    );
    if (!params) return;
    const body = parseOrBadRequest(
      SplitGiftAcrossStripeChargesBody,
      req.body,
      res,
    );
    if (!body) return;

    const freeze = await resolveGiftFreezeById(body.giftId);
    if (freeze.frozen) {
      respondFrozen(res, freeze);
      return;
    }

    type Failure = {
      ok: false;
      status: number;
      error: string;
      message: string;
    };
    type Success = {
      ok: true;
      giftIds: string[];
      chargeIds: string[];
      grossAmount: string;
      netAmount: string;
      feeAmount: string;
      giftName: string | null;
    };

    const outcome = await db.transaction(
      async (tx): Promise<Failure | Success> => {
        const payout = await tx
          .select()
          .from(stripePayouts)
          .where(eq(stripePayouts.bankDepositId, params.bankDepositId))
          .for("update")
          .then((rows) => rows[0]);
        if (!payout) {
          return {
            ok: false,
            status: 404,
            error: "payout_not_found",
            message: "No Stripe payout is linked to this bank deposit.",
          };
        }

        const charges = await tx
          .select()
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.stripePayoutId, payout.id))
          .orderBy(
            asc(stripeStagedCharges.dateReceived),
            asc(stripeStagedCharges.id),
          )
          .for("update");
        if (charges.length < 2) {
          return {
            ok: false,
            status: 409,
            error: "not_multi_payment",
            message:
              "This payout does not contain several Stripe payments to split across.",
          };
        }

        const units = await tx
          .select()
          .from(paymentUnits)
          .where(
            inArray(
              paymentUnits.stripeChargeId,
              charges.map((charge) => charge.id),
            ),
          )
          .for("update");
        const unitByCharge = new Map(
          units.flatMap((unit) =>
            unit.stripeChargeId ? [[unit.stripeChargeId, unit] as const] : [],
          ),
        );
        const live = charges.filter((charge) => {
          const unit = unitByCharge.get(charge.id);
          return (
            !!unit &&
            unit.lifecycle === "received" &&
            !charge.exclusionReason &&
            !charge.refunded &&
            !charge.disputed &&
            toCents(charge.amountRefunded) === 0 &&
            toCents(charge.grossAmount) > 0
          );
        });
        if (live.length < 2) {
          return {
            ok: false,
            status: 409,
            error: "not_enough_live_payments",
            message:
              "Fewer than two live, non-excluded Stripe payments remain in this payout.",
          };
        }
        if (live.length !== charges.length) {
          return {
            ok: false,
            status: 409,
            error: "mixed_charge_lifecycle",
            message:
              "This payout contains excluded, refunded, disputed, or otherwise inactive charges. Split the gift manually so those cases remain explicit.",
          };
        }

        const payerNames = new Set(
          live.map((charge) => normalizedPayer(charge.payerName)),
        );
        if (payerNames.size !== 1 || payerNames.has("")) {
          return {
            ok: false,
            status: 409,
            error: "mixed_payers",
            message:
              "The payout contains payments from different or unidentified payers, so one gift cannot safely be copied across all of them.",
          };
        }

        const targetUnits = live.map((charge) => unitByCharge.get(charge.id)!);
        if (
          targetUnits.some(
            (unit) => unit.giftId != null && unit.giftId !== body.giftId,
          )
        ) {
          return {
            ok: false,
            status: 409,
            error: "other_gifts_linked",
            message:
              "At least one payment in this payout already pays a different gift. Resolve those links before splitting this gift across the payout.",
          };
        }

        const gift = await tx
          .select()
          .from(giftsAndPayments)
          .where(eq(giftsAndPayments.id, body.giftId))
          .for("update")
          .then((rows) => rows[0]);
        if (!gift) {
          return {
            ok: false,
            status: 404,
            error: "gift_not_found",
            message: "The selected gift no longer exists.",
          };
        }
        if (gift.archivedAt) {
          return {
            ok: false,
            status: 409,
            error: "gift_archived",
            message: "Restore the selected gift before splitting it.",
          };
        }
        if (gift.overpayOfGiftId) {
          return {
            ok: false,
            status: 409,
            error: "overpay_gift",
            message:
              "Audit-close surplus gifts cannot be split from the workbench.",
          };
        }

        const selectedGiftDonor = donorKey(gift);
        if (!selectedGiftDonor) {
          return {
            ok: false,
            status: 409,
            error: "gift_donor_invalid",
            message:
              "The selected gift does not have one unambiguous donor, so it cannot be copied across the payout.",
          };
        }
        const conflictingChargeDonor = live.find((charge) => {
          const chargeDonor = donorKey(charge);
          return chargeDonor != null && chargeDonor !== selectedGiftDonor;
        });
        if (conflictingChargeDonor) {
          return {
            ok: false,
            status: 409,
            error: "donor_mismatch",
            message:
              "The selected gift's donor disagrees with the donor already resolved on at least one Stripe payment.",
          };
        }

        const targetUnitIds = targetUnits.map((unit) => unit.id);
        const otherGiftUnits = await tx
          .select({ id: paymentUnits.id })
          .from(paymentUnits)
          .where(
            and(
              eq(paymentUnits.giftId, gift.id),
              notInArray(paymentUnits.id, targetUnitIds),
            ),
          )
          .limit(1);
        if (otherGiftUnits.length) {
          return {
            ok: false,
            status: 409,
            error: "gift_has_other_payments",
            message:
              "This gift is already funded by a payment outside this payout. Unlink that payment before splitting.",
          };
        }

        const allocations = await tx
          .select()
          .from(giftAllocations)
          .where(eq(giftAllocations.giftId, gift.id))
          .orderBy(asc(giftAllocations.id))
          .for("update");
        if (allocations.length !== 1) {
          return {
            ok: false,
            status: 409,
            error: "multiple_allocations",
            message:
              "Automatic payout splitting currently requires exactly one gift allocation so the designation can be copied without guessing. Split this gift manually or consolidate its allocations first.",
          };
        }

        const grossCents = live.reduce(
          (sum, charge) => sum + toCents(charge.grossAmount),
          0,
        );
        const netCents = toCents(payout.netTotal ?? payout.amount);
        const giftCents = toCents(gift.amount);
        const feeCents = toCents(payout.feeTotal);
        const refundCents = toCents(payout.refundTotal);
        const adjustmentCents = toCents(payout.adjustmentTotal);
        const matchesGross = Math.abs(giftCents - grossCents) <= 1;
        const matchesNet =
          Math.abs(giftCents - netCents) <= 1 &&
          refundCents === 0 &&
          adjustmentCents === 0 &&
          Math.abs(grossCents - feeCents - netCents) <= 1;
        if (!matchesGross && !matchesNet) {
          return {
            ok: false,
            status: 409,
            error: "amount_not_payout_total",
            message:
              "The selected gift amount matches neither the payout gross nor its fee-explained net amount, so it cannot be safely split across every charge.",
          };
        }

        const template = allocations[0]!;
        const giftIds: string[] = [gift.id];
        const now = new Date();
        const firstAmount = live[0]!.grossAmount!;
        await tx
          .update(giftsAndPayments)
          .set({
            amount: firstAmount,
            awaitingSettlement: false,
            updatedAt: now,
          })
          .where(eq(giftsAndPayments.id, gift.id));
        await tx
          .update(giftAllocations)
          .set({ subAmount: firstAmount, updatedAt: now })
          .where(eq(giftAllocations.id, template.id));

        for (const charge of live.slice(1)) {
          const newGiftId = newId();
          await tx.insert(giftsAndPayments).values({
            id: newGiftId,
            name: gift.name,
            details: gift.details,
            fundraisingCampaign: gift.fundraisingCampaign,
            campaignSlug: gift.campaignSlug,
            titleReference: gift.titleReference,
            memoDescription: gift.memoDescription,
            dateReceived: gift.dateReceived,
            paymentMethod: gift.paymentMethod,
            amount: charge.grossAmount,
            organizationId: gift.organizationId,
            individualGiverPersonId: gift.individualGiverPersonId,
            householdId: gift.householdId,
            loanOrGrant: gift.loanOrGrant,
            opportunityId: gift.opportunityId,
            advisorPersonId: gift.advisorPersonId,
            giftBeingMatchedId: gift.giftBeingMatchedId,
            primaryContactPersonId: gift.primaryContactPersonId,
            paymentIntermediaryId: gift.paymentIntermediaryId,
            ownerUserId: gift.ownerUserId,
            awaitingSettlement: false,
            tags: gift.tags,
            sourceRecordUrl: gift.sourceRecordUrl,
          });
          await tx.insert(giftAllocations).values({
            id: newId(),
            giftId: newGiftId,
            subAmount: charge.grossAmount,
            grantYear: template.grantYear,
            entityId: template.entityId,
            intendedUsage: template.intendedUsage,
            fundableProjectId: template.fundableProjectId,
            regionalRestrictionType: template.regionalRestrictionType,
            otherRestrictionType: template.otherRestrictionType,
            timeRestrictionType: template.timeRestrictionType,
            reimbursementType: template.reimbursementType,
            countsTowardGoal: template.countsTowardGoal,
            schoolRecipientId: template.schoolRecipientId,
            spendingStart: template.spendingStart,
            spendingEnd: template.spendingEnd,
            regionIds: template.regionIds,
            purposeVerbatim: template.purposeVerbatim,
            restrictionDescription: template.restrictionDescription,
            charterRecipientId: template.charterRecipientId,
            seedFund: template.seedFund,
            schoolSupportType: template.schoolSupportType,
            sourcePledgeAllocationId: template.sourcePledgeAllocationId,
            varianceReason: template.varianceReason,
            schoolDesignationType: template.schoolDesignationType,
            entityDesignationType: template.entityDesignationType,
            regionalDesignationType: template.regionalDesignationType,
            projectDesignationType: template.projectDesignationType,
          });
          giftIds.push(newGiftId);
        }

        await tx
          .update(paymentUnits)
          .set({ ...CLEARED_TIE_FACTS, updatedAt: now })
          .where(inArray(paymentUnits.id, targetUnitIds));
        for (let index = 0; index < live.length; index += 1) {
          const charge = live[index]!;
          await applyPaymentApplication(tx, {
            giftId: giftIds[index]!,
            amountApplied: charge.grossAmount!,
            evidenceSource: "stripe",
            stripeChargeId: charge.id,
            matchMethod: "human",
            confirmedByUserId: actor.id,
            confirmedAt: now,
            createdTheGift: index > 0,
          });
        }

        return {
          ok: true,
          giftIds,
          chargeIds: live.map((charge) => charge.id),
          grossAmount: (grossCents / 100).toFixed(2),
          netAmount: (netCents / 100).toFixed(2),
          feeAmount: (feeCents / 100).toFixed(2),
          giftName: gift.name,
        };
      },
    );

    if (!outcome.ok) {
      res.status(outcome.status).json({
        error: outcome.error,
        message: outcome.message,
      });
      return;
    }

    await reconAudit(req, {
      action: "update",
      entityType: "gift",
      entityId: body.giftId,
      summary: `Split “${outcome.giftName ?? body.giftId}” into ${outcome.giftIds.length} per-payment gifts (${fmtMoney(outcome.grossAmount)} gross; ${fmtMoney(outcome.feeAmount)} Stripe fees)`,
      undo: null,
      extra: {
        bankDepositId: params.bankDepositId,
        chargeIds: outcome.chargeIds,
        giftIds: outcome.giftIds,
      },
    });

    res.json(outcome);
  }),
);

export default router;
