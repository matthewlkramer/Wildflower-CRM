import { type Request } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  giftsAndPayments,
  giftAllocations,
  pledgeAllocations,
  opportunitiesAndPledges,
  stripeStagedCharges,
  stripePayouts,
  settlementLinks,
} from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { newId } from "./helpers";
import { buildGiftValuesFromStaged } from "./quickbooksGift";
import {
  applyPaymentApplication,
  bookStripeChargeApplication,
  qbLedgerExistsForGiftExcludingPayment,
  removePaymentApplicationsForStripeCharge,
} from "./paymentApplications";
import { recordAudit } from "./audit";
import { APPROVABLE_STAGED_STATUSES } from "./reconciliationGate";
import {
  stampGiftFinalAmount,
  adjustSingleAllocationOrFlag,
  unstampGiftFinalAmount,
} from "./giftFinalAmount";
import { donorOf, type LinkDonor } from "./quickbooksLink";
import { upsertSettlementLink } from "./settlementLink";
import { confirmSettlementLink } from "./settlementWriter";
import {
  seedInitialGiftAllocation,
  assertGiftHasAllocations,
} from "./giftAllocationSeed";

/**
 * The committed money-write primitives shared by the manual reconciliation
 * approve/link route (`routes/reconciliation/approve.ts`) AND the atomic
 * settlement-bundle confirm. There is exactly ONE money path: both callers run
 * the SAME in-transaction writes here. The division of labor is:
 *
 *   caller (approve route OR bundle confirm)   →   lock rows + authoritative
 *     validation (Donor XOR, approvability, consistency gate) + post-commit
 *     derived-field appliers (applyDerivedOppFieldsMany / applyGiftQbTieMany).
 *   primitives here                            →   the row mutations, on rows
 *     the caller has ALREADY locked + re-read + gated. They throw a res-free
 *     `ReconcileAbort` (the caller maps it to a response or rolls back the
 *     whole bundle) and RETURN the ids the caller must re-derive/re-tie after
 *     the single commit.
 */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DonorXor = {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
};

/**
 * Aborts the surrounding transaction with a chosen HTTP status + JSON body.
 * Thrown from inside the tx so the row mutations roll back; the caller catches
 * it and turns it into the response (the manual route) or re-throws to roll the
 * whole bundle back (the bundle confirm). Lets the consistency gate + in-tx
 * race re-checks run on FRESHLY-LOCKED rows yet still surface a clean status.
 */
export class ReconcileAbort extends Error {
  constructor(
    readonly httpStatus: number,
    readonly payload: Record<string, unknown>,
  ) {
    super("reconcile_abort");
  }
}

/**
 * Forward gift intake: seed the newly-minted gift's allocations from the
 * opportunity/pledge's allocation lines, scaled to this payment, so a payment
 * booked against a pledge inherits its scope (entity / fiscal year / region /
 * intended usage / restriction axes / school recipient) instead of landing as
 * an unscoped header-only gift. The fundraiser can still edit the result.
 *
 * PROPORTIONAL by design: each line's sub_amount is scaled by
 * giftAmount / pledgeTotal; to avoid rounding drift the LAST line absorbs the
 * remainder so the copy sums EXACTLY to the gift amount (header == sum invariant).
 * When the pledge has no allocations (or no positive total, or the gift amount
 * is unknown) we copy nothing / 1:1 — never inventing scope. Only columns
 * shared by both tables are copied; pledge-only fields and the @deprecated coding
 * snapshot are dropped. display_usage is left for its DB trigger to compute.
 */
export async function copyPledgeAllocationsToGift(
  tx: Tx,
  opportunityId: string,
  giftId: string,
  giftAmount: string | null,
): Promise<void> {
  const allocs = await tx
    .select()
    .from(pledgeAllocations)
    .where(eq(pledgeAllocations.pledgeOrOpportunityId, opportunityId))
    .orderBy(pledgeAllocations.id);
  if (allocs.length === 0) return;

  const pledgeTotal = allocs.reduce((acc, a) => acc + Number(a.subAmount ?? 0), 0);
  const giftNum = Number(giftAmount ?? 0);
  // Scale to the payment only when both the pledge total and the gift amount are
  // positive and they actually differ; otherwise copy the line amounts 1:1.
  const scale =
    pledgeTotal > 0 && Number.isFinite(giftNum) && giftNum > 0
      ? giftNum / pledgeTotal
      : 1;
  const willScale = scale !== 1 && Number.isFinite(giftNum) && giftNum > 0;

  let running = 0;
  const rows = allocs.map((a, i) => {
    let subAmount: string | null = a.subAmount;
    if (willScale) {
      if (i === allocs.length - 1) {
        // Last line absorbs the remainder so the copy sums to the gift exactly.
        subAmount = (giftNum - running).toFixed(2);
      } else {
        const scaled = Number((Number(a.subAmount ?? 0) * scale).toFixed(2));
        running += scaled;
        subAmount = scaled.toFixed(2);
      }
    }
    return {
      id: newId(),
      giftId,
      subAmount,
      grantYear: a.grantYear,
      entityId: a.entityId,
      intendedUsage: a.intendedUsage,
      fundableProjectId: a.fundableProjectId,
      schoolRecipientId: a.schoolRecipientId,
      regionalRestrictionType: a.regionalRestrictionType,
      usageRestrictionType: a.usageRestrictionType,
      timeRestrictionType: a.timeRestrictionType,
      reimbursementType: a.reimbursementType,
      regionIds: a.regionIds,
      purposeVerbatim: a.purposeVerbatim,
    } satisfies typeof giftAllocations.$inferInsert;
  });
  await tx.insert(giftAllocations).values(rows);
}

export interface MintGiftInTxArgs {
  /** Pre-allocated id for the gift being minted. */
  newGiftId: string;
  /** The representative staged row, ALREADY locked + re-checked approvable. */
  staged: typeof stagedPayments.$inferSelect;
  /** Representative staged-payment id (== staged.id; the row that OWNS the mint). */
  stagedPaymentId: string;
  /** Resolved gift donor (Donor XOR; from the locked opp, or the validated body). */
  donor: DonorXor;
  /** Locked Stripe charge supplying the precise GROSS, or null (QB-only). */
  charge: typeof stripeStagedCharges.$inferSelect | null;
  /** Locked opportunity (opp outcomes) whose allocations seed the gift, or null. */
  opp: typeof opportunitiesAndPledges.$inferSelect | null;
  /** Opportunity id to attach the payment to + re-derive after commit, or null. */
  opportunityId: string | null;
  /** The FINAL amount stamped on the gift (Stripe GROSS, group total, or QB amount). */
  evidenceAmount: string | null;
  /** Optional payment-intermediary override from the request body. */
  paymentIntermediaryId: string | null;
  /** Latch the opportunity into a pledge (open-only → written_commitment). */
  convert: boolean;
  /** The create-* outcome, echoed into the audit metadata. */
  outcome: string;
  /** Source-group context (all members locked + approvable) or null (single row). */
  group: {
    memberIds: string[];
    /** Per-member rows used to seed one allocation per subcomponent. */
    members?: { id: string; amount: string | null; entityId: string | null }[];
    /**
     * When true (plain create_gift only), seed one gift allocation per grouped
     * staged payment (sub_amount = that member's amount) instead of a header-only
     * lump. Ignored when an opportunity seeds the allocations.
     */
    splitIntoAllocations?: boolean;
  } | null;
  /** App user id stamped as the confirmer / mint owner. */
  userId: string;
  /** Request used for audit attribution. */
  auditReq: Request;
}

/**
 * Mint a NEW gift HEADER from QB (and optionally Stripe) evidence. Minting is
 * HUMAN-ONLY; the QB staged row OWNS the mint (createdGiftId, not auto-applied →
 * protected from casual revert). A selected Stripe charge supplies the precise
 * GROSS and stays matchedGiftId-linked (revert un-sources the amount, never
 * deletes the human mint). Not idempotent — the caller guards against minting a
 * second gift for a row that already has one.
 *
 * Caller contract: `staged` (+ all group members), `charge`, and `opp` are
 * already locked FOR UPDATE, re-checked approvable, and passed the consistency
 * gate. This performs ONLY the writes + audit; the caller runs the post-commit
 * appliers using the returned ids.
 */
export async function mintGiftInTx(
  tx: Tx,
  args: MintGiftInTxArgs,
): Promise<{ giftId: string; opportunityIdToRederive: string | null }> {
  const {
    newGiftId,
    staged,
    stagedPaymentId,
    donor,
    charge,
    opp,
    opportunityId,
    evidenceAmount,
    paymentIntermediaryId,
    convert,
    outcome,
    group,
    userId,
    auditReq,
  } = args;

  // convert: latch the opportunity into a pledge by setting the writtenPledge
  // outcome flag (the user-driven lifecycle input). Cultivation stage is a pure
  // funnel now and is NOT touched here; status + stage→complete are DERIVED
  // post-commit by applyDerivedOppFields — never written by hand (invariant #3).
  // Preserve a real (positive) awarded amount; only when it's missing fall back
  // to the evidence amount so a single-payment commitment derives to cash_in
  // instead of staying $0.
  if (convert && opp) {
    const existingAwarded = Number(opp.awardedAmount ?? 0);
    const evNum = Number(evidenceAmount ?? 0);
    const awardedAmount =
      !(existingAwarded > 0) && Number.isFinite(evNum) && evNum > 0
        ? evidenceAmount
        : opp.awardedAmount;
    await tx
      .update(opportunitiesAndPledges)
      .set({ writtenPledge: true, awardedAmount, updatedAt: new Date() })
      .where(eq(opportunitiesAndPledges.id, opp.id));
  }

  // Mint the gift HEADER. The amount is the FINAL amount, stamped at insert from
  // the chosen evidence (single XOR pointer); no prior human figure exists, so
  // original_human_crm_amount stays null. The opp outcomes tie the gift to the
  // opportunity via opportunityId so the pledge derives cash_in when fully paid.
  await tx.insert(giftsAndPayments).values({
    ...buildGiftValuesFromStaged(
      newGiftId,
      {
        qbEntityType: staged.qbEntityType,
        qbEntityId: staged.qbEntityId,
        amount: staged.amount,
        dateReceived: staged.dateReceived,
        payerName: staged.payerName,
        rawReference: staged.rawReference,
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
        matchedPaymentIntermediaryId:
          paymentIntermediaryId ?? staged.matchedPaymentIntermediaryId,
      },
      userId,
    ),
    amount: evidenceAmount,
    ...(opportunityId ? { opportunityId } : {}),
    ...(charge
      ? {
          processorFee: charge.feeAmount,
          finalAmountSource: "stripe" as const,
          finalAmountStripeChargeId: charge.id,
          finalAmountQbStagedPaymentId: null,
        }
      : {
          finalAmountSource: "quickbooks" as const,
          finalAmountQbStagedPaymentId: stagedPaymentId,
          finalAmountStripeChargeId: null,
        }),
    originalHumanCrmAmount: null,
  });

  // Forward gift intake: seed the gift's allocations from the pledge it pays
  // against, scaled to this payment. Only on the opportunity outcomes (opp
  // loaded); plain create_gift has no opp and stays header-only.
  if (opp) {
    await copyPledgeAllocationsToGift(tx, opp.id, newGiftId, evidenceAmount);
  } else if (
    group?.splitIntoAllocations &&
    group.members &&
    group.members.length > 0
  ) {
    // Grouped create_gift, "split subcomponents into allocation rows": each
    // grouped staged payment becomes one allocation (sub_amount = that member's
    // amount, entity from its attributed entityId). The member amounts sum to
    // the gift total (evidenceAmount) by construction, so no scaling is needed;
    // scope beyond entity is left for the fundraiser to refine. The restriction
    // axes / counts-toward-goal columns fall back to their NOT-NULL defaults.
    await tx.insert(giftAllocations).values(
      group.members.map((m) => ({
        id: newId(),
        giftId: newGiftId,
        subAmount: m.amount,
        entityId: m.entityId,
      })),
    );
  } else {
    // Plain create_gift (no opp) or a grouped mint without allocation split:
    // still seed ONE default full-amount allocation carrying the staged row's
    // attributed entity, so the gift never lands scope-less. The fiscal year is
    // derived from the payment date; other scope is left for the fundraiser.
    await seedInitialGiftAllocation(tx, {
      giftId: newGiftId,
      amount: evidenceAmount,
      dateReceived: staged.dateReceived,
      entityId: staged.entityId ?? null,
    });
  }
  // Safety net: the opp branch copies the pledge's allocations, but a pledge
  // with zero allocations would leave this gift scope-less and trip the
  // invariant below. Seed a default full-amount line when no branch produced one.
  const [{ n: seededAllocations }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(giftAllocations)
    .where(eq(giftAllocations.giftId, newGiftId));
  if (!seededAllocations) {
    await seedInitialGiftAllocation(tx, {
      giftId: newGiftId,
      amount: evidenceAmount,
      dateReceived: staged.dateReceived,
      entityId: staged.entityId ?? null,
    });
  }
  await assertGiftHasAllocations(tx, newGiftId);

  // The QB anchor OWNS the mint (createdGiftId, not auto-applied → protected from
  // casual revert). Adopt the chosen donor onto the evidence row. Guarded on
  // still-approvable to catch a concurrent resolve.
  const updated = await tx
    .update(stagedPayments)
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
        eq(stagedPayments.id, stagedPaymentId),
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

  // Source group: the representative carries createdGiftId (owns the mint); every
  // OTHER member ties to the same gift via groupReconciledGiftId so the whole
  // physical gift resolves as one unit and no slice can be re-reconciled into a
  // second gift. Members were locked + re-checked approvable by the caller.
  if (group) {
    const otherIds = group.memberIds.filter((id) => id !== stagedPaymentId);
    if (otherIds.length > 0) {
      const otherUpdated = await tx
        .update(stagedPayments)
        .set({
          ...donor,
          status: "reconciled",
          groupReconciledGiftId: newGiftId,
          createdGiftId: null,
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
            inArray(stagedPayments.id, otherIds),
            inArray(stagedPayments.status, [...APPROVABLE_STAGED_STATUSES]),
          ),
        )
        .returning({ id: stagedPayments.id });
      // A source group reconciles atomically: every member must tie to the minted
      // gift. They were locked + re-checked above, so a short count means one
      // slipped state under us — abort the whole mint rather than leave a group
      // half-reconciled.
      if (otherUpdated.length !== otherIds.length) {
        throw new ReconcileAbort(409, {
          error: "group_member_not_approvable",
          message: "One of the grouped payments changed state. Refresh and try again.",
        });
      }
    }
  }

  // A selected Stripe charge is the precise GROSS source: tie it to the gift via
  // matchedGiftId (mirrors the link path + the Stripe confirm paths) so it stays
  // resolvable + revertible — revert un-sources the amount, never deletes the
  // human mint the QB anchor owns. Mark its payout reconciled.
  if (charge) {
    await tx
      .update(stripeStagedCharges)
      .set({
        ...donor,
        status: "reconciled",
        matchedGiftId: newGiftId,
        createdGiftId: null,
        autoApplied: false,
        matchStatus: "matched",
        matchConfirmedByUserId: userId,
        matchConfirmedAt: new Date(),
        approvedByUserId: userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(stripeStagedCharges.id, charge.id));
    if (charge.stripePayoutId) {
      // Phase-4 authoritative write: express the confirm as a settlement link.
      // This has no prior-status pin, so we READ + carry the conflict gift through
      // under the payout row lock (all settlement-link writers take that same lock,
      // so the value can't change before our confirm write below): clearing a set
      // conflict gift would re-open per-charge minting against a kept QB gift =
      // double-book, and misroute revert. The conflict gift is read off the
      // AUTHORITATIVE settlement link, never a legacy payout column. Conflict is
      // guarded upstream so it is null in practice, but we never clear it blindly.
      const now = new Date();
      await tx
        .select({ id: stripePayouts.id })
        .from(stripePayouts)
        .where(eq(stripePayouts.id, charge.stripePayoutId))
        .for("update");
      const [po] = await tx
        .select({ conflictGiftId: settlementLinks.conflictGiftId })
        .from(settlementLinks)
        .where(eq(settlementLinks.payoutId, charge.stripePayoutId));
      const link = confirmSettlementLink({
        depositStagedPaymentId: stagedPaymentId,
        conflictGiftId: po?.conflictGiftId ?? null,
        confirmedByUserId: userId,
        confirmedAt: now,
      });
      // Plane-1 authoritative write: upsert the settlement link.
      await upsertSettlementLink(tx, charge.stripePayoutId, link);
    }
    // Dual-write (Phase 2): book the Stripe charge as parallel evidence. The QB
    // anchor OWNS the mint (createdTheGift:true on its row); this Stripe row is
    // the GROSS source, so createdTheGift:false. Delete-by-anchor keeps it
    // idempotent + re-tie-safe.
    await bookStripeChargeApplication(tx, {
      stripeChargeId: charge.id,
      grossAmount: charge.grossAmount,
      giftId: newGiftId,
      matchMethod: "human",
      confirmedByUserId: userId,
      confirmedAt: new Date(),
      createdTheGift: false,
    });
  }

  // Dual-write (Phase 2): book the QB cash-application ledger. The anchor staged
  // payment CREATED this gift; each grouped member also applies its QB amount to
  // the same gift. amountApplied is the QB-settled figure (staged.amount) —
  // independent of a selected Stripe charge's GROSS, which sets the gift's amount
  // but is tracked as separate Stripe evidence.
  if (staged.amount && Number(staged.amount) > 0) {
    await applyPaymentApplication(tx, {
      paymentId: stagedPaymentId,
      giftId: newGiftId,
      amountApplied: staged.amount,
      evidenceSource: "quickbooks",
      matchMethod: "human",
      confirmedByUserId: userId,
      confirmedAt: new Date(),
      createdTheGift: true,
    });
  }
  if (group) {
    const memberIds = group.memberIds.filter((mid) => mid !== stagedPaymentId);
    if (memberIds.length > 0) {
      const members = await tx
        .select({ id: stagedPayments.id, amount: stagedPayments.amount })
        .from(stagedPayments)
        .where(inArray(stagedPayments.id, memberIds));
      for (const member of members) {
        if (!(member.amount && Number(member.amount) > 0)) continue;
        await applyPaymentApplication(tx, {
          paymentId: member.id,
          giftId: newGiftId,
          amountApplied: member.amount,
          evidenceSource: "quickbooks",
          matchMethod: "human",
          confirmedByUserId: userId,
          confirmedAt: new Date(),
          createdTheGift: false,
        });
      }
    }
  }

  await recordAudit(tx, auditReq, {
    action: "create",
    entityType: "gift",
    entityId: newGiftId,
    summary: "Created gift from reconciliation (complete match)",
    metadata: {
      stagedPaymentId,
      stripeChargeId: charge?.id ?? null,
      opportunityId: opp?.id ?? null,
      outcome,
      sourceGroupMemberIds: group ? group.memberIds : null,
    },
  });

  return { giftId: newGiftId, opportunityIdToRederive: opportunityId };
}

export interface LinkGiftInTxArgs {
  /** The staged row, ALREADY locked + re-checked approvable. */
  staged: typeof stagedPayments.$inferSelect;
  /** Staged-payment id being tied to the existing gift. */
  stagedPaymentId: string;
  /** The existing gift, ALREADY locked. */
  gift: typeof giftsAndPayments.$inferSelect;
  /** Existing gift id. */
  giftId: string;
  /** Locked opportunity to (optionally) attach the payment to, or null. */
  opp: typeof opportunitiesAndPledges.$inferSelect | null;
  /** Locked Stripe charge supplying the precise GROSS, or null. */
  charge: typeof stripeStagedCharges.$inferSelect | null;
  /** The FINAL amount (Stripe GROSS or QB amount) used for stamping. */
  evidenceAmount: string | null;
  /** Donor to record on the evidence (the gift's donor, or a confirmed switch). */
  effectiveGiftDonor: LinkDonor;
  /** Whether the reviewer confirmed a gift-donor switch (re-points the gift). */
  donorSwitching: boolean;
  /** Whether the reviewer confirmed re-sourcing the gift from `charge` even
   *  though it is currently sourced from `oldStripeCharge`. */
  switchStripeSource?: boolean;
  /** The Stripe charge that currently backs the gift's amount, ALREADY locked,
   *  when a source switch was confirmed — orphaned back to the queue before the
   *  new charge is stamped. Null unless switching. */
  oldStripeCharge?: typeof stripeStagedCharges.$inferSelect | null;
  /** App user id stamped as the confirmer. */
  userId: string;
  /** Request used for audit attribution. */
  auditReq: Request;
}

/**
 * Tie staged (and optional Stripe charge) EVIDENCE to an EXISTING gift (links,
 * never mints). The gift is authoritative; the staged evidence ADOPTS the gift's
 * (possibly just-switched) donor. The caller has already locked staged/gift/opp/
 * charge FOR UPDATE, validated the optional donor switch + Donor XOR, and passed
 * the consistency gate. Returns the pledge ids to re-derive after commit.
 */
export async function linkGiftInTx(
  tx: Tx,
  args: LinkGiftInTxArgs,
): Promise<{ giftId: string; rederivePledgeIds: string[] }> {
  const {
    staged,
    stagedPaymentId,
    gift,
    giftId,
    opp,
    charge,
    userId,
    auditReq,
    effectiveGiftDonor,
    donorSwitching,
    switchStripeSource = false,
    oldStripeCharge = null,
  } = args;

  const rederivePledgeIds: string[] = [];
  const finalDonor = effectiveGiftDonor;
  // Did we actually orphan an old backing charge? (drives the audit summary)
  const switchedStripeSource =
    switchStripeSource &&
    !!oldStripeCharge &&
    !!charge &&
    oldStripeCharge.id !== charge.id;

  // Tie the staged row to the gift. Only succeeds if still approvable AND no
  // other staged payment already QB-claims this gift in the ledger — the ledger
  // guard + the (still-dual-written) partial-unique index on matched_gift_id
  // backstop a write-skew between the lock and the commit.
  const updated = await tx
    .update(stagedPayments)
    .set({
      ...finalDonor,
      // Permanent EVIDENCE tied to the gift — `reconciled` (not `approved`) marks
      // that terminal tie; never archived, never a second gift.
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
        eq(stagedPayments.id, stagedPaymentId),
        inArray(stagedPayments.status, [...APPROVABLE_STAGED_STATUSES]),
        // Gift must not already be QB-linked to another staged payment. The
        // ledger unifies direct + split + group-reconciled links.
        sql`NOT ${qbLedgerExistsForGiftExcludingPayment(sql`${giftId}`, sql`${stagedPaymentId}`)}`,
      ),
    )
    .returning({ id: stagedPayments.id });
  if (updated.length === 0) {
    throw new ReconcileAbort(409, {
      error: "link_conflict",
      message:
        "This staged payment is no longer open for reconciliation, or that gift was just linked to another payment. Refresh and try again.",
    });
  }

  // Re-point the gift's donor when the reviewer confirmed a switch (the
  // pledge-conflict + Donor XOR checks ran in the caller before this).
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

  // Source switch (Task #546): the reviewer confirmed re-sourcing this gift from
  // the newly selected charge even though a DIFFERENT charge currently backs it.
  // Orphan the old charge FIRST — the partial-unique on matched_gift_id forbids
  // two charges pointing at one gift, and the unstamp is pointer-safe (it only
  // fires while the gift still points at the OLD charge), so the old pointer must
  // be cleared before the new charge is stamped below. Mirrors the single-charge
  // revert (stripe.ts): drop the old charge's ledger row, unstamp the gift (a
  // no-op for the amount when it was Stripe-sourced — Stripe amount is derived),
  // then return the charge to the unmatched-money queue. We never delete the
  // gift here even if the old charge minted it: the gift is the switch target.
  if (switchedStripeSource && oldStripeCharge) {
    await removePaymentApplicationsForStripeCharge(tx, oldStripeCharge.id);
    const unstamped = await unstampGiftFinalAmount(tx, giftId, {
      source: "stripe",
      stripeChargeId: oldStripeCharge.id,
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
    const oldHasDonor =
      !!oldStripeCharge.organizationId ||
      !!oldStripeCharge.individualGiverPersonId ||
      !!oldStripeCharge.householdId;
    await tx
      .update(stripeStagedCharges)
      .set({
        status: "pending",
        matchedGiftId: null,
        createdGiftId: null,
        autoApplied: false,
        matchStatus: oldHasDonor ? "suggested" : "unmatched",
        matchConfirmedAt: null,
        matchConfirmedByUserId: null,
        approvedAt: null,
        approvedByUserId: null,
        ...(oldStripeCharge.refundPropagationStatus === "proposed"
          ? {
              refundPropagationStatus: "none" as const,
              refundPropagationKind: null,
              refundPropagationGiftId: null,
              refundProposedAmount: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(stripeStagedCharges.id, oldStripeCharge.id));
  }

  // Stamp the gift's FINAL amount + rebalance its single allocation (or flag a
  // multi-allocation gift whose splits no longer sum).
  const stamp = charge
    ? await stampGiftFinalAmount(tx, giftId, {
        source: "stripe",
        stripeChargeId: charge.id,
        amount: charge.grossAmount,
        processorFee: charge.feeAmount,
      })
    : await stampGiftFinalAmount(tx, giftId, {
        source: "quickbooks",
        qbStagedPaymentId: stagedPaymentId,
        amount: staged.amount,
      });
  if (!stamp.skipped) {
    await adjustSingleAllocationOrFlag(
      tx,
      giftId,
      stamp.oldAmount,
      stamp.newAmount,
      charge ? "stripe" : "quickbooks",
    );
  }

  // Dual-write (Phase 2): book the QB cash-application ledger row. The QB staged
  // payment settles this EXISTING gift (links, never mints). A selected Stripe
  // charge is separate evidence (it sets the gift's GROSS amount); the QB ledger
  // row still records the QB-settled amount.
  if (staged.amount && Number(staged.amount) > 0) {
    await applyPaymentApplication(tx, {
      paymentId: stagedPaymentId,
      giftId,
      amountApplied: staged.amount,
      evidenceSource: "quickbooks",
      matchMethod: "human",
      confirmedByUserId: userId,
      confirmedAt: new Date(),
      createdTheGift: false,
    });
  }

  // Mark the Stripe charge + its payout as permanent reconciled evidence.
  if (charge) {
    // Tie the charge to the gift row-locally (mirrors the Stripe confirm paths):
    // `matchedGiftId` is what the charge list/detail resolves the gift through
    // (COALESCE(matchedGiftId, createdGiftId)) and what the revert flow unwinds.
    // The partial-unique on matched_gift_id also makes a gift claimable by at
    // most ONE charge (23505 → 409 link_conflict).
    await tx
      .update(stripeStagedCharges)
      .set({
        ...finalDonor,
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
      .where(eq(stripeStagedCharges.id, charge.id));
    if (charge.stripePayoutId) {
      // Phase-4 authoritative write: express the confirm as a settlement link.
      // This has no prior-status pin, so we READ + carry the conflict gift through
      // under the payout row lock (all settlement-link writers take that same lock,
      // so the value can't change before our confirm write below): clearing a set
      // conflict gift would re-open per-charge minting against a kept QB gift =
      // double-book, and misroute revert. The conflict gift is read off the
      // AUTHORITATIVE settlement link, never a legacy payout column. Conflict is
      // guarded upstream so it is null in practice, but we never clear it blindly.
      const now = new Date();
      await tx
        .select({ id: stripePayouts.id })
        .from(stripePayouts)
        .where(eq(stripePayouts.id, charge.stripePayoutId))
        .for("update");
      const [po] = await tx
        .select({ conflictGiftId: settlementLinks.conflictGiftId })
        .from(settlementLinks)
        .where(eq(settlementLinks.payoutId, charge.stripePayoutId));
      const link = confirmSettlementLink({
        depositStagedPaymentId: stagedPaymentId,
        conflictGiftId: po?.conflictGiftId ?? null,
        confirmedByUserId: userId,
        confirmedAt: now,
      });
      // Plane-1 authoritative write: upsert the settlement link.
      await upsertSettlementLink(tx, charge.stripePayoutId, link);
    }
    // Dual-write (Phase 2): book the Stripe charge as parallel evidence (GROSS
    // source). The QB row already recorded the QB-settled amount above; this is
    // a separate stripe-anchored row. Delete-by-anchor keeps it re-tie-safe.
    await bookStripeChargeApplication(tx, {
      stripeChargeId: charge.id,
      grossAmount: charge.grossAmount,
      giftId,
      matchMethod: "human",
      confirmedByUserId: userId,
      confirmedAt: new Date(),
      createdTheGift: false,
    });
  }

  // A changed gift amount shifts the paid total of the pledge it's already on
  // (if any) — re-derive that pledge after commit.
  if (stamp.changed && gift.opportunityId) {
    rederivePledgeIds.push(gift.opportunityId);
  }
  // Optionally tie the gift to the chosen opportunity (payment-on-pledge),
  // without clobbering an existing link; the newly linked pledge also needs
  // re-derivation (a payment was attached to it).
  if (opp && gift.opportunityId == null) {
    await tx
      .update(giftsAndPayments)
      .set({ opportunityId: opp.id, updatedAt: new Date() })
      .where(eq(giftsAndPayments.id, giftId));
    rederivePledgeIds.push(opp.id);
  }

  const summaryParts = ["Reconciled QuickBooks payment to gift"];
  if (donorSwitching) summaryParts.push("switched its donor");
  if (switchedStripeSource) summaryParts.push("switched its Stripe source");
  await recordAudit(tx, auditReq, {
    action: "update",
    entityType: "gift",
    entityId: giftId,
    summary: `${summaryParts.join(" and ")} (complete match)`,
    metadata: {
      stagedPaymentId,
      stripeChargeId: charge?.id ?? null,
      opportunityId: opp?.id ?? null,
      outcome: "link_existing_gift",
      ...(donorSwitching
        ? { switchedGiftDonor: true, fromDonor: donorOf(gift), toDonor: effectiveGiftDonor }
        : {}),
      ...(switchedStripeSource && oldStripeCharge
        ? {
            switchedStripeSource: true,
            fromStripeChargeId: oldStripeCharge.id,
            toStripeChargeId: charge?.id ?? null,
          }
        : {}),
    },
  });

  return { giftId, rederivePledgeIds };
}
