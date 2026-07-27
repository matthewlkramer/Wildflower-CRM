// Tie-aware gift COMBINE: absorb one or more "loser" gifts' reconciled
// payment evidence onto a surviving gift. The unit→gift tie
// (payment_units.gift_id + fact columns) is the SOLE counted evidence
// surface, and unit_gift_corroboration source_links the corroborating one —
// the legacy matched/created gift pointer columns and the
// payment_applications ledger are retired (never read or written).
//
// Historically the merge route hard-BLOCKED (409) whenever a loser carried ANY
// QuickBooks / Stripe / Donorbox link. That is too blunt now that everything
// lives on the tie: a mundane "two duplicate gifts, one has a QB match"
// merge should just re-home that evidence onto the survivor. This helper does
// exactly that, and 409s ONLY on the handful of link shapes kept unmergeable
// by design:
//   - split_link       — a loser wired into a staged-payment SPLIT, or a
//                         survivor split that would have to coexist with
//                         absorbed group/direct QB evidence (split precedence
//                         reads a single sub-amount, so it can't sum a group).
//   - stripe_charge    — two+ distinct Stripe charges would have to settle the
//                         one survivor (kept 1:1 by policy, matching the
//                         historical single-valued link shape).
//   - donorbox_donation — same, for Donorbox donations.
//
// Everything it writes lives inside the caller's transaction; on a collision it
// writes NOTHING and returns the collision so the route can 409 with a clean,
// no-op rollback.
import type { db } from "@workspace/db";
import { paymentUnits, sourceLinks, sourceLinkId } from "@workspace/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CombineCollision =
  | { kind: "split_link" }
  | { kind: "stripe_charge" }
  | { kind: "donorbox_donation" };

export interface AbsorbEvidenceResult {
  collision: CombineCollision | null;
}

/**
 * Absorb every loser gift's reconciled payment evidence onto `survivorId`,
 * inside the caller's transaction. Detects the unrepresentable link collisions
 * FIRST (before any write); on collision returns `{ collision }` having written
 * nothing so the caller can 409 and let the transaction roll back cleanly.
 *
 * On success the counted unit ties and corroborating claims are re-homed onto
 * the survivor. One unit funds one gift, so re-homing is a pure gift_id
 * re-point — dollar amounts live on the units themselves and never sum here.
 * The caller is still responsible for moving allocations, summing the survivor
 * amount, clearing self-referential match pointers, archiving the losers, and
 * recomputing derived fields / QB tie afterward.
 */
export async function absorbGiftEvidenceIntoSurvivor(
  tx: Tx,
  survivorId: string,
  loserIds: string[],
): Promise<AbsorbEvidenceResult> {
  const allIds = [survivorId, ...loserIds];
  const loserSet = new Set(loserIds);

  // ── 1. Read every evidence surface for the whole merged set ──────────────
  // Split-shape wiring: a counted QB unit whose staged payment funds MORE THAN
  // ONE gift (a split's resolution lives entirely on the ties — the legacy
  // staged_payments gift-link columns are @deprecated and no longer written,
  // so the split shape is COUNT(tied units on the payment) > 1).
  const splitRows = await tx
    .select({ giftId: sql<string>`${paymentUnits.giftId}` })
    .from(paymentUnits)
    .where(
      and(
        inArray(paymentUnits.giftId, allIds),
        isNotNull(paymentUnits.sourceStagedPaymentId),
        sql`(
          SELECT COUNT(*) FROM payment_units pu2
          WHERE pu2.source_staged_payment_id = ${paymentUnits.sourceStagedPaymentId}
            AND pu2.gift_id IS NOT NULL
        ) > 1`,
      ),
    );

  // Counted unit ties for the whole merged set. Evidence source follows the
  // unit's own anchor columns (quickbooks ⇔ staged payment, stripe ⇔ charge,
  // donorbox ⇔ donation with no finer anchor).
  const tiedUnits = await tx
    .select({
      id: paymentUnits.id,
      giftId: sql<string>`${paymentUnits.giftId}`,
      paymentId: paymentUnits.sourceStagedPaymentId,
      stripeChargeId: paymentUnits.stripeChargeId,
      donorboxDonationId: paymentUnits.donorboxDonationId,
    })
    .from(paymentUnits)
    .where(and(inArray(paymentUnits.giftId, allIds)))
    .for("update");

  const sourceOf = (u: (typeof tiedUnits)[number]) =>
    u.paymentId != null
      ? "quickbooks"
      : u.stripeChargeId != null
        ? "stripe"
        : "donorbox";

  // Corroborating claims (unit_gift_corroboration source_links — the Phase-5
  // fold of gift_evidence_links, incl. supersede demotion crumbs). Audit-only
  // and never summed, so they re-home by simple dedupe.
  const corrLinks = await tx
    .select({
      id: sourceLinks.id,
      giftId: sql<string>`${sourceLinks.giftId}`,
      paymentUnitId: sql<string>`${sourceLinks.paymentUnitId}`,
      lifecycle: sourceLinks.lifecycle,
      provenance: sourceLinks.provenance,
      matchBasis: sourceLinks.matchBasis,
      confirmedByUserId: sourceLinks.confirmedByUserId,
      confirmedAt: sourceLinks.confirmedAt,
      note: sourceLinks.note,
    })
    .from(sourceLinks)
    .where(
      and(
        eq(sourceLinks.linkType, "unit_gift_corroboration"),
        inArray(sourceLinks.giftId, allIds),
      ),
    );

  // ── 2. Collision detection (no writes past this point until it passes) ───
  const loserSplit = splitRows.some((r) => loserSet.has(r.giftId));
  const survivorSplit = splitRows.some((r) => r.giftId === survivorId);
  // ALL evidence (QB / Stripe / Donorbox) is read from the counted ties —
  // the legacy pointer columns are retired.
  const loserQbEvidence = tiedUnits.some((r) => loserSet.has(r.giftId));
  // A loser split can't be re-homed (a split sub-amount is single-valued, no
  // group shape); a survivor split can't coexist with absorbed group/direct QB
  // evidence (split precedence would mask the summed group). Either way: 409.
  if (loserSplit || (survivorSplit && loserQbEvidence)) {
    return { collision: { kind: "split_link" } };
  }

  // At most ONE Stripe charge / Donorbox donation may settle the survivor —
  // kept 1:1 by policy (the historical link shape). Absorbing a loser's charge
  // is only possible when it leaves the survivor with a single charge total.
  // Counted unit ties are the sole link surface (one per charge/donation).
  const loserStripe = tiedUnits.filter(
    (r) => sourceOf(r) === "stripe" && loserSet.has(r.giftId),
  );
  const survivorStripe = tiedUnits.filter(
    (r) => sourceOf(r) === "stripe" && r.giftId === survivorId,
  );
  if (loserStripe.length >= 1 && loserStripe.length + survivorStripe.length >= 2) {
    return { collision: { kind: "stripe_charge" } };
  }
  const loserDonorbox = tiedUnits.filter(
    (r) => sourceOf(r) === "donorbox" && loserSet.has(r.giftId),
  );
  const survivorDonorbox = tiedUnits.filter(
    (r) => sourceOf(r) === "donorbox" && r.giftId === survivorId,
  );
  if (
    loserDonorbox.length >= 1 &&
    loserDonorbox.length + survivorDonorbox.length >= 2
  ) {
    return { collision: { kind: "donorbox_donation" } };
  }

  const now = new Date();

  // ── 3. Consolidate the counted ties onto the survivor ────────────────────
  // One unit funds one gift, so every loser unit simply re-points. Dollar
  // amounts live on the units (never summed here); the tie's allocation
  // pointer is cleared — it referenced a loser-gift allocation, and the
  // caller re-homes allocations separately.
  const loserUnitIds = tiedUnits
    .filter((r) => loserSet.has(r.giftId))
    .map((r) => r.id);
  if (loserUnitIds.length > 0) {
    await tx
      .update(paymentUnits)
      .set({ giftId: survivorId, giftAllocationId: null, updatedAt: now })
      .where(inArray(paymentUnits.id, loserUnitIds));
  }

  // ── 4. QuickBooks link state ──────────────────────────────────────────────
  // Nothing to normalize: the counted tie consolidation in §3 IS the QB link
  // state now (the legacy staged gift-link columns are @deprecated and never
  // written). Several payments counted against one survivor is a perfectly
  // representable tie shape — no group re-stamping is needed.

  // ── 5. (retired) Stripe / Donorbox pointer re-point ──────────────────────
  // The legacy matched/created gift pointer columns are retired (never read or
  // written); the §3 counted-tie consolidation above already re-homed every
  // Stripe / Donorbox application onto the survivor.

  // ── 6. Re-home corroborating claims (unit_gift_corroboration) ────────────
  // Re-point each loser's claim to the survivor — the deterministic id
  // encodes the (unit, gift) pair, so a re-home is delete + insert under the
  // survivor's id, skipped when the survivor already corroborates that unit
  // (the per-pair UNIQUE would otherwise 23505). Audit-only, so this never
  // sums and never blocks the merge (the §2 collision detector reads the
  // counted ties only).
  const survivorCorrUnits = new Set(
    corrLinks.filter((r) => r.giftId === survivorId).map((r) => r.paymentUnitId),
  );
  for (const r of corrLinks) {
    if (!loserSet.has(r.giftId)) continue;
    await tx.delete(sourceLinks).where(eq(sourceLinks.id, r.id));
    if (survivorCorrUnits.has(r.paymentUnitId)) continue;
    await tx
      .insert(sourceLinks)
      .values({
        id: sourceLinkId(
          "unit_gift_corroboration",
          `${r.paymentUnitId}_${survivorId}`,
        ),
        linkType: "unit_gift_corroboration",
        paymentUnitId: r.paymentUnitId,
        giftId: survivorId,
        lifecycle: r.lifecycle,
        provenance: r.provenance,
        matchBasis: r.matchBasis,
        confirmedByUserId: r.confirmedByUserId,
        confirmedAt: r.confirmedAt,
        note: r.note,
        updatedAt: now,
      })
      .onConflictDoNothing();
    survivorCorrUnits.add(r.paymentUnitId);
  }

  // ── 7. (retired) Loser QB final-amount pointer clearing ──────────────────
  // The legacy gifts_and_payments.final_amount_qb_staged_payment_id pointer is
  // @deprecated and no longer written or read — stamp provenance is derived
  // from the counted QB ties, whose units §3 just moved to the survivor.

  return { collision: null };
}
