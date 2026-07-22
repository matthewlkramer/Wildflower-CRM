import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  stagedPayments,
  stripePayouts,
  stripeStagedCharges,
  settlementLinks,
  donorboxDonations,
  organizations,
  people,
  households,
} from "@workspace/db/schema";
import { eq, inArray, or, sql } from "drizzle-orm";
import { asyncHandler, notFound } from "../../lib/helpers";
import { payoutStatusFromLink } from "../../lib/settlementLink";
import { chargeStatusSql } from "../../lib/derivedStatus";
import { stripeLedgerCountedExistsForCharge } from "../../lib/paymentApplications";
import { personDisplayNameSql } from "../../lib/personNameSql";

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
    // Resolved through the authoritative settlement_links row (one
    // `deposit_staged_payment_id`, covering proposed / confirmed / conflict),
    // not the legacy pointer columns.
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
        lifecycle: settlementLinks.lifecycle,
        conflictGiftId: settlementLinks.conflictGiftId,
      })
      .from(settlementLinks)
      .innerJoin(stripePayouts, eq(stripePayouts.id, settlementLinks.payoutId))
      .where(eq(settlementLinks.depositStagedPaymentId, id))
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
          reconciliationStatus: payoutStatusFromLink(payoutRow),
          linkSource: "pulled" as LinkSource,
        }
      : null;

    // ── Stripe charges: those settled in the payout (pulled) + any per-charge
    // reviewer-confirmed ties to this QB row (qb_confirmed). ────────────────
    const chargeFilters = [
      sql`EXISTS (
        SELECT 1 FROM source_links srcl_ct
        WHERE srcl_ct.link_type = 'charge_qb_tie'
          AND srcl_ct.lifecycle = 'confirmed'
          AND srcl_ct.stripe_charge_id = "stripe_staged_charges"."id"
          AND srcl_ct.qb_staged_payment_id = ${id}
      )`,
    ];
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
        // DERIVED lifecycle status (no stored column) — lib/derivedStatus.ts.
        status: chargeStatusSql.as("status"),
        exclusionReason: stripeStagedCharges.exclusionReason,
        organizationId: stripeStagedCharges.organizationId,
        individualGiverPersonId: stripeStagedCharges.individualGiverPersonId,
        householdId: stripeStagedCharges.householdId,
        // Ledger-derived gift link (pointer columns are retired, never read).
        hasLedgerGift: sql<boolean>`${stripeLedgerCountedExistsForCharge()}`,
        resolvedDonorName: sql<string | null>`
          COALESCE(
            ${organizations.name},
            ${households.name},
            ${personDisplayNameSql(people)}
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
        exclusionReason: c.exclusionReason,
        donorResolved: Boolean(
          c.organizationId || c.individualGiverPersonId || c.householdId,
        ),
        hasGift: c.hasLedgerGift === true,
        resolvedDonorName: c.resolvedDonorName,
      }));

    // ── Donorbox donations: enrichment for the Stripe charges (pulled
    // stripeChargeId or reviewer-confirmed linkedStripeChargeId) + any
    // non-Stripe new money the reviewer tied directly to this QB deposit. ───
    const chargeIds = charges.map((c) => c.chargeId);
    const donationFilters = [
      sql`EXISTS (
        SELECT 1 FROM source_links srcl_dq
        WHERE srcl_dq.link_type = 'donorbox_qb'
          AND srcl_dq.donorbox_donation_id = "donorbox_donations"."id"
          AND srcl_dq.qb_staged_payment_id = ${id}
      )`,
    ];
    if (chargeIds.length > 0) {
      donationFilters.push(inArray(donorboxDonations.stripeChargeId, chargeIds));
      donationFilters.push(
        sql`EXISTS (
          SELECT 1 FROM source_links srcl_dc
          WHERE srcl_dc.link_type = 'donorbox_charge'
            AND srcl_dc.donorbox_donation_id = "donorbox_donations"."id"
            AND srcl_dc.stripe_charge_id IN (${sql.join(
              chargeIds.map((cid) => sql`${cid}`),
              sql`, `,
            )})
        )`,
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
        linkedStripeChargeId: sql<string | null>`(
          SELECT srcl_lc.stripe_charge_id FROM source_links srcl_lc
          WHERE srcl_lc.link_type = 'donorbox_charge'
            AND srcl_lc.donorbox_donation_id = "donorbox_donations"."id"
        )`,
        linkedQbStagedPaymentId: sql<string | null>`(
          SELECT srcl_lq.qb_staged_payment_id FROM source_links srcl_lq
          WHERE srcl_lq.link_type = 'donorbox_qb'
            AND srcl_lq.donorbox_donation_id = "donorbox_donations"."id"
        )`,
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
