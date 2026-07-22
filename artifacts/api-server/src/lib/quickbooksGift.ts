import type { NewGiftOrPayment } from "@workspace/db/schema";

/**
 * Pure builder for the gifts_and_payments values minted from a QuickBooks
 * staged payment. Shared by the manual "create gift" route and the sync
 * worker's high-confidence auto-create so both produce identical rows.
 *
 * Mints the gift HEADER only (no gift_allocations) — same as the manual flow;
 * a fundraiser allocates afterward. The donor XOR is the caller's
 * responsibility (validate via validateGiftInvariants before inserting).
 *
 * The goal-counting signal lives ONLY on gift_allocations now, so a header-only
 * mint carries no counts-toward-goal flag; callers that also create an
 * allocation (the sync worker's auto-create) set it on the allocation row.
 */
export interface StagedGiftSource {
  qbEntityType: string;
  /** Null for SYNTHETIC split units (split_parent_id set): a unit mirrors no
   * QB entity of its own — only the provenance string differs at mint. */
  qbEntityId: string | null;
  amount: string | null;
  dateReceived: string | null;
  payerName: string | null;
  rawReference: string | null;
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
  /** Conduit the donor gave through, propagated onto the gift when present. */
  matchedPaymentIntermediaryId: string | null;
}

export function buildGiftValuesFromStaged(
  giftId: string,
  staged: StagedGiftSource,
  ownerUserId: string | null,
): NewGiftOrPayment {
  const name =
    staged.payerName ??
    staged.rawReference ??
    `QuickBooks ${staged.qbEntityType}`;
  return {
    id: giftId,
    name,
    amount: staged.amount,
    dateReceived: staged.dateReceived,
    organizationId: staged.organizationId,
    individualGiverPersonId: staged.individualGiverPersonId,
    householdId: staged.householdId,
    paymentIntermediaryId: staged.matchedPaymentIntermediaryId,
    details:
      staged.qbEntityId == null
        ? `Imported from QuickBooks (${staged.qbEntityType}, split unit).`
        : `Imported from QuickBooks (${staged.qbEntityType} #${staged.qbEntityId}).`,
    ownerUserId,
  };
}
