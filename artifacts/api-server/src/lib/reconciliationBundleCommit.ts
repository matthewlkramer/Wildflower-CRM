import { type Request } from "express";
import {
  emails,
  giftAllocations,
  giftsAndPayments,
  households,
  organizations,
  paymentApplications,
  people,
  settlementLinks,
  stagedPayments,
  stripeStagedCharges,
} from "@workspace/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { newId } from "./helpers";
import { buildGiftValuesFromStripeCharge } from "./stripeGift";
import { recordAudit } from "./audit";
import { APPROVABLE_STAGED_STATUSES } from "./reconciliationGate";
import { chargeStatusWhere, stagedStatusIn } from "./derivedStatus";
import {
  stampGiftFinalAmount,
  adjustSingleAllocationOrFlag,
} from "./giftFinalAmount";
import {
  ReconcileAbort,
  copyPledgeAllocationsToGift,
  type Tx,
  type DonorXor,
} from "./reconciliationCommit";
import { bookStripeChargeApplicationAndRefresh } from "./paymentApplicationMutations";
import {
  seedInitialGiftAllocation,
  assertGiftHasAllocations,
} from "./giftAllocationSeed";
import type {
  BundleNewDonorDraft,
  StagedPaymentExclusionReason,
} from "./reconciliationBundleProposal";

/**
 * Mint a gift from one locked pending Stripe charge. The relationship is written
 * only to payment_applications; the deprecated charge gift pointers remain null.
 */
export async function createGiftFromChargeInTx(
  tx: Tx,
  args: {
    newGiftId: string;
    charge: typeof stripeStagedCharges.$inferSelect;
    donor: DonorXor;
    paymentIntermediaryId: string | null;
    opportunityId?: string | null;
    audit?: { summary: string; metadata?: Record<string, unknown> };
    userId: string;
    auditReq: Request;
  },
): Promise<{ giftId: string }> {
  const { newGiftId, charge, donor, paymentIntermediaryId, userId, auditReq } =
    args;
  const opportunityId = args.opportunityId ?? null;

  if (charge.stripePayoutId) {
    const link = await tx
      .select({ conflictGiftId: settlementLinks.conflictGiftId })
      .from(settlementLinks)
      .where(eq(settlementLinks.payoutId, charge.stripePayoutId))
      .then((rows) => rows[0]);
    if (link?.conflictGiftId) {
      throw new ReconcileAbort(409, {
        error: "qb_conflict",
        message:
          "This payout is already booked as an approved QuickBooks lump. Resolve the QuickBooks side before creating per-charge gifts.",
      });
    }
  }

  await tx.insert(giftsAndPayments).values({
    ...buildGiftValuesFromStripeCharge(
      newGiftId,
      {
        chargeId: charge.id,
        grossAmount: charge.grossAmount,
        feeAmount: charge.feeAmount,
        dateReceived: charge.dateReceived,
        payerName: charge.payerName,
        description: charge.description,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        matchedPaymentIntermediaryId:
          paymentIntermediaryId ?? charge.matchedPaymentIntermediaryId,
      },
      userId,
    ),
    ...(opportunityId ? { opportunityId } : {}),
  });

  if (opportunityId) {
    await copyPledgeAllocationsToGift(
      tx,
      opportunityId,
      newGiftId,
      charge.grossAmount,
    );
  }
  const [{ n: seededAllocations }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(giftAllocations)
    .where(eq(giftAllocations.giftId, newGiftId));
  if (!seededAllocations) {
    await seedInitialGiftAllocation(tx, {
      giftId: newGiftId,
      amount: charge.grossAmount,
      dateReceived: charge.dateReceived,
    });
  }
  await assertGiftHasAllocations(tx, newGiftId);

  const now = new Date();
  const updated = await tx
    .update(stripeStagedCharges)
    .set({
      ...donor,
      autoApplied: false,
      matchStatus: "matched",
      matchConfirmedByUserId: userId,
      matchConfirmedAt: now,
      approvedByUserId: userId,
      approvedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(stripeStagedCharges.id, charge.id), chargeStatusWhere.pending),
    )
    .returning({ id: stripeStagedCharges.id });
  if (updated.length === 0) {
    throw new ReconcileAbort(409, {
      error: "not_pending",
      message:
        "This staged charge is no longer open for reconciliation. Refresh and try again.",
    });
  }

  await bookStripeChargeApplicationAndRefresh(tx, {
    stripeChargeId: charge.id,
    grossAmount: charge.grossAmount,
    giftId: newGiftId,
    matchMethod: "human",
    confirmedByUserId: userId,
    confirmedAt: now,
    createdTheGift: true,
  });

  await recordAudit(tx, auditReq, {
    action: "create",
    entityType: "gift",
    entityId: newGiftId,
    summary:
      args.audit?.summary ?? "Minted gift from Stripe charge (settlement bundle)",
    metadata: args.audit?.metadata ?? {
      stripeChargeId: charge.id,
      outcome: "bundle_create_gift",
    },
  });

  return { giftId: newGiftId };
}

/**
 * Tie one locked pending Stripe charge to an existing locked gift. The ledger is
 * the sole durable relationship; charge pointer columns are not touched.
 */
export async function linkChargeToGiftInTx(
  tx: Tx,
  args: {
    charge: typeof stripeStagedCharges.$inferSelect;
    gift: typeof giftsAndPayments.$inferSelect;
    giftId: string;
    effectiveGiftDonor: DonorXor;
    donorSwitching: boolean;
    userId: string;
    auditReq: Request;
  },
): Promise<{ giftId: string; rederivePledgeIds: string[] }> {
  const {
    charge,
    gift,
    giftId,
    effectiveGiftDonor,
    donorSwitching,
    userId,
    auditReq,
  } = args;
  const rederivePledgeIds: string[] = [];

  const ownedByOtherCharge = await tx
    .select({ stripeChargeId: paymentApplications.stripeChargeId })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.giftId, giftId),
        eq(paymentApplications.evidenceSource, "stripe"),
        eq(paymentApplications.linkRole, "counted"),
        sql`${paymentApplications.lifecycle} IN ('proposed', 'confirmed')`,
        ne(paymentApplications.stripeChargeId, charge.id),
      ),
    )
    .limit(1);
  if (ownedByOtherCharge.length > 0) {
    throw new ReconcileAbort(409, {
      error: "link_conflict",
      message:
        "That gift is already tied to another Stripe charge. Refresh and try again.",
    });
  }

  const now = new Date();
  const updated = await tx
    .update(stripeStagedCharges)
    .set({
      ...effectiveGiftDonor,
      autoApplied: false,
      matchStatus: "matched",
      matchConfirmedByUserId: userId,
      matchConfirmedAt: now,
      approvedByUserId: userId,
      approvedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(stripeStagedCharges.id, charge.id), chargeStatusWhere.pending),
    )
    .returning({ id: stripeStagedCharges.id });
  if (updated.length === 0) {
    throw new ReconcileAbort(409, {
      error: "link_conflict",
      message:
        "This staged charge is no longer open, or that gift is already tied to another Stripe charge. Refresh and try again.",
    });
  }

  if (donorSwitching) {
    await tx
      .update(giftsAndPayments)
      .set({
        organizationId: effectiveGiftDonor.organizationId,
        individualGiverPersonId: effectiveGiftDonor.individualGiverPersonId,
        householdId: effectiveGiftDonor.householdId,
        updatedAt: now,
      })
      .where(eq(giftsAndPayments.id, giftId));
  }

  const stamp = await stampGiftFinalAmount(tx, giftId, {
    source: "stripe",
    stripeChargeId: charge.id,
    amount: charge.grossAmount,
  });
  if (!stamp.skipped) {
    await adjustSingleAllocationOrFlag(
      tx,
      giftId,
      stamp.oldAmount,
      stamp.newAmount,
      "stripe",
    );
  }
  if (stamp.changed && gift.opportunityId) {
    rederivePledgeIds.push(gift.opportunityId);
  }

  await bookStripeChargeApplicationAndRefresh(tx, {
    stripeChargeId: charge.id,
    grossAmount: charge.grossAmount,
    giftId,
    matchMethod: "human",
    confirmedByUserId: userId,
    confirmedAt: now,
    createdTheGift: false,
  });

  await recordAudit(tx, auditReq, {
    action: "update",
    entityType: "gift",
    entityId: giftId,
    summary: donorSwitching
      ? "Reconciled Stripe charge to gift and switched its donor (settlement bundle)"
      : "Reconciled Stripe charge to gift (settlement bundle)",
    metadata: {
      stripeChargeId: charge.id,
      outcome: "bundle_link_gift",
      ...(donorSwitching ? { switchedGiftDonor: true } : {}),
    },
  });

  return { giftId, rederivePledgeIds };
}

export async function createDonorRecordInTx(
  tx: Tx,
  args: { draft: BundleNewDonorDraft; userId: string },
): Promise<DonorXor> {
  const { draft, userId } = args;
  const email = draft.email?.trim() ? draft.email.trim() : null;

  if (draft.kind === "organization") {
    const organizationId = newId();
    await tx.insert(organizations).values({
      id: organizationId,
      name: draft.name,
      ownerUserId: userId,
    });
    if (email) {
      await tx
        .insert(emails)
        .values({ id: newId(), email, organizationId })
        .onConflictDoNothing();
    }
    return {
      organizationId,
      individualGiverPersonId: null,
      householdId: null,
    };
  }

  if (draft.kind === "household") {
    const householdId = newId();
    await tx.insert(households).values({ id: householdId, name: draft.name });
    return {
      organizationId: null,
      individualGiverPersonId: null,
      householdId,
    };
  }

  const personId = newId();
  await tx.insert(people).values({
    id: personId,
    firstName: draft.firstName ?? null,
    lastName: draft.lastName ?? null,
    fullName: draft.name,
    ownerUserId: userId,
  });
  if (email) {
    await tx
      .insert(emails)
      .values({ id: newId(), email, personId })
      .onConflictDoNothing();
  }
  return {
    organizationId: null,
    individualGiverPersonId: personId,
    householdId: null,
  };
}

export async function excludeChargeInTx(
  tx: Tx,
  args: {
    chargeId: string;
    exclusionReason: StagedPaymentExclusionReason;
    userId: string;
  },
): Promise<void> {
  const updated = await tx
    .update(stripeStagedCharges)
    .set({
      exclusionReason: args.exclusionReason,
      classificationSource: "manual",
      updatedAt: new Date(),
    })
    .where(
      and(eq(stripeStagedCharges.id, args.chargeId), chargeStatusWhere.pending),
    )
    .returning({ id: stripeStagedCharges.id });
  if (updated.length === 0) {
    throw new ReconcileAbort(409, {
      error: "not_pending",
      message:
        "This staged charge is no longer open for reconciliation. Refresh and try again.",
    });
  }
}

export async function excludeStagedInTx(
  tx: Tx,
  args: {
    stagedPaymentId: string;
    exclusionReason: StagedPaymentExclusionReason;
    userId: string;
  },
): Promise<void> {
  const updated = await tx
    .update(stagedPayments)
    .set({
      exclusionReason: args.exclusionReason,
      classificationSource: "manual",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stagedPayments.id, args.stagedPaymentId),
        stagedStatusIn(APPROVABLE_STAGED_STATUSES),
      ),
    )
    .returning({ id: stagedPayments.id });
  if (updated.length === 0) {
    throw new ReconcileAbort(409, {
      error: "not_approvable",
      message:
        "This staged payment is no longer open for reconciliation. Refresh and try again.",
    });
  }
}
