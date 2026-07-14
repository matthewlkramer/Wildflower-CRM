import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { giftsAndPayments, stripeStagedCharges } from "@workspace/db/schema";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, newId, paramId } from "../lib/helpers";
import {
  LinkStripeChargeToGiftBody,
  validateGiftInvariants,
} from "@workspace/api-zod";
import {
  donorOf,
  donorsMatch,
  hasExactlyOneDonor,
} from "../lib/quickbooksLink";
import {
  createGiftFromChargeInTx,
  linkChargeToGiftInTx,
} from "../lib/reconciliationBundleCommit";
import { ReconcileAbort } from "../lib/reconciliationCommit";
import {
  getStripeChargeGiftRelationship,
  stripeChargeActiveGiftIdSql,
} from "../lib/stripeChargeLedger";
import { removePaymentApplicationsForStripeCharge } from "../lib/paymentApplications";
import { applyGiftQbTieMany } from "../lib/giftQbTie";
import { applyDerivedOppFieldsMany } from "../lib/pledgeStage";
import { chargeStatusSql } from "../lib/derivedStatus";
import { giftHeaderColumns } from "./giftsAndPayments";

const router: IRouter = Router();
const {
  rawCharge: _rawCharge,
  matchedGiftId: _matchedGiftId,
  createdGiftId: _createdGiftId,
  ...safeChargeColumns
} = getTableColumns(stripeStagedCharges);

async function loadSafeCharge(chargeId: string) {
  return db
    .select({
      ...safeChargeColumns,
      status: chargeStatusSql,
      resolvedGiftId: stripeChargeActiveGiftIdSql(sql`${stripeStagedCharges.id}`),
    })
    .from(stripeStagedCharges)
    .where(eq(stripeStagedCharges.id, chargeId))
    .then((rows) => rows[0] ?? null);
}

const linkHandler = asyncHandler(async (req, res) => {
  const user = getAppUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const chargeId = paramId(req);
  const parsed = LinkStripeChargeToGiftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "validation_error",
      message: "Request validation failed",
      details: parsed.error.flatten(),
    });
    return;
  }
  const { giftId } = parsed.data;
  const rederivePledgeIds: string[] = [];
  let alreadyLinked = false;

  try {
    await db.transaction(async (tx) => {
      const gift = await tx
        .select()
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, giftId))
        .for("update")
        .then((rows) => rows[0]);
      if (!gift) {
        throw new ReconcileAbort(404, {
          error: "not_found",
          message: "Gift not found.",
        });
      }
      if (gift.archivedAt != null) {
        throw new ReconcileAbort(409, {
          error: "gift_archived",
          message: "That gift is archived. Restore it before linking.",
        });
      }

      const charge = await tx
        .select()
        .from(stripeStagedCharges)
        .where(eq(stripeStagedCharges.id, chargeId))
        .for("update")
        .then((rows) => rows[0]);
      if (!charge) {
        throw new ReconcileAbort(404, {
          error: "not_found",
          message: "Stripe staged charge not found.",
        });
      }

      const relationship = await getStripeChargeGiftRelationship(tx, chargeId, {
        includeProposed: true,
      });
      if (relationship?.lifecycle === "confirmed") {
        if (relationship.giftId === giftId) {
          alreadyLinked = true;
          return;
        }
        throw new ReconcileAbort(409, {
          error: "not_pending",
          message:
            "This Stripe charge is already confirmed to a different gift. Revert it before re-linking.",
          existingGiftId: relationship.giftId,
        });
      }
      if (relationship?.lifecycle === "proposed") {
        await removePaymentApplicationsForStripeCharge(tx, chargeId);
      }

      const giftDonor = donorOf(gift);
      let effectiveGiftDonor = giftDonor;
      let donorSwitching = false;
      if (parsed.data.switchGiftDonor === true) {
        const chosen = {
          organizationId: parsed.data.organizationId ?? null,
          individualGiverPersonId:
            parsed.data.individualGiverPersonId ?? null,
          householdId: parsed.data.householdId ?? null,
        };
        if (!hasExactlyOneDonor(chosen)) {
          throw new ReconcileAbort(400, {
            error: "donor_xor",
            message:
              "A donor switch needs exactly one donor (organization, person, or household).",
          });
        }
        if (!donorsMatch(giftDonor, chosen)) {
          effectiveGiftDonor = chosen;
          donorSwitching = true;
        }
      }

      const result = await linkChargeToGiftInTx(tx, {
        charge,
        gift,
        giftId,
        effectiveGiftDonor,
        donorSwitching,
        userId: user.id,
        auditReq: req,
      });
      rederivePledgeIds.push(...result.rederivePledgeIds);
    });
  } catch (error) {
    if (error instanceof ReconcileAbort) {
      res.status(error.httpStatus).json(error.payload);
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      res.status(409).json({
        error: "link_conflict",
        message:
          "That gift was just linked to another Stripe charge. Refresh and try again.",
      });
      return;
    }
    throw error;
  }

  if (!alreadyLinked) {
    if (rederivePledgeIds.length > 0) {
      await applyDerivedOppFieldsMany(...rederivePledgeIds);
    }
    await applyGiftQbTieMany(giftId);
  }
  res.json(await loadSafeCharge(chargeId));
});

router.post(
  "/stripe-staged-charges/:id/link-gift",
  requireAuth,
  (req, res, next) => {
    if (
      req.body != null &&
      typeof req.body === "object" &&
      (req.body as { switchStripeSource?: unknown }).switchStripeSource === true
    ) {
      next();
      return;
    }
    void linkHandler(req, res, next);
  },
);

router.post(
  "/stripe-staged-charges/:id/create-gift",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const chargeId = paramId(req);
    const giftId = newId();
    let created = false;

    try {
      await db.transaction(async (tx) => {
        const charge = await tx
          .select()
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.id, chargeId))
          .for("update")
          .then((rows) => rows[0]);
        if (!charge) {
          throw new ReconcileAbort(404, {
            error: "not_found",
            message: "Stripe staged charge not found.",
          });
        }
        const relationship = await getStripeChargeGiftRelationship(tx, chargeId, {
          includeProposed: true,
        });
        if (relationship != null) {
          throw new ReconcileAbort(409, {
            error: "not_pending",
            message: "This staged charge has already been resolved.",
            existingGiftId: relationship.giftId,
          });
        }

        const donor = {
          organizationId: charge.organizationId,
          individualGiverPersonId: charge.individualGiverPersonId,
          householdId: charge.householdId,
        };
        const issues = validateGiftInvariants(donor);
        if (issues.length > 0) {
          throw new ReconcileAbort(400, {
            error: "validation_error",
            message: issues.map((issue) => issue.message).join("; "),
            issues,
          });
        }

        await createGiftFromChargeInTx(tx, {
          newGiftId: giftId,
          charge,
          donor,
          paymentIntermediaryId: charge.matchedPaymentIntermediaryId,
          userId: user.id,
          auditReq: req,
          audit: {
            summary: "Minted gift from Stripe charge",
            metadata: { stripeChargeId: charge.id, outcome: "create_gift" },
          },
        });
        created = true;
      });
    } catch (error) {
      if (error instanceof ReconcileAbort) {
        res.status(error.httpStatus).json(error.payload);
        return;
      }
      throw error;
    }

    if (!created) return;
    await applyGiftQbTieMany(giftId);
    const [gift] = await db
      .select(giftHeaderColumns)
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId));
    res.status(201).json({ gift, stagedPaymentId: chargeId });
  }),
);

export default router;
