// Ledger-authoritative gift COMBINE.
//
// Absorb one or more loser gifts' payment applications onto a surviving gift.
// Stripe and Donorbox gift pointers are intentionally ignored and never rewritten:
// payment_applications is the authoritative unit-to-gift relationship.
//
// QuickBooks pointer normalization remains during its separate staged cutover.
// Everything runs inside the caller's transaction. Collision checks happen before
// writes so a rejected merge remains a clean no-op.
import type { db } from "@workspace/db";
import {
  giftsAndPayments,
  stagedPayments,
  paymentApplications,
  settlementLinks,
} from "@workspace/db/schema";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CombineCollision =
  | { kind: "split_link" }
  // Retained for API compatibility. Ledger-first merges no longer emit these:
  // a gift may be funded by multiple independent processor units.
  | { kind: "stripe_charge" }
  | { kind: "donorbox_donation" };

export interface AbsorbEvidenceResult {
  collision: CombineCollision | null;
}

const num = (value: string | number | null | undefined): number => {
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

type CountedLedgerRow = {
  id: string;
  giftId: string;
  paymentId: string | null;
  stripeChargeId: string | null;
  donorboxDonationId: string | null;
  evidenceSource: "quickbooks" | "stripe" | "donorbox";
  amountApplied: string;
  giftAllocationId: string | null;
  note: string | null;
  createdTheGift: boolean;
};

function countedAnchorKey(row: CountedLedgerRow): string {
  switch (row.evidenceSource) {
    case "quickbooks":
      return row.paymentId ? `qb:${row.paymentId}` : `invalid:${row.id}`;
    case "stripe":
      return row.stripeChargeId ? `stripe:${row.stripeChargeId}` : `invalid:${row.id}`;
    case "donorbox":
      return row.donorboxDonationId
        ? `donorbox:${row.donorboxDonationId}`
        : `invalid:${row.id}`;
  }
}

/**
 * Absorb every loser gift's payment evidence onto survivorId.
 *
 * Split QuickBooks rows remain the one blocked shape because the legacy QBO
 * pointer model cannot safely combine a split with direct/group QBO evidence.
 * Stripe and Donorbox applications do not collide merely because several
 * independent charges or donations fund the same surviving gift.
 */
export async function absorbGiftEvidenceIntoSurvivor(
  tx: Tx,
  survivorId: string,
  loserIds: string[],
): Promise<AbsorbEvidenceResult> {
  if (loserIds.length === 0) return { collision: null };

  const allIds = [survivorId, ...loserIds];
  const loserSet = new Set(loserIds);
  const now = new Date();

  // A split is represented by counted QBO applications whose staged payment has
  // none of the three legacy gift pointers.
  const splitRows = await tx
    .select({ giftId: paymentApplications.giftId })
    .from(paymentApplications)
    .innerJoin(
      stagedPayments,
      eq(stagedPayments.id, paymentApplications.paymentId),
    )
    .where(
      and(
        inArray(paymentApplications.giftId, allIds),
        eq(paymentApplications.evidenceSource, "quickbooks"),
        eq(paymentApplications.linkRole, "counted"),
        isNull(stagedPayments.matchedGiftId),
        isNull(stagedPayments.createdGiftId),
        isNull(stagedPayments.groupReconciledGiftId),
      ),
    );

  // QBO pointers remain a compatibility surface until the separate QBO cutover.
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

  const ledgerRows = (await tx
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
    )) as CountedLedgerRow[];

  const corroboratingRows = await tx
    .select({
      id: paymentApplications.id,
      giftId: paymentApplications.giftId,
      evidenceSource: paymentApplications.evidenceSource,
      paymentId: paymentApplications.paymentId,
      stripeChargeId: paymentApplications.stripeChargeId,
      donorboxDonationId: paymentApplications.donorboxDonationId,
    })
    .from(paymentApplications)
    .where(
      and(
        inArray(paymentApplications.giftId, allIds),
        eq(paymentApplications.linkRole, "corroborating"),
      ),
    );

  // A loser split cannot be re-homed. A survivor split also cannot coexist with
  // additional direct/group QBO evidence because QBO split precedence would mask
  // the combined booking. Processor evidence does not create this QBO collision.
  const loserSplit = splitRows.some((row) => loserSet.has(row.giftId));
  const survivorSplit = splitRows.some((row) => row.giftId === survivorId);
  const loserDirectQbEvidence =
    qbStaged.some(
      (row) =>
        (row.matchedGiftId != null && loserSet.has(row.matchedGiftId)) ||
        (row.createdGiftId != null && loserSet.has(row.createdGiftId)) ||
        (row.groupReconciledGiftId != null &&
          loserSet.has(row.groupReconciledGiftId)),
    ) ||
    ledgerRows.some(
      (row) =>
        row.evidenceSource === "quickbooks" && loserSet.has(row.giftId),
    );

  if (loserSplit || (survivorSplit && loserDirectQbEvidence)) {
    return { collision: { kind: "split_link" } };
  }

  // Consolidate counted applications by immutable processor/QBO unit. Multiple
  // independent Stripe charges or Donorbox donations remain separate rows and
  // can all fund the surviving gift.
  const groups = new Map<string, CountedLedgerRow[]>();
  for (const row of ledgerRows) {
    const key = countedAnchorKey(row);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
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

    // Multiple rows for one anchor are valid only for QBO partial applications.
    // Coalesce them deterministically before moving to avoid unique collisions.
    const keeper =
      rows.find((row) => row.giftId === survivorId) ??
      [...rows].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    const others = rows.filter((row) => row.id !== keeper.id);

    if (others.length > 0) {
      await tx
        .delete(paymentApplications)
        .where(
          inArray(
            paymentApplications.id,
            others.map((row) => row.id),
          ),
        );
    }

    const amountApplied = rows.reduce(
      (total, row) => total + num(row.amountApplied),
      0,
    );

    await tx
      .update(paymentApplications)
      .set({
        giftId: survivorId,
        amountApplied: amountApplied.toFixed(2),
        createdTheGift: rows.some((row) => row.createdTheGift),
        giftAllocationId:
          keeper.giftAllocationId ??
          rows.find((row) => row.giftAllocationId != null)?.giftAllocationId ??
          null,
        note:
          keeper.note ?? rows.find((row) => row.note != null)?.note ?? null,
        updatedAt: now,
      })
      .where(eq(paymentApplications.id, keeper.id));
  }

  // Preserve the temporary QBO pointer representation.
  if (qbStaged.length === 1) {
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
    const ids = qbStaged.map((row) => row.id);
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
      qbStaged.find((row) => row.matchedGiftId === survivorId) ?? qbStaged[0]!;
    await tx
      .update(stagedPayments)
      .set({ matchedGiftId: survivorId, updatedAt: now })
      .where(eq(stagedPayments.id, representative.id));
  }

  // Re-home corroborating evidence by immutable anchor, deduplicating when the
  // survivor already has the same corroborating unit.
  const corroboratingAnchorKey = (
    row: (typeof corroboratingRows)[number],
  ): string => {
    switch (row.evidenceSource) {
      case "quickbooks":
        return row.paymentId ? `qb:${row.paymentId}` : `invalid:${row.id}`;
      case "stripe":
        return row.stripeChargeId
          ? `stripe:${row.stripeChargeId}`
          : `invalid:${row.id}`;
      case "donorbox":
        return row.donorboxDonationId
          ? `donorbox:${row.donorboxDonationId}`
          : `invalid:${row.id}`;
    }
  };

  const survivorCorroboratingKeys = new Set(
    corroboratingRows
      .filter((row) => row.giftId === survivorId)
      .map(corroboratingAnchorKey),
  );

  for (const row of corroboratingRows) {
    if (!loserSet.has(row.giftId)) continue;
    const key = corroboratingAnchorKey(row);
    if (survivorCorroboratingKeys.has(key)) {
      await tx
        .delete(paymentApplications)
        .where(eq(paymentApplications.id, row.id));
    } else {
      await tx
        .update(paymentApplications)
        .set({ giftId: survivorId, updatedAt: now })
        .where(eq(paymentApplications.id, row.id));
      survivorCorroboratingKeys.add(key);
    }
  }

  // Loser gifts no longer own any QBO application after the move.
  await tx
    .update(giftsAndPayments)
    .set({ finalAmountQbStagedPaymentId: null, updatedAt: now })
    .where(
      and(
        inArray(giftsAndPayments.id, loserIds),
        isNotNull(giftsAndPayments.finalAmountQbStagedPaymentId),
      ),
    );

  // Settlement conflict references follow the surviving gift.
  await tx
    .update(settlementLinks)
    .set({ conflictGiftId: survivorId, updatedAt: now })
    .where(inArray(settlementLinks.conflictGiftId, loserIds));

  return { collision: null };
}
