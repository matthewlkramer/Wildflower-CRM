import type { db } from "@workspace/db";
import { stripeStagedCharges } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import {
  applySettlementSupersedeForDeposits,
  applySettlementSupersedeForPayouts,
  type SettlementSupersedeResult,
} from "./settlementSupersede";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ApplicationAnchorChange =
  | { evidenceSource: "quickbooks"; paymentId: string }
  | { evidenceSource: "stripe"; stripeChargeId: string }
  | { evidenceSource: "donorbox"; donorboxDonationId: string };

const unique = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => !!value))];

const emptyResult = (): SettlementSupersedeResult => ({
  demotedApplicationIds: [],
  promotedApplicationIds: [],
  deletedDuplicateApplicationIds: [],
  affectedGiftIds: [],
  evaluatedDepositPaymentIds: [],
});

function mergeResults(
  left: SettlementSupersedeResult,
  right: SettlementSupersedeResult,
): SettlementSupersedeResult {
  return {
    demotedApplicationIds: unique([
      ...left.demotedApplicationIds,
      ...right.demotedApplicationIds,
    ]),
    promotedApplicationIds: unique([
      ...left.promotedApplicationIds,
      ...right.promotedApplicationIds,
    ]),
    deletedDuplicateApplicationIds: unique([
      ...left.deletedDuplicateApplicationIds,
      ...right.deletedDuplicateApplicationIds,
    ]),
    affectedGiftIds: unique([
      ...left.affectedGiftIds,
      ...right.affectedGiftIds,
    ]),
    evaluatedDepositPaymentIds: unique([
      ...left.evaluatedDepositPaymentIds,
      ...right.evaluatedDepositPaymentIds,
    ]),
  };
}

/**
 * Recompute settlement-boundary supersession after unit↔gift application
 * mutations. This is the single hook shared by link, mint, move, confirm,
 * reject, revert, refund, and merge writers.
 *
 * QuickBooks anchors can be evaluated directly as possible deposit rows.
 * Stripe anchors first resolve their immutable charge ids to payout ids, then
 * recompute the deposits currently linked to those payouts. Donorbox has no
 * payout↔deposit settlement plane, so it intentionally produces no refresh.
 *
 * Call this inside the same transaction as the application mutation. The
 * returned affectedGiftIds must be passed to applyGiftQbTieMany before commit.
 */
export async function refreshSettlementSupersessionForApplicationChanges(
  tx: Tx,
  changes: ApplicationAnchorChange[],
): Promise<SettlementSupersedeResult> {
  if (changes.length === 0) return emptyResult();

  const paymentIds = unique(
    changes.map((change) =>
      change.evidenceSource === "quickbooks" ? change.paymentId : null,
    ),
  );
  const stripeChargeIds = unique(
    changes.map((change) =>
      change.evidenceSource === "stripe" ? change.stripeChargeId : null,
    ),
  );

  const directResult =
    paymentIds.length > 0
      ? await applySettlementSupersedeForDeposits(tx, paymentIds)
      : emptyResult();

  if (stripeChargeIds.length === 0) return directResult;

  const chargeRows = await tx
    .select({ payoutId: stripeStagedCharges.stripePayoutId })
    .from(stripeStagedCharges)
    .where(inArray(stripeStagedCharges.id, stripeChargeIds));

  const payoutIds = unique(chargeRows.map((row) => row.payoutId));
  const stripeResult =
    payoutIds.length > 0
      ? await applySettlementSupersedeForPayouts(tx, payoutIds)
      : emptyResult();

  return mergeResults(directResult, stripeResult);
}
