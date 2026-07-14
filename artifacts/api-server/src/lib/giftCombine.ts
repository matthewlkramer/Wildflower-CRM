// Ledger-aware gift COMBINE: absorb one or more "loser" gifts' reconciled
// payment evidence onto a surviving gift. The cash-application ledger
// (payment_applications) is the SOLE evidence surface — the legacy
// matched/created gift pointer columns are retired (never read or written).
//
// Historically the merge route hard-BLOCKED (409) whenever a loser carried ANY
// QuickBooks / Stripe / Donorbox link. That is too blunt now that everything
// lives in the ledger: a mundane "two duplicate gifts, one has a QB match"
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
import { paymentApplications, settlementLinks } from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

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
 * On success the counted and corroborating ledger rows are re-homed onto the
 * survivor (the ledger is the sole evidence surface; the legacy pointer
 * columns are retired).
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
  // Split-shape wiring: a counted QB ledger row whose staged payment is applied
  // to MORE THAN ONE gift (a split's resolution lives entirely in the ledger —
  // the legacy staged_payments gift-link columns are @deprecated and no longer
  // written, so the split shape is COUNT(counted QB rows for the payment) > 1).
  const splitRows = await tx
    .select({ giftId: paymentApplications.giftId })
    .from(paymentApplications)
    .where(
      and(
        inArray(paymentApplications.giftId, allIds),
        eq(paymentApplications.evidenceSource, "quickbooks"),
        eq(paymentApplications.linkRole, "counted"),
        sql`(
          SELECT COUNT(*) FROM payment_applications pa2
          WHERE pa2.payment_id = ${paymentApplications.paymentId}
            AND pa2.evidence_source = 'quickbooks'
            AND pa2.link_role = 'counted'
        ) > 1`,
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
  // ALL evidence (QB / Stripe / Donorbox) is read from the counted ledger —
  // the legacy pointer columns are retired.
  const loserQbEvidence = ledgerRows.some((r) => loserSet.has(r.giftId));
  // A loser split can't be re-homed (a split sub-amount is single-valued, no
  // group shape); a survivor split can't coexist with absorbed group/direct QB
  // evidence (split precedence would mask the summed group). Either way: 409.
  if (loserSplit || (survivorSplit && loserQbEvidence)) {
    return { collision: { kind: "split_link" } };
  }

  // At most ONE Stripe charge / Donorbox donation may settle the survivor —
  // kept 1:1 by policy (the historical link shape). Absorbing a loser's charge
  // is only possible when it leaves the survivor with a single charge total.
  // Counted ledger rows are the sole link surface (one per charge/donation).
  const loserStripe = ledgerRows.filter(
    (r) => r.evidenceSource === "stripe" && loserSet.has(r.giftId),
  );
  const survivorStripe = ledgerRows.filter(
    (r) => r.evidenceSource === "stripe" && r.giftId === survivorId,
  );
  if (loserStripe.length >= 1 && loserStripe.length + survivorStripe.length >= 2) {
    return { collision: { kind: "stripe_charge" } };
  }
  const loserDonorbox = ledgerRows.filter(
    (r) => r.evidenceSource === "donorbox" && loserSet.has(r.giftId),
  );
  const survivorDonorbox = ledgerRows.filter(
    (r) => r.evidenceSource === "donorbox" && r.giftId === survivorId,
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

  // ── 4. QuickBooks link state ──────────────────────────────────────────────
  // Nothing to normalize: the counted ledger consolidation in §3 IS the QB link
  // state now (the legacy staged gift-link columns are @deprecated and never
  // written). Several payments counted against one survivor is a perfectly
  // representable ledger shape — no group re-stamping is needed.

  // ── 5. (retired) Stripe / Donorbox pointer re-point ──────────────────────
  // The legacy matched/created gift pointer columns are retired (never read or
  // written); the §3 counted-ledger consolidation above already re-homed every
  // Stripe / Donorbox application onto the survivor.

  // ── 6. Re-home corroborating payment_applications (Phase-5 fold of gel) ──
  // The corroborating ledger is now the sole home for evidence↔gift links
  // (Phase-5 read-flip: gift_evidence_links is frozen). Re-point each loser's
  // corroborating row to the survivor, or delete it when the survivor already
  // corroborates that anchor (the corroborating per-anchor UNIQUE would
  // otherwise 23505). Audit-only, so this never sums and never blocks the merge
  // (the §2 collision detector reads the counted ledger only). Keyed on the
  // anchor, independent of gel ids.
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

  // ── 7. (retired) Loser QB final-amount pointer clearing ──────────────────
  // The legacy gifts_and_payments.final_amount_qb_staged_payment_id pointer is
  // @deprecated and no longer written or read — stamp provenance is derived
  // from the counted QB ledger, whose rows §3 just moved to the survivor.

  // ── 8. Re-point the conflict-kept gift pointer ─────────────────────────────
  // A `conflict_approved` settlement KEEPS an already-approved QB deposit gift as
  // the single source of truth (`settlement_links.conflict_gift_id`). The FK is
  // ON DELETE SET NULL, but merge ARCHIVES losers (soft-delete) rather than
  // deleting them, so a pointer at a merged-away kept gift would otherwise
  // survive pointing at a tombstone — and the conflict-keep double-book guard
  // compares that pointer to the deposit's gift link. Follow it to the survivor.
  await tx
    .update(settlementLinks)
    .set({ conflictGiftId: survivorId, updatedAt: now })
    .where(inArray(settlementLinks.conflictGiftId, loserIds));

  return { collision: null };
}
