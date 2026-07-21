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
import { and, eq, inArray, sql } from "drizzle-orm";
import { asyncHandler, notFound } from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import { sweepRefundedQbStagedPayments } from "../../lib/refundedChargeSweep";
import { upsertDonorboxCounterpartLink } from "../../lib/sourceLinkWrites";

// ─── POST /reconciliation/bundles/:stagedPaymentId/confirm-ties ────────────
// Persist the human-confirmed cross-processor links for one settlement bundle
// anchored on a QB staged-payment deposit. Additive + idempotent: it only ever
// fills missing links (never overwrites), mints no gifts (enrich, don't
// mint), and writes nothing back to QuickBooks / Stripe / Donorbox. The pulled
// join keys already drive the lineage display; this stamps the reviewer's
// affirmation onto the Donorbox counterpart links so the three sources are
// directly tied with who/when provenance. Charge↔deposit membership is
// already authoritative via settlement_links + stripe_payout_id (see NOTE in
// the handler) — no charge_qb_tie rows are minted here.
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

    // NOTE: this route deliberately does NOT mint `charge_qb_tie` ledger rows.
    // Per the source-link ADR, `charge_qb_tie` means "charge ↔ individually-
    // booked QB row" and is DB-unique per QB row (confirmed) — a settlement
    // bundle's many charges settling into ONE deposit lump is a different
    // fact, already carried authoritatively by the settlement link
    // (payout ↔ deposit) plus each charge's `stripe_payout_id`. Stamping
    // per-charge deposit ties here would violate the QB-side uniqueness for
    // any multi-charge payout. `chargesLinked` stays in the response contract
    // and is always 0 now.
    const chargesLinked = 0;
    let donationsLinked = 0;

    if (payout) {
      await db.transaction(async (tx) => {
        const now = new Date();

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
                sql`NOT EXISTS (
                  SELECT 1 FROM source_links srcl
                  WHERE srcl.link_type = 'donorbox_charge'
                    AND srcl.donorbox_donation_id = "donorbox_donations"."id"
                )`,
              ),
            )
            .for("update", { of: donorboxDonations });
          for (const d of unlinkedDonations) {
            await upsertDonorboxCounterpartLink(
              tx,
              "donorbox_charge",
              d.id,
              d.stripeChargeId as string,
              user.id,
              now,
            );
            await upsertDonorboxCounterpartLink(
              tx,
              "donorbox_qb",
              d.id,
              id,
              user.id,
              now,
            );
            await tx
              .update(donorboxDonations)
              .set({
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
