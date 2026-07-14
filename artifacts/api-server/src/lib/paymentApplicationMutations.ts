import type { db } from "@workspace/db";
import {
  applyPaymentApplication,
  bookStripeChargeApplication,
  confirmPaymentApplicationsForPayment,
  removePaymentApplicationsForPayment,
  removePaymentApplicationsForStripeCharge,
  type ApplyPaymentApplicationArgs,
  type PaymentApplicationLifecycle,
  type PaymentApplicationMatchMethod,
} from "./paymentApplications";
import { refreshSettlementSupersessionForApplicationChanges } from "./paymentApplicationSettlementRefresh";

// Transaction-local mutation wrappers. They deliberately do not call
// applyGiftQbTieMany because that applier uses the global db and is designed to
// run after the surrounding transaction commits. Each wrapper returns the full
// affected gift set for the caller to recompute after commit.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface PaymentApplicationMutationResult {
  affectedGiftIds: string[];
}

const unique = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.filter((value): value is string => !!value))];

export async function applyQuickBooksApplicationAndRefresh(
  tx: Tx,
  args: ApplyPaymentApplicationArgs & {
    evidenceSource: "quickbooks";
    paymentId: string;
  },
): Promise<PaymentApplicationMutationResult> {
  await applyPaymentApplication(tx, args);
  const refresh = await refreshSettlementSupersessionForApplicationChanges(tx, [
    { evidenceSource: "quickbooks", paymentId: args.paymentId },
  ]);
  return {
    affectedGiftIds: unique([args.giftId, ...refresh.affectedGiftIds]),
  };
}

export async function confirmQuickBooksApplicationsAndRefresh(
  tx: Tx,
  paymentId: string,
  confirmedByUserId: string | null,
  confirmedAt: Date,
): Promise<PaymentApplicationMutationResult> {
  const confirmedGiftIds = await confirmPaymentApplicationsForPayment(
    tx,
    paymentId,
    confirmedByUserId,
    confirmedAt,
  );
  const refresh = await refreshSettlementSupersessionForApplicationChanges(tx, [
    { evidenceSource: "quickbooks", paymentId },
  ]);
  return {
    affectedGiftIds: unique([
      ...confirmedGiftIds,
      ...refresh.affectedGiftIds,
    ]),
  };
}

export async function removeQuickBooksApplicationsAndRefresh(
  tx: Tx,
  paymentId: string,
): Promise<PaymentApplicationMutationResult> {
  const removedGiftIds = await removePaymentApplicationsForPayment(tx, paymentId);
  const refresh = await refreshSettlementSupersessionForApplicationChanges(tx, [
    { evidenceSource: "quickbooks", paymentId },
  ]);
  return {
    affectedGiftIds: unique([...removedGiftIds, ...refresh.affectedGiftIds]),
  };
}

export async function bookStripeChargeApplicationAndRefresh(
  tx: Tx,
  args: {
    stripeChargeId: string;
    grossAmount: string | null;
    giftId: string;
    matchMethod: PaymentApplicationMatchMethod;
    lifecycle?: PaymentApplicationLifecycle;
    confirmedByUserId?: string | null;
    confirmedAt?: Date | null;
    createdTheGift: boolean;
  },
): Promise<PaymentApplicationMutationResult> {
  await bookStripeChargeApplication(tx, args);
  const refresh = await refreshSettlementSupersessionForApplicationChanges(tx, [
    { evidenceSource: "stripe", stripeChargeId: args.stripeChargeId },
  ]);
  return {
    affectedGiftIds: unique([args.giftId, ...refresh.affectedGiftIds]),
  };
}

export async function removeStripeChargeApplicationsAndRefresh(
  tx: Tx,
  stripeChargeId: string,
): Promise<PaymentApplicationMutationResult> {
  const removedGiftIds = await removePaymentApplicationsForStripeCharge(
    tx,
    stripeChargeId,
  );
  const refresh = await refreshSettlementSupersessionForApplicationChanges(tx, [
    { evidenceSource: "stripe", stripeChargeId },
  ]);
  return {
    affectedGiftIds: unique([...removedGiftIds, ...refresh.affectedGiftIds]),
  };
}
