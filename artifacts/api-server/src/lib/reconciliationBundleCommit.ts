import { type Request } from "express";
import {
  giftsAndPayments,
  stripeStagedCharges,
  stagedPayments,
  organizations,
  people,
  households,
  emails,
  settlementLinks,
} from "@workspace/db/schema";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { newId } from "./helpers";
import { buildGiftValuesFromStripeCharge } from "./stripeGift";
import { recordAudit } from "./audit";
import { APPROVABLE_STAGED_STATUSES } from "./reconciliationGate";
import {
  stampGiftFinalAmount,
  adjustSingleAllocationOrFlag,
} from "./giftFinalAmount";
import { ReconcileAbort, type Tx, type DonorXor } from "./reconciliationCommit";
import { bookStripeChargeApplication } from "./paymentApplications";
import {
  seedInitialGiftAllocation,
  assertGiftHasAllocations,
} from "./giftAllocationSeed";
import type {
  BundleNewDonorDraft,
  StagedPaymentExclusionReason,
} from "./reconciliationBundleProposal";

/**
 * Net-new in-transaction money-write primitives the settlement-bundle confirm
 * needs that the QB-anchored manual reconciler (`reconciliationCommit.ts`) does
 * not already provide:
 *
 *   - per-Stripe-charge mint / link (the existing `mintGiftInTx` / `linkGiftInTx`
 *     book a QuickBooks staged payment; these book a Stripe charge directly,
 *     crediting the donor the GROSS charge with the fee recorded separately).
 *   - new-donor materialization (propose-new-donor): insert the org / person /
 *     household + an optional email, returning the Donor XOR.
 *   - human-driven exclude of a charge / staged row.
 *
 * Every primitive runs on rows the CONFIRM caller has ALREADY locked FOR UPDATE
 * and re-read; they throw a res-free `ReconcileAbort` (the caller rolls the
 * whole bundle back) and return the ids the caller must re-derive after the
 * single commit. There is still exactly ONE money path — these mirror the
 * existing Stripe create-gift / link / exclude routes 1:1, just made tx-safe and
 * reusable. The payout↔deposit tie + payout reconciliation is owned by the tie
 * primitives (`stripeConfirm.ts`); the charge primitives never touch the payout
 * (matching the standalone per-charge create-gift route).
 */

/**
 * Mint a real gift from a single Stripe charge, crediting the donor the GROSS
 * amount (fee recorded separately) and marking the charge permanent reconciled
 * EVIDENCE (createdGiftId). Mirrors POST /stripe-staged-charges/:id/create-gift,
 * including the QuickBooks-conflict guard that refuses to double-book a payout
 * already booked as an approved QB lump.
 */
export async function createGiftFromChargeInTx(
  tx: Tx,
  args: {
    /** Pre-allocated id for the gift being minted. */
    newGiftId: string;
    /** The charge, ALREADY locked + re-read pending by the caller. */
    charge: typeof stripeStagedCharges.$inferSelect;
    /** Resolved gift donor (Donor XOR; existing or freshly created). */
    donor: DonorXor;
    /** Optional payment-intermediary override (conduit the donor gave through). */
    paymentIntermediaryId: string | null;
    /** App user id stamped as the confirmer / mint owner. */
    userId: string;
    /** Request used for audit attribution. */
    auditReq: Request;
  },
): Promise<{ giftId: string }> {
  const { newGiftId, charge, donor, paymentIntermediaryId, userId, auditReq } =
    args;

  // QuickBooks reconciliation guard: refuse to mint a per-charge gift when this
  // charge's payout is already booked as an APPROVED QB net lump (an unresolved
  // conflict, or a confirmed "keep" that left that QB gift in place). Minting
  // here would double-count the same money. Mirrors the standalone create-gift
  // route. The payout row is already locked by the caller.
  if (charge.stripePayoutId) {
    // Read-flip: the settlement link is authoritative. A link carrying a conflict
    // gift means this payout's money is already booked as a QB-derived gift —
    // whether an unresolved conflict (proposed link + conflict gift) or a confirmed
    // "keep" that left that gift in place (confirmed link + conflict gift). A link
    // with no conflict gift reconciled a bare deposit into no gift, so per-charge
    // gifts are still correct — allow it. The payout row is already locked by the
    // caller, so all settlement-link writers are serialized behind it.
    const link = await tx
      .select({ conflictGiftId: settlementLinks.conflictGiftId })
      .from(settlementLinks)
      .where(eq(settlementLinks.payoutId, charge.stripePayoutId))
      .then((r) => r[0]);
    if (link?.conflictGiftId) {
      throw new ReconcileAbort(409, {
        error: "qb_conflict",
        message:
          "This payout is already booked as an approved QuickBooks lump. Resolve the QuickBooks side before creating per-charge gifts.",
      });
    }
  }

  await tx.insert(giftsAndPayments).values(
    buildGiftValuesFromStripeCharge(
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
  );

  // Every gift needs at least one allocation (the sole home of money scope).
  // Seed a default full-amount line; fundraiser refines scope later.
  await seedInitialGiftAllocation(tx, {
    giftId: newGiftId,
    amount: charge.grossAmount,
    dateReceived: charge.dateReceived,
  });
  await assertGiftHasAllocations(tx, newGiftId);

  // The charge OWNS the mint (createdGiftId, not auto-applied → protected from
  // casual revert). Adopt the chosen donor onto the evidence row. Guarded on
  // still-pending to catch a concurrent resolve.
  const updated = await tx
    .update(stripeStagedCharges)
    .set({
      ...donor,
      status: "reconciled",
      createdGiftId: newGiftId,
      matchedGiftId: null,
      autoApplied: false,
      matchStatus: "matched",
      matchConfirmedByUserId: userId,
      matchConfirmedAt: new Date(),
      approvedByUserId: userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stripeStagedCharges.id, charge.id),
        eq(stripeStagedCharges.status, "pending"),
      ),
    )
    .returning({ id: stripeStagedCharges.id });
  if (updated.length === 0) {
    throw new ReconcileAbort(409, {
      error: "not_pending",
      message:
        "This staged charge is no longer open for reconciliation. Refresh and try again.",
    });
  }

  // Dual-write (Phase 2): the charge MINTED this gift (createdTheGift:true).
  // Book the charge → gift ledger row; delete-by-anchor keeps it idempotent.
  await bookStripeChargeApplication(tx, {
    stripeChargeId: charge.id,
    grossAmount: charge.grossAmount,
    giftId: newGiftId,
    matchMethod: "human",
    confirmedByUserId: userId,
    confirmedAt: new Date(),
    createdTheGift: true,
  });

  await recordAudit(tx, auditReq, {
    action: "create",
    entityType: "gift",
    entityId: newGiftId,
    summary: "Minted gift from Stripe charge (settlement bundle)",
    metadata: {
      stripeChargeId: charge.id,
      outcome: "bundle_create_gift",
    },
  });

  return { giftId: newGiftId };
}

/**
 * Tie a single Stripe charge to an EXISTING gift as permanent reconciled
 * evidence, stamping the gift's final amount to the charge GROSS (and
 * rebalancing its single allocation, or flagging a multi-allocation gift whose
 * splits no longer sum). Mirrors `linkGiftInTx`'s charge branch MINUS the QB
 * cash-application ledger and the payout update (the tie owns the payout).
 */
export async function linkChargeToGiftInTx(
  tx: Tx,
  args: {
    /** The charge, ALREADY locked + re-read pending by the caller. */
    charge: typeof stripeStagedCharges.$inferSelect;
    /** The existing gift, ALREADY locked by the caller. */
    gift: typeof giftsAndPayments.$inferSelect;
    /** Existing gift id. */
    giftId: string;
    /** Donor to record on the evidence (the gift's donor, or a confirmed switch). */
    effectiveGiftDonor: DonorXor;
    /** Whether the reviewer confirmed a gift-donor switch (re-points the gift). */
    donorSwitching: boolean;
    /** App user id stamped as the confirmer. */
    userId: string;
    /** Request used for audit attribution. */
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

  // Reject if ANOTHER Stripe charge already owns this gift as evidence. The
  // partial-unique on matched_gift_id covers a second MATCH (23505), but not the
  // case where another charge already CREATED (auto-minted) the gift — this
  // closes that gap with a clean 409 instead of a silent double-tie.
  const ownedByOtherCharge = await tx
    .select({ id: stripeStagedCharges.id })
    .from(stripeStagedCharges)
    .where(
      and(
        ne(stripeStagedCharges.id, charge.id),
        or(
          eq(stripeStagedCharges.matchedGiftId, giftId),
          eq(stripeStagedCharges.createdGiftId, giftId),
        ),
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

  // Tie the charge to the gift. Guarded on still-pending; the partial-unique on
  // matched_gift_id also makes a gift claimable by at most ONE charge (23505 →
  // surfaced as a link conflict by the caller).
  const updated = await tx
    .update(stripeStagedCharges)
    .set({
      ...effectiveGiftDonor,
      status: "reconciled",
      matchedGiftId: giftId,
      createdGiftId: null,
      autoApplied: false,
      matchStatus: "matched",
      matchConfirmedByUserId: userId,
      matchConfirmedAt: new Date(),
      approvedByUserId: userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stripeStagedCharges.id, charge.id),
        eq(stripeStagedCharges.status, "pending"),
      ),
    )
    .returning({ id: stripeStagedCharges.id });
  if (updated.length === 0) {
    throw new ReconcileAbort(409, {
      error: "link_conflict",
      message:
        "This staged charge is no longer open, or that gift was just linked to another charge. Refresh and try again.",
    });
  }

  // Re-point the gift's donor when the reviewer confirmed a switch (Donor XOR
  // was validated by the caller before this).
  if (donorSwitching) {
    await tx
      .update(giftsAndPayments)
      .set({
        organizationId: effectiveGiftDonor.organizationId,
        individualGiverPersonId: effectiveGiftDonor.individualGiverPersonId,
        householdId: effectiveGiftDonor.householdId,
        updatedAt: new Date(),
      })
      .where(eq(giftsAndPayments.id, giftId));
  }

  // Stamp the gift's FINAL amount to the Stripe GROSS + rebalance its single
  // allocation (or flag a multi-allocation gift whose splits no longer sum).
  const stamp = await stampGiftFinalAmount(tx, giftId, {
    source: "stripe",
    stripeChargeId: charge.id,
    amount: charge.grossAmount,
    processorFee: charge.feeAmount,
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
  // A changed gift amount shifts the paid total of the pledge it's on (if any).
  if (stamp.changed && gift.opportunityId) {
    rederivePledgeIds.push(gift.opportunityId);
  }

  // Dual-write (Phase 2): book the charge → existing-gift ledger row (GROSS
  // source, createdTheGift:false). Delete-by-anchor keeps re-links idempotent.
  await bookStripeChargeApplication(tx, {
    stripeChargeId: charge.id,
    grossAmount: charge.grossAmount,
    giftId,
    matchMethod: "human",
    confirmedByUserId: userId,
    confirmedAt: new Date(),
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

/**
 * Materialize a proposed NEW donor (propose-new-donor) and return its Donor XOR.
 * Inserts the organization / person / household; for org + person also attaches
 * the payer email (skipped for households, which are name-only). The email is
 * inserted with onConflictDoNothing so the global lower(email) uniqueness never
 * aborts the bundle — a colliding address means the contact already exists and
 * the donor record still stands on its name.
 */
export async function createDonorRecordInTx(
  tx: Tx,
  args: { draft: BundleNewDonorDraft; userId: string },
): Promise<DonorXor> {
  const { draft, userId } = args;
  const email = draft.email?.trim() ? draft.email.trim() : null;

  if (draft.kind === "organization") {
    const orgId = newId();
    await tx.insert(organizations).values({
      id: orgId,
      name: draft.name,
      ownerUserId: userId,
    });
    if (email) {
      await tx
        .insert(emails)
        .values({ id: newId(), email, organizationId: orgId })
        .onConflictDoNothing();
    }
    return {
      organizationId: orgId,
      individualGiverPersonId: null,
      householdId: null,
    };
  }

  if (draft.kind === "household") {
    const hhId = newId();
    await tx.insert(households).values({ id: hhId, name: draft.name });
    return {
      organizationId: null,
      individualGiverPersonId: null,
      householdId: hhId,
    };
  }

  // individual (person)
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

/**
 * Human-driven exclude of a Stripe charge in a bundle confirm: file it under a
 * non-gift category, pinning classificationSource='manual'. Guarded on
 * still-pending (a committed/reconciled charge is skipped upstream).
 */
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
      status: "excluded",
      exclusionReason: args.exclusionReason,
      classificationSource: "manual",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stripeStagedCharges.id, args.chargeId),
        eq(stripeStagedCharges.status, "pending"),
      ),
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

/**
 * Human-driven exclude of a QuickBooks staged payment in a bundle confirm.
 * Guarded on still-approvable.
 */
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
      status: "excluded",
      exclusionReason: args.exclusionReason,
      classificationSource: "manual",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stagedPayments.id, args.stagedPaymentId),
        inArray(stagedPayments.status, [...APPROVABLE_STAGED_STATUSES]),
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
