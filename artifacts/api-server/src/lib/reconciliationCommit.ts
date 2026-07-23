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
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { newId } from "./helpers";
import { buildGiftValuesFromStaged } from "./quickbooksGift";
import {
  applyPaymentApplication,
  bookStripeChargeApplication,
  PaymentOverApplicationError,
  qbLedgerDirectMatchExists,
  qbLedgerExistsForGiftExcludingPayment,
  removePaymentApplicationsForPayment,
  removePaymentApplicationsForStripeCharge,
} from "./paymentApplications";
import { recordAudit } from "./audit";
import { APPROVABLE_STAGED_STATUSES } from "./reconciliationGate";
import { stagedStatusIn } from "./derivedStatus";
import { donorOf, type LinkDonor } from "./quickbooksLink";
import { isFullyRefunded } from "./stripeRefund";
import { upsertSettlementLink } from "./settlementLink";
import { confirmSettlementLink } from "./settlementWriter";
import { applySettlementSupersedeMany } from "./settlementSupersede";
import {
  seedInitialGiftAllocation,
  assertGiftHasAllocations,
  fiscalYearSlugForDate,
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
 * opportunity/pledge's allocation lines so a payment booked against a pledge
 * inherits its scope (entity / fiscal year / region / intended usage /
 * restriction axes / school recipient / restriction description) instead of
 * landing as an unscoped header-only gift. The fundraiser can still edit the
 * result — these are a starting point, never rewritten when the pledge plan
 * is later revised.
 *
 * REMAINING-PLAN seeding (Task #788), replacing the old proportional copy-all:
 *   1. Each pledge allocation's REMAINING amount is its sub_amount minus what
 *      earlier (non-archived) gift allocations already drew from it, tracked
 *      via source_pledge_allocation_id stamps.
 *   2. If the gift's fiscal year (from date_received) matches pledge
 *      allocations with remaining plan, seed from JUST that year's lines;
 *      otherwise fall back to every line with remaining plan; if the whole
 *      plan is consumed, fall back to all lines (old behavior) so the gift is
 *      never scope-less.
 *   3. The gift amount is spread PROPORTIONALLY across the chosen lines; the
 *      last line absorbs rounding remainder so the copy sums EXACTLY to the
 *      gift amount (header == sum invariant).
 * Every seeded row copies restriction_description (previously dropped) and is
 * stamped with source_pledge_allocation_id for plan-vs-actual reporting.
 * When the pledge has no allocations we copy nothing — never inventing scope.
 * display_usage is left for its DB trigger to compute.
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

  // Already-drawn amounts per pledge allocation, from prior stamped gift
  // allocations on live gifts (archived gifts are dead money).
  const drawnRows = await tx
    .select({
      sourceId: giftAllocations.sourcePledgeAllocationId,
      drawn: sql<string>`COALESCE(SUM(${giftAllocations.subAmount}), 0)::text`,
    })
    .from(giftAllocations)
    .innerJoin(giftsAndPayments, eq(giftsAndPayments.id, giftAllocations.giftId))
    .where(
      and(
        inArray(
          giftAllocations.sourcePledgeAllocationId,
          allocs.map((a) => a.id),
        ),
        sql`${giftsAndPayments.archivedAt} IS NULL`,
        sql`${giftAllocations.giftId} <> ${giftId}`,
      ),
    )
    .groupBy(giftAllocations.sourcePledgeAllocationId);
  const drawnById = new Map(drawnRows.map((r) => [r.sourceId, Number(r.drawn)]));

  const remainingOf = (a: (typeof allocs)[number]) =>
    Math.max(0, Number(a.subAmount ?? 0) - (drawnById.get(a.id) ?? 0));

  // Gift FY from its date_received (same Jul–Dec → next-FY rule as seeding).
  const [gift] = await tx
    .select({ dateReceived: giftsAndPayments.dateReceived })
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.id, giftId))
    .limit(1);
  const giftFy = fiscalYearSlugForDate(gift?.dateReceived);

  const withRemaining = allocs.filter((a) => remainingOf(a) > 0);
  const fyMatched = giftFy
    ? withRemaining.filter((a) => a.grantYear === giftFy)
    : [];
  const chosen =
    fyMatched.length > 0 ? fyMatched : withRemaining.length > 0 ? withRemaining : allocs;

  // Weight by remaining plan when any remains; otherwise by original amounts.
  const weightOf = withRemaining.length > 0 ? remainingOf : (a: (typeof allocs)[number]) => Number(a.subAmount ?? 0);
  const totalWeight = chosen.reduce((acc, a) => acc + weightOf(a), 0);
  const giftNum = Number(giftAmount ?? 0);
  const willScale = totalWeight > 0 && Number.isFinite(giftNum) && giftNum > 0;

  let running = 0;
  const rows = chosen.map((a, i) => {
    let subAmount: string | null = a.subAmount;
    if (willScale) {
      if (i === chosen.length - 1) {
        // Last line absorbs the remainder so the copy sums to the gift exactly.
        subAmount = (giftNum - running).toFixed(2);
      } else {
        const scaled = Number(((weightOf(a) / totalWeight) * giftNum).toFixed(2));
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
      otherRestrictionType: a.otherRestrictionType,
      timeRestrictionType: a.timeRestrictionType,
      reimbursementType: a.reimbursementType,
      regionIds: a.regionIds,
      purposeVerbatim: a.purposeVerbatim,
      restrictionDescription: a.restrictionDescription,
      sourcePledgeAllocationId: a.id,
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
  /** The FINAL amount stamped on the gift (Stripe GROSS or QB amount). */
  evidenceAmount: string | null;
  /** Optional payment-intermediary override from the request body. */
  paymentIntermediaryId: string | null;
  /** Latch the opportunity into a pledge (open-only → written_commitment). */
  convert: boolean;
  /** The create-* outcome, echoed into the audit metadata. */
  outcome: string;
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
 * Caller contract: `staged`, `charge`, and `opp` are
 * already locked FOR UPDATE, re-checked approvable, and passed the consistency
 * gate. This performs ONLY the writes + audit; the caller runs the post-commit
 * appliers using the returned ids.
 */
export async function mintGiftInTx(
  tx: Tx,
  args: MintGiftInTxArgs,
): Promise<{
  giftId: string;
  opportunityIdToRederive: string | null;
  /** Gifts whose ledger rows changed in the §4.3 settlement-supersede
   *  recompute; callers must recompute their QB tie status post-commit. */
  rederiveGiftIds: string[];
}> {
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
    userId,
    auditReq,
  } = args;

  // A whole-deposit header (deposit_header) can never mint a gift: its money
  // is already counted on the underlying Payment/SalesReceipt rows, so a gift
  // minted from it would double-count. (applyPaymentApplication backstops
  // this at the ledger anchor; failing here keeps the error pre-write.)
  if (staged.qbEntityType === "deposit_header") {
    throw new Error(
      "This row is a whole-deposit header: its money is already counted on " +
        "the deposit's underlying payment rows, so it cannot create a gift",
    );
  }

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
    // Provenance is the counted ledger row(s) booked below
    // (created_the_gift = true); the transitional final-amount columns are
    // retired (Task #757) and never written.
  });

  // Forward gift intake: seed the gift's allocations from the pledge it pays
  // against, scaled to this payment. Only on the opportunity outcomes (opp
  // loaded); plain create_gift has no opp and stays header-only.
  if (opp) {
    await copyPledgeAllocationsToGift(tx, opp.id, newGiftId, evidenceAmount);
  } else {
    // Plain create_gift (no opp): seed ONE default full-amount allocation
    // carrying the staged row's attributed entity, so the gift never lands
    // scope-less. The fiscal year is derived from the payment date; other
    // scope is left for the fundraiser.
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

  // The QB anchor OWNS the mint — recorded as the counted ledger row's
  // created_the_gift=true (booked below by the caller's applier), not
  // auto-applied → protected from casual revert. The legacy created/matched
  // gift-link columns are @deprecated and no longer written. Adopt the chosen
  // donor onto the evidence row. Guarded on still-approvable to catch a
  // concurrent resolve.
  const updated = await tx
    .update(stagedPayments)
    .set({
      ...donor,
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

  // (Unit groups are retired — docs/adr-linear-money-model.md. A mint books
  // exactly one QB anchor; combined matches go through multi-match instead.)

  // A selected Stripe charge is the precise GROSS source: the counted ledger
  // row booked below ties it to the gift (pointer columns retired) so it stays
  // resolvable + revertible — revert un-sources the amount, never deletes the
  // human mint the QB anchor owns. Mark its payout reconciled.
  if (charge) {
    await tx
      .update(stripeStagedCharges)
      .set({
        ...donor,
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
  // payment CREATED this gift. amountApplied is the QB-settled figure
  // (staged.amount) — independent of a selected Stripe charge's GROSS, which
  // sets the gift's amount but is tracked as separate Stripe evidence.
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
    },
  });

  // §4.3 supersede: if the deposit just booked is confirmed-settled against a
  // payout whose per-charge Stripe rows already cover this gift, the coarse QB
  // row demotes immediately (and vice-versa on later facts).
  const rederiveGiftIds = await applySettlementSupersedeMany(tx, [
    stagedPaymentId,
  ]);

  return {
    giftId: newGiftId,
    opportunityIdToRederive: opportunityId,
    rederiveGiftIds,
  };
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
  /** Whether the reviewer confirmed displacing an incumbent QB staged payment
   *  already linked to the gift (Task #550). */
  displaceLinkedPayment?: boolean;
  /** The incumbent QB staged payment currently linked to the gift, ALREADY
   *  locked, when a displacement was confirmed — disconnected back to the
   *  pending queue before this payment is tied. Null unless displacing. */
  incumbentStagedPayment?: typeof stagedPayments.$inferSelect | null;
  /** Whether the reviewer confirmed moving the ANCHOR payment off the gift it is
   *  presently applied to (its own existing match) onto this one. */
  moveOwnApplication?: boolean;
  /** The gift the anchor payment is presently applied to, ALREADY locked, when a
   *  move was confirmed — its ledger rows are removed and its amount stamp
   *  reversed before this payment is applied to the target gift. Null unless
   *  moving. */
  oldAppliedGift?: typeof giftsAndPayments.$inferSelect | null;
  /** Set ONLY by the link route when the caller verified (under the row lock)
   *  that the staged row is a confirmed DIRECT match (matchedGiftId set, no
   *  created/group gift) being re-targeted through the guarded move/displace
   *  flow. Widens the commit UPDATE's status guard to accept exactly that
   *  shape; false everywhere else so confirmed rows stay immutable. */
  allowRelink?: boolean;
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
): Promise<{
  giftId: string;
  rederivePledgeIds: string[];
  /** The gift the payment was moved OFF of (own-application move), or null —
   *  the caller must recompute ITS QuickBooks tie status too. */
  movedFromGiftId: string | null;
  /** Gifts whose ledger rows changed in the §4.3 settlement-supersede
   *  recompute; callers must recompute their QB tie status post-commit. */
  rederiveGiftIds: string[];
}> {
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
    displaceLinkedPayment = false,
    incumbentStagedPayment = null,
    moveOwnApplication = false,
    oldAppliedGift = null,
    allowRelink = false,
  } = args;

  // Same double-count guard as mintGiftInTx: a whole-deposit header's money
  // is already counted on the underlying Payment rows — it can never be
  // reconciled onto a gift as counted evidence.
  if (staged.qbEntityType === "deposit_header") {
    throw new Error(
      "This row is a whole-deposit header: its money is already counted on " +
        "the deposit's underlying payment rows, so it cannot be reconciled " +
        "to a gift",
    );
  }

  const rederivePledgeIds: string[] = [];
  const finalDonor = effectiveGiftDonor;
  // Did we actually orphan an old backing charge? (drives the audit summary)
  const switchedStripeSource =
    switchStripeSource &&
    !!oldStripeCharge &&
    !!charge &&
    oldStripeCharge.id !== charge.id;

  // Own-application move (human-confirmed). The ANCHOR payment itself already
  // holds a COUNTED cash-application to a DIFFERENT gift (the sync worker
  // auto-matched it to the wrong one — e.g. one of two identical donations).
  // Left in place, `applyPaymentApplication` below would trip its book-once
  // guard (one payment's money counted against two gifts) and dead-end 409.
  // Unwind the payment's OWN old application FIRST — mirror of the incumbent
  // displacement below, but inverted: there the gift keeps its money and the
  // OTHER payment is disconnected; here the payment keeps its money and the
  // OTHER gift releases it. The old gift loses its only QB evidence: remove the
  // ledger rows, reverse the final-amount stamp (pointer-safe — no-ops unless
  // the old gift is still stamped from THIS payment), rebalance its allocation,
  // and re-derive its pledge. The anchor row itself needs no queue reset — the
  // main UPDATE below rewrites it onto the target gift.
  const movedOwnApplication =
    moveOwnApplication && !!oldAppliedGift && oldAppliedGift.id !== giftId;
  if (movedOwnApplication && oldAppliedGift) {
    // The old gift's `amount` was never overwritten by reconciliation
    // (Task #757) — removing the ledger rows is the whole unwind.
    await removePaymentApplicationsForPayment(tx, stagedPaymentId);
    // The old gift's pledge paid-total shifts with its ledger evidence.
    if (oldAppliedGift.opportunityId) {
      rederivePledgeIds.push(oldAppliedGift.opportunityId);
    }
    // If a settlement link on this deposit pins the OLD gift as its conflict
    // gift (the "keep the QB gift" conflict resolution), re-point it at the
    // TARGET gift now — the deposit's booked money is moving there. Left
    // stale, the conflict-keep invariant (kept gift must equal the deposit's
    // gift link) breaks, and the settlement-confirm carry-forward below would
    // re-write the stale pointer. The payout row lock (taken by the caller at
    // tx start) serializes this with every other settlement-link writer.
    await tx
      .update(settlementLinks)
      .set({ conflictGiftId: giftId, updatedAt: new Date() })
      .where(
        and(
          eq(settlementLinks.depositStagedPaymentId, stagedPaymentId),
          eq(settlementLinks.conflictGiftId, oldAppliedGift.id),
        ),
      );
    // The old gift silently loses its QB evidence — record that on ITS trail
    // (the main audit record below covers the target gift).
    await recordAudit(tx, auditReq, {
      action: "update",
      entityType: "gift",
      entityId: oldAppliedGift.id,
      summary:
        "Moved a reconciled QuickBooks payment off this gift (re-targeted to another gift)",
      metadata: {
        stagedPaymentId,
        movedToGiftId: giftId,
        outcome: "link_existing_gift",
      },
    });
  }

  // Task #550 — QB-link displacement (human-confirmed). The gift is already
  // QB-linked to a DIFFERENT staged payment (the incumbent); the main UPDATE
  // below would otherwise dead-end on its `NOT qbLedgerExistsForGiftExcluding
  // Payment` guard. Disconnect the incumbent FIRST so that guard passes, then
  // link this payment. Mirrors the QB single-payment revert (quickbooks/
  // shared.ts revertOneStagedPayment isReconcile branch): undo the incumbent's
  // cash-application to the gift, reverse its final-amount stamp, and return it
  // to the pending/unmatched queue. The gift itself is NEVER touched here — it
  // is the displacement TARGET and stays put.
  const displacedLinkedPayment =
    displaceLinkedPayment &&
    !!incumbentStagedPayment &&
    incumbentStagedPayment.id !== stagedPaymentId;
  if (displacedLinkedPayment && incumbentStagedPayment) {
    // Only a DIRECT match incumbent is safely displaceable one-at-a-time. A gift
    // linked through a split must be reverted deliberately — half-releasing it
    // would corrupt the split invariant. Refuse it.
    // The shape is read from the LEDGER (the legacy gift-link columns are
    // @deprecated and no longer written): a counted non-mint QB application
    // from the incumbent to THIS gift.
    const [dm] = await tx
      .select({
        ok: qbLedgerDirectMatchExists(
          sql`${incumbentStagedPayment.id}`,
          sql`${giftId}`,
        ),
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, incumbentStagedPayment.id));
    if (!dm?.ok) {
      throw new ReconcileAbort(409, {
        error: "incumbent_not_displaceable",
        message:
          "That gift is linked to another payment through a split. Revert that reconciliation first, then re-target.",
      });
    }
    // The gift's `amount` was never overwritten by reconciliation (Task #757)
    // — removing the incumbent's ledger rows is the whole disconnect.
    await removePaymentApplicationsForPayment(tx, incumbentStagedPayment.id);
    await tx
      .update(stagedPayments)
      .set({
        // Clearing the confirmation facts (the ledger rows are already gone)
        // derives the row back to `pending` (status is DERIVED —
        // lib/derivedStatus.ts reads the ledger).
        autoApplied: false,
        matchConfirmedByUserId: null,
        matchConfirmedAt: null,
        approvedByUserId: null,
        approvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(stagedPayments.id, incumbentStagedPayment.id));
  }

  // Tie the staged row to the gift. Only succeeds if still approvable AND no
  // other staged payment already QB-claims this gift in the ledger — the ledger
  // guard backstops a write-skew between the lock and the commit. The tie
  // itself is the counted payment_applications row booked by the caller's
  // applier after this commit; the legacy matched/created gift-link columns
  // are @deprecated and no longer written.
  const updated = await tx
    .update(stagedPayments)
    .set({
      ...finalDonor,
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
        // Normally the row must still be approvable. On the guarded relink
        // path (allowRelink — set only by the link route after verifying the
        // shape under the row lock) also accept a confirmed DIRECT match to
        // THIS gift (ledger shape: counted non-mint application, not a group
        // member). The shape is re-checked here in SQL so a concurrent writer
        // changing the row between the caller's check and this UPDATE makes
        // it match zero rows (409 below). A cross-gift re-target runs the
        // moveOwnApplication branch first, which deletes the payment's ledger
        // rows — the row then DERIVES back to pending and passes the normal
        // approvable arm instead.
        allowRelink
          ? or(
              stagedStatusIn(APPROVABLE_STAGED_STATUSES),
              and(
                stagedStatusIn(["match_confirmed"]),
                sql`${qbLedgerDirectMatchExists(sql`${stagedPayments.id}`, sql`${giftId}`)}`,
              ),
            )
          : stagedStatusIn(APPROVABLE_STAGED_STATUSES),
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
  // Orphan the old charge FIRST — the counted ledger's per-gift UNIQUE forbids
  // two charges settling one gift, and the unstamp only fires while the gift is
  // still stamped from the OLD charge, so the old ledger row must be removed
  // before the new charge is booked below. Mirrors the single-charge
  // revert (stripe.ts): drop the old charge's ledger row, unstamp the gift (a
  // no-op for the amount when it was Stripe-sourced — Stripe amount is derived),
  // then return the charge to the unmatched-money queue. We never delete the
  // gift here even if the old charge minted it: the gift is the switch target.
  if (switchedStripeSource && oldStripeCharge) {
    await orphanStripeSourceChargeInTx(tx, {
      oldCharge: oldStripeCharge,
      giftId,
    });
  }

  // The gift's `amount` is never overwritten by reconciliation (Task #757) —
  // settled money is derived from the counted ledger rows booked below.

  // Dual-write (Phase 2): book the QB cash-application ledger row. The QB staged
  // payment settles this EXISTING gift (links, never mints). A selected Stripe
  // charge is separate evidence (it sets the gift's GROSS amount); the QB ledger
  // row still records the QB-settled amount.
  if (staged.amount && Number(staged.amount) > 0) {
    try {
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
    } catch (e) {
      // The book-once guard refuses to over-apply this payment: it is still
      // holding a COUNTED cash-application to a DIFFERENT gift (e.g. the QB
      // worker's auto-match left it `approved` with a system ledger row). A
      // re-target here would apply one payment's money to two gifts. Surface it
      // as a handled 409 (like every other in-tx conflict) instead of letting a
      // raw PaymentOverApplicationError escape to the global 500 handler. The
      // reviewer must revert that existing match before re-targeting.
      if (e instanceof PaymentOverApplicationError) {
        throw new ReconcileAbort(409, {
          error: "payment_already_applied",
          message:
            "This payment is already applied to another gift (an existing match). Revert that reconciliation first, then re-target it here.",
        });
      }
      throw e;
    }
  }

  // Mark the Stripe charge + its payout as permanent reconciled evidence.
  if (charge) {
    // The counted ledger row booked below IS the charge↔gift tie (pointer
    // columns retired): it is what the charge list/detail resolves the gift
    // through and what the revert flow unwinds. The ledger's per-gift UNIQUE
    // keeps a gift claimable by at most ONE charge (23505 → 409 link_conflict).
    await tx
      .update(stripeStagedCharges)
      .set({
        ...finalDonor,
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
  if (displacedLinkedPayment)
    summaryParts.push("displaced its previously linked payment");
  if (movedOwnApplication)
    summaryParts.push("moved the payment off its previously matched gift");
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
      ...(displacedLinkedPayment && incumbentStagedPayment
        ? {
            displacedLinkedPayment: true,
            displacedStagedPaymentId: incumbentStagedPayment.id,
          }
        : {}),
      ...(movedOwnApplication && oldAppliedGift
        ? {
            movedOwnApplication: true,
            movedOwnApplicationFromGiftId: oldAppliedGift.id,
          }
        : {}),
    },
  });

  // §4.3 supersede: if this deposit is confirmed-settled against a payout
  // whose per-charge Stripe rows already cover the linked gift, the coarse QB
  // row just booked demotes immediately.
  const rederiveGiftIds = await applySettlementSupersedeMany(tx, [
    stagedPaymentId,
  ]);

  return {
    giftId,
    rederivePledgeIds,
    // The gift this payment was moved OFF of (own-application move), so the
    // caller can recompute ITS QuickBooks tie status too — it just lost its only
    // QB evidence (likely → `missing`). Null when no move happened.
    movedFromGiftId: movedOwnApplication && oldAppliedGift ? oldAppliedGift.id : null,
    rederiveGiftIds,
  };
}

/**
 * Orphan the Stripe charge currently backing a gift so a DIFFERENT charge can
 * become its Stripe source (a human-confirmed switch). Drops the old charge's
 * payment-application ledger row, unstamps the gift (pointer-safe: a no-op
 * unless the gift still points at the OLD charge), and returns the charge to
 * the unmatched-money queue — or the excluded bucket when its raw Stripe
 * status is 'failed': a failed charge never settled and must not look like
 * real money again. The gift itself is NEVER deleted here, even if the old
 * charge minted it — the gift is the switch target.
 *
 * Callers must hold FOR UPDATE locks on both the gift and the old charge, and
 * must orphan BEFORE stamping/linking the new charge: the counted ledger's
 * per-gift UNIQUE forbids two charges settling one gift, and the unstamp
 * only fires while the gift is still stamped from the old charge. Shared by the
 * deposit-approve re-target commit (above) and the per-charge link-gift route
 * (stripe.ts) so the two switch paths can't drift.
 */
export async function orphanStripeSourceChargeInTx(
  tx: Tx,
  args: {
    oldCharge: typeof stripeStagedCharges.$inferSelect;
    giftId: string;
  },
): Promise<void> {
  const { oldCharge, giftId } = args;
  // The gift's `amount` was never overwritten by reconciliation (Task #757) —
  // removing the old charge's ledger row is the whole unwind. giftId stays in
  // the signature: callers must still hold the gift lock while orphaning.
  void giftId;
  await removePaymentApplicationsForStripeCharge(tx, oldCharge.id);
  const oldHasDonor =
    !!oldCharge.organizationId ||
    !!oldCharge.individualGiverPersonId ||
    !!oldCharge.householdId;
  const oldRawStatus =
    oldCharge.rawCharge && typeof oldCharge.rawCharge === "object"
      ? ((oldCharge.rawCharge as Record<string, unknown>)["status"] ?? null)
      : null;
  // Failed → failed_charge (never settled). Otherwise a FULLY-refunded charge,
  // once orphaned, is never-booked refunded money → refunded_charge (a dispute
  // is a chargeback, not this — mirrors isFullyRefunded).
  const orphanExclusion =
    oldRawStatus === "failed"
      ? ("failed_charge" as const)
      : isFullyRefunded({
            refunded: oldCharge.refunded === true,
            disputed: oldCharge.disputed === true,
            amountRefunded: oldCharge.amountRefunded,
            grossAmount: oldCharge.grossAmount,
          })
        ? ("refunded_charge" as const)
        : null;
  await tx
    .update(stripeStagedCharges)
    .set({
      // Status is DERIVED: an exclusion reason ⇒ excluded, cleared links ⇒ pending.
      // (The gift link itself is the counted ledger row, deleted by the caller.)
      exclusionReason: orphanExclusion,
      autoApplied: false,
      matchStatus: oldHasDonor ? "suggested" : "unmatched",
      matchConfirmedAt: null,
      matchConfirmedByUserId: null,
      approvedAt: null,
      approvedByUserId: null,
      ...(oldCharge.refundPropagationStatus === "proposed"
        ? {
            refundPropagationStatus: "none" as const,
            refundPropagationKind: null,
            refundPropagationGiftId: null,
            refundProposedAmount: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(stripeStagedCharges.id, oldCharge.id));
}
