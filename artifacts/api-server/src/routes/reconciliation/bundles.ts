import { Router, type IRouter } from "express";
import { requireFinance } from "../../lib/financeGuard";
import { db } from "@workspace/db";
import {
  stagedPayments,
  stripePayouts,
  stripeStagedCharges,
  donorboxDonations,
  settlementLinks,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { asyncHandler, notFound } from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import { sweepRefundedQbStagedPayments } from "../../lib/refundedChargeSweep";

// ─── POST /reconciliation/bundles/:stagedPaymentId/confirm-ties ────────────
// Persist the human-confirmed cross-processor links for one settlement bundle
// anchored on a QB staged-payment deposit. Additive + idempotent: it only ever
// fills NULL link fields (never overwrites), mints no gifts (enrich, don't
// mint), and writes nothing back to QuickBooks / Stripe / Donorbox. The pulled
// join keys already drive the lineage display; this stamps the reviewer's
// affirmation onto the dedicated link columns so the three sources are directly
// tied with who/when provenance.
const router: IRouter = Router();

router.post(
  "/reconciliation/bundles/:stagedPaymentId/confirm-ties",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const rawId = req.params["stagedPaymentId"];
    const id = typeof rawId === "string" ? rawId : "";

    const [staged] = await db
      .select({ id: stagedPayments.id })
      .from(stagedPayments)
      .where(eq(stagedPayments.id, id))
      .limit(1);
    if (!staged) return notFound(res, "reconciliation card");

    // The Stripe payout tied to this deposit (authoritative settlement_links
    // covers every lifecycle — proposed/confirmed and the conflict tie).
    const [payout] = await db
      .select({ id: stripePayouts.id })
      .from(settlementLinks)
      .innerJoin(stripePayouts, eq(stripePayouts.id, settlementLinks.payoutId))
      .where(eq(settlementLinks.depositStagedPaymentId, id))
      .limit(1);

    let chargesLinked = 0;
    let donationsLinked = 0;

    if (payout) {
      await db.transaction(async (tx) => {
        const now = new Date();

        // Stripe charges settled in this payout that aren't yet tied to a QB
        // deposit → stamp the deposit + reviewer + timestamp.
        const unlinkedCharges = await tx
          .select({ id: stripeStagedCharges.id })
          .from(stripeStagedCharges)
          .where(
            and(
              eq(stripeStagedCharges.stripePayoutId, payout.id),
              isNull(stripeStagedCharges.linkedQbStagedPaymentId),
            ),
          )
          .for("update");
        const unlinkedChargeIds = unlinkedCharges.map((c) => c.id);
        if (unlinkedChargeIds.length > 0) {
          await tx
            .update(stripeStagedCharges)
            .set({
              linkedQbStagedPaymentId: id,
              crossProcessorLinkedByUserId: user.id,
              crossProcessorLinkedAt: now,
            })
            .where(inArray(stripeStagedCharges.id, unlinkedChargeIds));
          chargesLinked = unlinkedChargeIds.length;
        }

        // Every charge in this payout (newly + previously linked) is a tie
        // candidate for its enrichment Donorbox donation.
        const allCharges = await tx
          .select({ id: stripeStagedCharges.id })
          .from(stripeStagedCharges)
          .where(eq(stripeStagedCharges.stripePayoutId, payout.id));
        const allChargeIds = allCharges.map((c) => c.id);

        if (allChargeIds.length > 0) {
          const unlinkedDonations = await tx
            .select({
              id: donorboxDonations.id,
              stripeChargeId: donorboxDonations.stripeChargeId,
            })
            .from(donorboxDonations)
            .where(
              and(
                inArray(donorboxDonations.stripeChargeId, allChargeIds),
                isNull(donorboxDonations.linkedStripeChargeId),
              ),
            )
            .for("update");
          for (const d of unlinkedDonations) {
            await tx
              .update(donorboxDonations)
              .set({
                linkedStripeChargeId: d.stripeChargeId,
                linkedQbStagedPaymentId: id,
                crossProcessorLinkedByUserId: user.id,
                crossProcessorLinkedAt: now,
              })
              .where(eq(donorboxDonations.id, d.id));
            donationsLinked += 1;
          }
        }
      });

      // Freshly-stamped ties can complete a pending QB row's Stripe trace as
      // all-refunded money — sweep so it lands in Excluded immediately.
      await sweepRefundedQbStagedPayments();
    }

    res.json({ ok: true, chargesLinked, donationsLinked });
  }),
);

export default router;
