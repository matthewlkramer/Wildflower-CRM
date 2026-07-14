import type { db } from "@workspace/db";
import {
  giftAllocations,
  giftsAndPayments,
  paymentApplications,
  stagedPayments,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  adjustSingleAllocationOrFlag,
  unstampGiftFinalAmount,
} from "./giftFinalAmount";
import { getStripeChargeGiftRelationship } from "./stripeChargeLedger";
import {
  removeQuickBooksApplicationsAndRefresh,
  removeStripeChargeApplicationsAndRefresh,
} from "./paymentApplicationMutations";
import { isFullyRefunded } from "./stripeRefund";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class StripeChargeRevertError extends Error {
  constructor(
    public readonly code: "not_found" | "not_revertible" | "gift_missing",
    message: string,
  ) {
    super(message);
    this.name = "StripeChargeRevertError";
  }
}

export interface StripeChargeRevertResult {
  chargeId: string;
  relationshipGiftId: string;
  survivingGiftId: string | null;
  deletedGiftId: string | null;
  cascadedQbStagedIds: string[];
  affectedGiftIds: string[];
}

async function cascadeResetDirectQbLinks(
  tx: Tx,
  giftId: string,
  opts: { unstampGift: boolean },
): Promise<{ stagedPaymentIds: string[]; affectedGiftIds: string[] }> {
  const rows = await tx
    .select({ id: stagedPayments.id })
    .from(stagedPayments)
    .where(
      and(
        eq(stagedPayments.matchedGiftId, giftId),
        isNull(stagedPayments.createdGiftId),
        isNull(stagedPayments.groupReconciledGiftId),
      ),
    )
    .for("update");

  const stagedPaymentIds: string[] = [];
  const affectedGiftIds = new Set<string>([giftId]);
  for (const row of rows) {
    const removal = await removeQuickBooksApplicationsAndRefresh(tx, row.id);
    for (const affectedGiftId of removal.affectedGiftIds) {
      affectedGiftIds.add(affectedGiftId);
    }

    if (opts.unstampGift) {
      const unstamped = await unstampGiftFinalAmount(tx, giftId, {
        source: "quickbooks",
        qbStagedPaymentId: row.id,
      });
      if (unstamped.restored) {
        await adjustSingleAllocationOrFlag(
          tx,
          giftId,
          unstamped.oldAmount,
          unstamped.newAmount,
          "quickbooks",
        );
      }
    }

    await tx
      .update(stagedPayments)
      .set({
        matchedGiftId: null,
        autoApplied: false,
        matchConfirmedByUserId: null,
        matchConfirmedAt: null,
        approvedByUserId: null,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(stagedPayments.id, row.id));
    stagedPaymentIds.push(row.id);
  }

  return { stagedPaymentIds, affectedGiftIds: [...affectedGiftIds] };
}

export async function revertStripeChargeInTx(
  tx: Tx,
  chargeId: string,
): Promise<StripeChargeRevertResult> {
  const charge = await tx
    .select()
    .from(stripeStagedCharges)
    .where(eq(stripeStagedCharges.id, chargeId))
    .for("update")
    .then((rows) => rows[0]);
  if (!charge) {
    throw new StripeChargeRevertError(
      "not_found",
      "Stripe staged charge not found.",
    );
  }

  const relationship = await getStripeChargeGiftRelationship(tx, chargeId, {
    includeProposed: true,
  });
  if (!relationship) {
    throw new StripeChargeRevertError(
      "not_revertible",
      "Only a proposed or confirmed Stripe gift application can be reverted.",
    );
  }

  const giftId = relationship.giftId;
  const affectedGiftIds = new Set<string>([giftId]);
  const cascadedQbStagedIds: string[] = [];
  let survivingGiftId: string | null = null;
  let deletedGiftId: string | null = null;

  if (relationship.lifecycle === "proposed") {
    const removal = await removeStripeChargeApplicationsAndRefresh(tx, chargeId);
    for (const affectedGiftId of removal.affectedGiftIds) {
      affectedGiftIds.add(affectedGiftId);
    }
  } else {
    const gift = await tx
      .select({ id: giftsAndPayments.id })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId))
      .for("update")
      .then((rows) => rows[0]);
    if (!gift) {
      throw new StripeChargeRevertError(
        "gift_missing",
        "The confirmed Stripe application points to a missing gift.",
      );
    }

    const cascade = await cascadeResetDirectQbLinks(tx, giftId, {
      unstampGift: !relationship.createdTheGift,
    });
    cascadedQbStagedIds.push(...cascade.stagedPaymentIds);
    for (const affectedGiftId of cascade.affectedGiftIds) {
      affectedGiftIds.add(affectedGiftId);
    }

    const removal = await removeStripeChargeApplicationsAndRefresh(tx, chargeId);
    for (const affectedGiftId of removal.affectedGiftIds) {
      affectedGiftIds.add(affectedGiftId);
    }

    if (relationship.createdTheGift) {
      const [{ remaining }] = await tx
        .select({ remaining: sql<number>`count(*)::int` })
        .from(paymentApplications)
        .where(eq(paymentApplications.giftId, giftId));

      if ((remaining ?? 0) === 0) {
        await tx
          .delete(giftAllocations)
          .where(eq(giftAllocations.giftId, giftId));
        await tx.delete(giftsAndPayments).where(eq(giftsAndPayments.id, giftId));
        deletedGiftId = giftId;
      } else {
        // A merged or subsequently co-funded gift outlives the charge that first
        // created it. Remove only this source and restore any amount stamp it owns.
        const unstamped = await unstampGiftFinalAmount(tx, giftId, {
          source: "stripe",
          stripeChargeId: chargeId,
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
        survivingGiftId = giftId;
      }
    } else {
      const unstamped = await unstampGiftFinalAmount(tx, giftId, {
        source: "stripe",
        stripeChargeId: chargeId,
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
      survivingGiftId = giftId;
    }
  }

  const hasDonor =
    charge.organizationId != null ||
    charge.individualGiverPersonId != null ||
    charge.householdId != null;
  const rawStatus =
    charge.rawCharge && typeof charge.rawCharge === "object"
      ? ((charge.rawCharge as Record<string, unknown>)["status"] ?? null)
      : null;
  const exclusionReason =
    rawStatus === "failed"
      ? ("failed_charge" as const)
      : isFullyRefunded({
            refunded: charge.refunded === true,
            disputed: charge.disputed === true,
            amountRefunded: charge.amountRefunded,
            grossAmount: charge.grossAmount,
          })
        ? ("refunded_charge" as const)
        : null;

  await tx
    .update(stripeStagedCharges)
    .set({
      exclusionReason,
      matchedGiftId: null,
      createdGiftId: null,
      autoApplied: false,
      matchStatus: hasDonor ? "suggested" : "unmatched",
      matchConfirmedAt: null,
      matchConfirmedByUserId: null,
      approvedAt: null,
      approvedByUserId: null,
      ...(charge.refundPropagationStatus === "proposed"
        ? {
            refundPropagationStatus: "none" as const,
            refundPropagationKind: null,
            refundPropagationGiftId: null,
            refundProposedAmount: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(stripeStagedCharges.id, chargeId));

  return {
    chargeId,
    relationshipGiftId: giftId,
    survivingGiftId,
    deletedGiftId,
    cascadedQbStagedIds,
    affectedGiftIds: [...affectedGiftIds],
  };
}
