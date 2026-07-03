// Ledger-aware gift COMBINE: absorb one or more "loser" gifts' reconciled
// payment evidence onto a surviving gift so the two-plane redesign's cash
// ledger (payment_applications) and the legacy pointer surfaces stay parity-
// consistent after a merge.
//
// Historically the merge route hard-BLOCKED (409) whenever a loser carried ANY
// QuickBooks / Stripe / Donorbox link. That is too blunt now that everything is
// dual-written into the ledger: a mundane "two duplicate gifts, one has a QB
// match" merge should just re-home that evidence onto the survivor. This helper
// does exactly that, and 409s ONLY on the handful of link shapes the legacy
// pointer columns genuinely cannot represent on a single gift:
//   - split_link       — a loser wired into a staged-payment SPLIT, or a
//                         survivor split that would have to coexist with
//                         absorbed group/direct QB evidence (split precedence
//                         reads a single sub-amount, so it can't sum a group).
//   - stripe_charge    — two+ distinct Stripe charges would have to point at the
//                         one survivor (matched/created are single-valued).
//   - donorbox_donation — same, for Donorbox donations.
//
// Everything it writes lives inside the caller's transaction; on a collision it
// writes NOTHING and returns the collision so the route can 409 with a clean,
// no-op rollback.
import type { db } from "@workspace/db";
import {
  giftsAndPayments,
  stagedPayments,
  stagedPaymentSplits,
  stripeStagedCharges,
  donorboxDonations,
  giftEvidenceLinks,
  paymentApplications,
} from "@workspace/db/schema";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CombineCollision =
  | { kind: "split_link" }
  | { kind: "stripe_charge" }
  | { kind: "donorbox_donation" };

export interface AbsorbEvidenceResult {
  collision: CombineCollision | null;
}

const num = (v: string | number | null | undefined): number => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};

/**
 * Absorb every loser gift's reconciled payment evidence onto `survivorId`,
 * inside the caller's transaction. Detects the unrepresentable link collisions
 * FIRST (before any write); on collision returns `{ collision }` having written
 * nothing so the caller can 409 and let the transaction roll back cleanly.
 *
 * On success the ledger, the QuickBooks staged pointers, the Stripe/Donorbox
 * pointers, and the corroborating gift_evidence_links are all re-homed onto the
 * survivor, and each loser's dangling QB final-amount stamp is cleared. The
 * caller is still responsible for moving allocations, summing the survivor
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
  const refsLoser = (...ids: Array<string | null>): boolean =>
    ids.some((id) => id != null && loserSet.has(id));
  const refsSurvivor = (...ids: Array<string | null>): boolean =>
    ids.some((id) => id === survivorId);

  // ── 1. Read every evidence surface for the whole merged set ──────────────
  const splitRows = await tx
    .select({ giftId: stagedPaymentSplits.giftId })
    .from(stagedPaymentSplits)
    .where(inArray(stagedPaymentSplits.giftId, allIds));

  const qbStaged = await tx
    .select({
      id: stagedPayments.id,
      matchedGiftId: stagedPayments.matchedGiftId,
      createdGiftId: stagedPayments.createdGiftId,
      groupReconciledGiftId: stagedPayments.groupReconciledGiftId,
    })
    .from(stagedPayments)
    .where(
      or(
        inArray(stagedPayments.matchedGiftId, allIds),
        inArray(stagedPayments.createdGiftId, allIds),
        inArray(stagedPayments.groupReconciledGiftId, allIds),
      ),
    );

  const stripeCharges = await tx
    .select({
      id: stripeStagedCharges.id,
      matchedGiftId: stripeStagedCharges.matchedGiftId,
      createdGiftId: stripeStagedCharges.createdGiftId,
    })
    .from(stripeStagedCharges)
    .where(
      or(
        inArray(stripeStagedCharges.matchedGiftId, allIds),
        inArray(stripeStagedCharges.createdGiftId, allIds),
      ),
    );

  const donorboxRows = await tx
    .select({
      id: donorboxDonations.id,
      matchedGiftId: donorboxDonations.matchedGiftId,
      createdGiftId: donorboxDonations.createdGiftId,
    })
    .from(donorboxDonations)
    .where(
      or(
        inArray(donorboxDonations.matchedGiftId, allIds),
        inArray(donorboxDonations.createdGiftId, allIds),
      ),
    );

  // Only COUNTED cash-application rows consolidate; corroborating rows (Phase 5)
  // never sum and are left untouched here.
  const ledgerRows = await tx
    .select({
      id: paymentApplications.id,
      giftId: paymentApplications.giftId,
      paymentId: paymentApplications.paymentId,
      stripeChargeId: paymentApplications.stripeChargeId,
      donorboxDonationId: paymentApplications.donorboxDonationId,
      evidenceSource: paymentApplications.evidenceSource,
      amountApplied: paymentApplications.amountApplied,
      giftAllocationId: paymentApplications.giftAllocationId,
      note: paymentApplications.note,
      createdTheGift: paymentApplications.createdTheGift,
    })
    .from(paymentApplications)
    .where(
      and(
        inArray(paymentApplications.giftId, allIds),
        eq(paymentApplications.linkRole, "counted"),
      ),
    );

  const evLinks = await tx
    .select({
      id: giftEvidenceLinks.id,
      giftId: giftEvidenceLinks.giftId,
      evidenceKind: giftEvidenceLinks.evidenceKind,
      evidenceId: giftEvidenceLinks.evidenceId,
    })
    .from(giftEvidenceLinks)
    .where(inArray(giftEvidenceLinks.giftId, allIds));

  // Corroborating ledger rows (the Phase-5 fold of gift_evidence_links). Kept
  // separate from the counted ledger above (which drives the money trail) — these
  // are audit-only and never enter a SUM, so they re-home by simple dedupe.
  const corrLedger = await tx
    .select({
      id: paymentApplications.id,
      giftId: paymentApplications.giftId,
      evidenceSource: paymentApplications.evidenceSource,
      paymentId: paymentApplications.paymentId,
      stripeChargeId: paymentApplications.stripeChargeId,
    })
    .from(paymentApplications)
    .where(
      and(
        inArray(paymentApplications.giftId, allIds),
        eq(paymentApplications.linkRole, "corroborating"),
      ),
    );

  // ── 2. Collision detection (no writes past this point until it passes) ───
  const loserSplit = splitRows.some((r) => loserSet.has(r.giftId));
  const survivorSplit = splitRows.some((r) => r.giftId === survivorId);
  const loserQbEvidence =
    qbStaged.some((r) =>
      refsLoser(r.matchedGiftId, r.createdGiftId, r.groupReconciledGiftId),
    ) ||
    stripeCharges.some((r) => refsLoser(r.matchedGiftId, r.createdGiftId)) ||
    donorboxRows.some((r) => refsLoser(r.matchedGiftId, r.createdGiftId)) ||
    ledgerRows.some((r) => loserSet.has(r.giftId));
  // A loser split can't be re-homed (a split sub-amount is single-valued, no
  // group shape); a survivor split can't coexist with absorbed group/direct QB
  // evidence (split precedence would mask the summed group). Either way: 409.
  if (loserSplit || (survivorSplit && loserQbEvidence)) {
    return { collision: { kind: "split_link" } };
  }

  // At most ONE Stripe charge / Donorbox donation can point at the survivor
  // (matched & created are single-valued). Absorbing a loser's charge is only
  // possible when doing so leaves the survivor with a single charge total.
  const loserStripe = stripeCharges.filter((r) =>
    refsLoser(r.matchedGiftId, r.createdGiftId),
  );
  const survivorStripe = stripeCharges.filter((r) =>
    refsSurvivor(r.matchedGiftId, r.createdGiftId),
  );
  if (loserStripe.length >= 1 && loserStripe.length + survivorStripe.length >= 2) {
    return { collision: { kind: "stripe_charge" } };
  }
  const loserDonorbox = donorboxRows.filter((r) =>
    refsLoser(r.matchedGiftId, r.createdGiftId),
  );
  const survivorDonorbox = donorboxRows.filter((r) =>
    refsSurvivor(r.matchedGiftId, r.createdGiftId),
  );
  if (
    loserDonorbox.length >= 1 &&
    loserDonorbox.length + survivorDonorbox.length >= 2
  ) {
    return { collision: { kind: "donorbox_donation" } };
  }

  const now = new Date();

  // ── 3. Consolidate the cash-application ledger onto the survivor ──────────
  // Group counted rows by their anchor (a QB payment / Stripe charge / Donorbox
  // donation). The SAME anchor can only span multiple merged gifts for QB
  // partial applications; Stripe/Donorbox anchors settle a single gift, so their
  // groups have size 1 and simply re-point. NEVER sum across anchors.
  const groups = new Map<string, typeof ledgerRows>();
  for (const r of ledgerRows) {
    const anchor =
      r.evidenceSource === "quickbooks"
        ? `qb:${r.paymentId}`
        : r.evidenceSource === "stripe"
          ? `st:${r.stripeChargeId}`
          : `db:${r.donorboxDonationId}`;
    const list = groups.get(anchor);
    if (list) list.push(r);
    else groups.set(anchor, [r]);
  }
  for (const rows of groups.values()) {
    if (rows.length === 1) {
      const row = rows[0]!;
      if (row.giftId !== survivorId) {
        await tx
          .update(paymentApplications)
          .set({ giftId: survivorId, updatedAt: now })
          .where(eq(paymentApplications.id, row.id));
      }
      continue;
    }
    // Keeper = the survivor's own row if present, else the lowest id for
    // determinism. Delete the rest FIRST so re-pointing the keeper onto the
    // survivor can't transiently collide with the per-anchor UNIQUE.
    const keeper =
      rows.find((r) => r.giftId === survivorId) ??
      [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))[0]!;
    const others = rows.filter((r) => r.id !== keeper.id);
    await tx.delete(paymentApplications).where(
      inArray(
        paymentApplications.id,
        others.map((r) => r.id),
      ),
    );
    const summed = rows.reduce((acc, r) => acc + num(r.amountApplied), 0);
    await tx
      .update(paymentApplications)
      .set({
        giftId: survivorId,
        amountApplied: summed.toFixed(2),
        createdTheGift: rows.some((r) => r.createdTheGift),
        giftAllocationId:
          keeper.giftAllocationId ??
          rows.find((r) => r.giftAllocationId != null)?.giftAllocationId ??
          null,
        note: keeper.note ?? rows.find((r) => r.note != null)?.note ?? null,
        updatedAt: now,
      })
      .where(eq(paymentApplications.id, keeper.id));
  }

  // ── 4. Normalize the QuickBooks staged pointers onto the survivor ────────
  if (qbStaged.length === 1) {
    // A single QB payment stays a clean DIRECT match (clears any created flag so
    // a later revert links, never deletes, the survivor).
    const row = qbStaged[0]!;
    await tx
      .update(stagedPayments)
      .set({
        matchedGiftId: survivorId,
        createdGiftId: null,
        groupReconciledGiftId: null,
        updatedAt: now,
      })
      .where(eq(stagedPayments.id, row.id));
  } else if (qbStaged.length >= 2) {
    // Multiple QB payments must become a GROUP (the only legacy shape that sums
    // several payments onto one gift). Clear all matched/created first so the
    // partial-unique on matched_gift_id is free, then re-stamp one
    // representative as the group's matched row.
    const ids = qbStaged.map((r) => r.id);
    await tx
      .update(stagedPayments)
      .set({
        groupReconciledGiftId: survivorId,
        matchedGiftId: null,
        createdGiftId: null,
        updatedAt: now,
      })
      .where(inArray(stagedPayments.id, ids));
    const representative =
      qbStaged.find((r) => r.matchedGiftId === survivorId) ?? qbStaged[0]!;
    await tx
      .update(stagedPayments)
      .set({ matchedGiftId: survivorId, updatedAt: now })
      .where(eq(stagedPayments.id, representative.id));
  }

  // ── 5. Re-point the single absorbed Stripe / Donorbox pointer ────────────
  for (const r of loserStripe) {
    await tx
      .update(stripeStagedCharges)
      .set({
        matchedGiftId: loserSet.has(r.matchedGiftId ?? "")
          ? survivorId
          : r.matchedGiftId,
        createdGiftId: loserSet.has(r.createdGiftId ?? "")
          ? survivorId
          : r.createdGiftId,
        updatedAt: now,
      })
      .where(eq(stripeStagedCharges.id, r.id));
  }
  for (const r of loserDonorbox) {
    await tx
      .update(donorboxDonations)
      .set({
        matchedGiftId: loserSet.has(r.matchedGiftId ?? "")
          ? survivorId
          : r.matchedGiftId,
        createdGiftId: loserSet.has(r.createdGiftId ?? "")
          ? survivorId
          : r.createdGiftId,
        updatedAt: now,
      })
      .where(eq(donorboxDonations.id, r.id));
  }

  // ── 6. Re-home corroborating gift_evidence_links (dedupe on the UNIQUE) ──
  const survivorEvKeys = new Set(
    evLinks
      .filter((l) => l.giftId === survivorId)
      .map((l) => `${l.evidenceKind}:${l.evidenceId}`),
  );
  for (const l of evLinks) {
    if (!loserSet.has(l.giftId)) continue;
    const key = `${l.evidenceKind}:${l.evidenceId}`;
    if (survivorEvKeys.has(key)) {
      await tx.delete(giftEvidenceLinks).where(eq(giftEvidenceLinks.id, l.id));
    } else {
      await tx
        .update(giftEvidenceLinks)
        .set({ giftId: survivorId })
        .where(eq(giftEvidenceLinks.id, l.id));
      survivorEvKeys.add(key);
    }
  }

  // ── 6b. Re-home corroborating payment_applications (Phase-5 fold of gel) ──
  // Mirrors §6 on the ledger: re-point each loser's corroborating row to the
  // survivor, or delete it when the survivor already corroborates that anchor
  // (the corroborating per-anchor UNIQUE would otherwise 23505). Audit-only, so
  // this never sums and never blocks the merge (the §2 collision detector reads
  // the counted ledger only). Keyed on the anchor, independent of gel ids, so it
  // stays correct after the read-flip stops writing gel.
  const corrAnchorKey = (r: (typeof corrLedger)[number]): string =>
    r.evidenceSource === "quickbooks"
      ? `qb:${r.paymentId}`
      : `st:${r.stripeChargeId}`;
  const survivorCorrKeys = new Set(
    corrLedger
      .filter((r) => r.giftId === survivorId)
      .map((r) => corrAnchorKey(r)),
  );
  for (const r of corrLedger) {
    if (!loserSet.has(r.giftId)) continue;
    const key = corrAnchorKey(r);
    if (survivorCorrKeys.has(key)) {
      await tx
        .delete(paymentApplications)
        .where(eq(paymentApplications.id, r.id));
    } else {
      await tx
        .update(paymentApplications)
        .set({ giftId: survivorId, updatedAt: now })
        .where(eq(paymentApplications.id, r.id));
      survivorCorrKeys.add(key);
    }
  }

  // ── 7. Clear each loser's dangling QB final-amount stamp ─────────────────
  // The parity gate flags a gift that still carries final_amount_qb_staged_
  // payment_id but has no QB ledger row (its rows just moved to the survivor).
  await tx
    .update(giftsAndPayments)
    .set({ finalAmountQbStagedPaymentId: null, updatedAt: now })
    .where(
      and(
        inArray(giftsAndPayments.id, loserIds),
        isNotNull(giftsAndPayments.finalAmountQbStagedPaymentId),
      ),
    );

  return { collision: null };
}
