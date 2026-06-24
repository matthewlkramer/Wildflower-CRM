import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  stripePayouts,
  stripeStagedCharges,
  donorboxDonations,
  organizations,
  people,
  households,
} from "@workspace/db/schema";
import { eq, inArray, or, sql } from "drizzle-orm";
import { asyncHandler, notFound } from "../../lib/helpers";

type LinkSource = "pulled" | "qb_confirmed" | "stripe_pulled" | "stripe_confirmed";

// ─── GET /reconciliation/cards/:stagedPaymentId/lineage ───────────────────
// Read-only settlement lineage: the QB deposit anchor and the SAME money traced
// across Stripe (payout + charges) and Donorbox (donations). Derived from the
// pulled join keys (payout↔QB tie, charge.stripePayoutId, donation.stripeChargeId)
// PLUS any human-confirmed cross-processor links. Nothing is mutated.
const router: IRouter = Router();

router.get(
  "/reconciliation/cards/:stagedPaymentId/lineage",
  asyncHandler(async (req, res) => {
    const rawId = req.params["stagedPaymentId"];
    const id = typeof rawId === "string" ? rawId : "";

    const [staged] = await db
      .select({
        id: stagedPayments.id,
        amount: stagedPayments.amount,
        dateReceived: stagedPayments.dateReceived,
        payerName: stagedPayments.payerName,
        qbPaymentMethod: stagedPayments.qbPaymentMethod,
        qbDocNumber: stagedPayments.qbDocNumber,
        qbDepositId: stagedPayments.qbDepositId,
        qbDepositToAccountName: stagedPayments.qbDepositToAccountName,
      })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .limit(1);

    if (!staged) return notFound(res, "reconciliation card");

    // ── Stripe payout tied to this deposit (confirmed or proposed) ─────────
    const [payoutRow] = await db
      .select({
        id: stripePayouts.id,
        amount: stripePayouts.amount,
        grossTotal: stripePayouts.grossTotal,
        feeTotal: stripePayouts.feeTotal,
        netTotal: stripePayouts.netTotal,
        chargeCount: stripePayouts.chargeCount,
        arrivalDate: stripePayouts.arrivalDate,
        status: stripePayouts.status,
        qbReconciliationStatus: stripePayouts.qbReconciliationStatus,
      })
      .from(stripePayouts)
      .where(
        or(
          eq(stripePayouts.matchedQbStagedPaymentId, id),
          eq(stripePayouts.proposedQbStagedPaymentId, id),
        ),
      )
      .limit(1);

    const payout = payoutRow
      ? {
          payoutId: payoutRow.id,
          amount: payoutRow.amount,
          grossTotal: payoutRow.grossTotal,
          feeTotal: payoutRow.feeTotal,
          netTotal: payoutRow.netTotal,
          chargeCount: payoutRow.chargeCount,
          arrivalDate: payoutRow.arrivalDate,
          status: payoutRow.status,
          reconciliationStatus: payoutRow.qbReconciliationStatus,
          linkSource: "pulled" as LinkSource,
        }
      : null;

    // ── Stripe charges: those settled in the payout (pulled) + any per-charge
    // reviewer-confirmed ties to this QB row (qb_confirmed). ────────────────
    const chargeFilters = [eq(stripeStagedCharges.linkedQbStagedPaymentId, id)];
    if (payoutRow) {
      chargeFilters.push(eq(stripeStagedCharges.stripePayoutId, payoutRow.id));
    }
    const chargeRows = await db
      .select({
        id: stripeStagedCharges.id,
        grossAmount: stripeStagedCharges.grossAmount,
        feeAmount: stripeStagedCharges.feeAmount,
        netAmount: stripeStagedCharges.netAmount,
        dateReceived: stripeStagedCharges.dateReceived,
        payerName: stripeStagedCharges.payerName,
        payerEmail: stripeStagedCharges.payerEmail,
        description: stripeStagedCharges.description,
        refunded: stripeStagedCharges.refunded,
        disputed: stripeStagedCharges.disputed,
        stripePayoutId: stripeStagedCharges.stripePayoutId,
        status: stripeStagedCharges.status,
        organizationId: stripeStagedCharges.organizationId,
        individualGiverPersonId: stripeStagedCharges.individualGiverPersonId,
        householdId: stripeStagedCharges.householdId,
        matchedGiftId: stripeStagedCharges.matchedGiftId,
        createdGiftId: stripeStagedCharges.createdGiftId,
        resolvedDonorName: sql<string | null>`
          COALESCE(
            ${organizations.name},
            ${households.name},
            NULLIF(TRIM(${people.fullName}), ''),
            NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
          )
        `,
      })
      .from(stripeStagedCharges)
      .leftJoin(
        organizations,
        eq(organizations.id, stripeStagedCharges.organizationId),
      )
      .leftJoin(people, eq(people.id, stripeStagedCharges.individualGiverPersonId))
      .leftJoin(households, eq(households.id, stripeStagedCharges.householdId))
      .where(chargeFilters.length === 1 ? chargeFilters[0] : or(...chargeFilters));

    // Dedupe by charge id; a charge that settled in the payout is "pulled",
    // otherwise it reached this deposit via a reviewer-confirmed QB tie.
    const seenCharge = new Set<string>();
    const charges = chargeRows
      .filter((c) => {
        if (seenCharge.has(c.id)) return false;
        seenCharge.add(c.id);
        return true;
      })
      .map((c) => ({
        chargeId: c.id,
        grossAmount: c.grossAmount,
        feeAmount: c.feeAmount,
        netAmount: c.netAmount,
        dateReceived: c.dateReceived,
        payerName: c.payerName,
        payerEmail: c.payerEmail,
        description: c.description,
        refunded: c.refunded,
        disputed: c.disputed,
        linkSource: (payoutRow && c.stripePayoutId === payoutRow.id
          ? "pulled"
          : "qb_confirmed") as LinkSource,
        status: c.status,
        donorResolved: Boolean(
          c.organizationId || c.individualGiverPersonId || c.householdId,
        ),
        hasGift: Boolean(c.matchedGiftId || c.createdGiftId),
        resolvedDonorName: c.resolvedDonorName,
      }));

    // ── Donorbox donations: enrichment for the Stripe charges (pulled
    // stripeChargeId or reviewer-confirmed linkedStripeChargeId) + any
    // non-Stripe new money the reviewer tied directly to this QB deposit. ───
    const chargeIds = charges.map((c) => c.chargeId);
    const donationFilters = [eq(donorboxDonations.linkedQbStagedPaymentId, id)];
    if (chargeIds.length > 0) {
      donationFilters.push(inArray(donorboxDonations.stripeChargeId, chargeIds));
      donationFilters.push(
        inArray(donorboxDonations.linkedStripeChargeId, chargeIds),
      );
    }
    const donationRows = await db
      .select({
        id: donorboxDonations.id,
        donationType: donorboxDonations.donationType,
        amount: donorboxDonations.amount,
        dateReceived: donorboxDonations.dateReceived,
        donorName: donorboxDonations.donorName,
        donorEmail: donorboxDonations.donorEmail,
        campaignName: donorboxDonations.campaignName,
        designation: donorboxDonations.designation,
        refunded: donorboxDonations.refunded,
        stripeChargeId: donorboxDonations.stripeChargeId,
        linkedStripeChargeId: donorboxDonations.linkedStripeChargeId,
        linkedQbStagedPaymentId: donorboxDonations.linkedQbStagedPaymentId,
      })
      .from(donorboxDonations)
      .where(
        donationFilters.length === 1
          ? donationFilters[0]
          : or(...donationFilters),
      );

    const chargeIdSet = new Set(chargeIds);
    const seenDonation = new Set<string>();
    const donations = donationRows
      .filter((d) => {
        if (seenDonation.has(d.id)) return false;
        seenDonation.add(d.id);
        return true;
      })
      .map((d) => {
        let linkSource: LinkSource;
        if (d.stripeChargeId && chargeIdSet.has(d.stripeChargeId)) {
          linkSource = "stripe_pulled";
        } else if (
          d.linkedStripeChargeId &&
          chargeIdSet.has(d.linkedStripeChargeId)
        ) {
          linkSource = "stripe_confirmed";
        } else {
          linkSource = "qb_confirmed";
        }
        return {
          donationId: d.id,
          donationType: d.donationType,
          amount: d.amount,
          dateReceived: d.dateReceived,
          donorName: d.donorName,
          donorEmail: d.donorEmail,
          campaignName: d.campaignName,
          designation: d.designation,
          refunded: d.refunded,
          linkSource,
        };
      });

    res.json({
      stagedPaymentId: staged.id,
      deposit: {
        stagedPaymentId: staged.id,
        amount: staged.amount,
        dateReceived: staged.dateReceived,
        payerName: staged.payerName,
        paymentMethod: staged.qbPaymentMethod,
        docNumber: staged.qbDocNumber,
        depositId: staged.qbDepositId,
        depositToAccountName: staged.qbDepositToAccountName,
      },
      payout,
      charges,
      donations,
    });
  }),
);

export default router;
