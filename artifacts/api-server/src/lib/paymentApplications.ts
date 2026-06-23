// `db` is used ONLY to derive the transaction type — keep it type-only so
// importing this helper (into the merge / revert routes) carries no runtime DB
// coupling. Every function takes the caller's `tx`; nothing here touches the
// `db` singleton at runtime.
import type { db } from "@workspace/db";
import { paymentApplications, stagedPayments } from "@workspace/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { newId } from "./helpers";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PaymentApplicationEvidenceSource =
  | "quickbooks"
  | "stripe"
  | "donorbox";
export type PaymentApplicationMatchMethod =
  | "system"
  | "system_confirmed"
  | "human";

/** Default headroom above a payment's amount: just enough to absorb float
 * noise. Split callers (gross per-gift sub-amounts sum slightly above the net
 * deposit) pass a wider fee-band tolerance explicitly. */
const BOOK_ONCE_EPSILON = 0.005;

export interface BookOnceCheckArgs {
  /** The anchoring payment's own amount (the cap) as a numeric string. */
  paymentAmount: string | null;
  /** SUM(amount_applied) already booked against this payment for OTHER gifts. */
  otherAppliedSum: string | number | null;
  /** The amount about to be applied to THIS gift. */
  newAmount: string | number | null;
  /**
   * Absolute dollar headroom above the payment amount. A processor payout's
   * GROSS per-gift sub-amounts can sum slightly above the NET deposit, so split
   * callers pass a fee-band tolerance; the default only absorbs float noise.
   */
  tolerance?: number;
}

export interface BookOnceResult {
  ok: boolean;
  /** Total that would be booked against the payment (other + new). */
  total: number;
  /** Allowed cap (paymentAmount + tolerance); null when the amount is unknown. */
  cap: number | null;
  /** Amount over the cap (0 when ok or cap unknown). */
  overage: number;
}

const toNum = (v: string | number | null | undefined): number => {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};

/**
 * PURE book-once guard: a single QB payment may never be applied to gifts for
 * more than the payment is worth (plus a caller-supplied fee-band tolerance).
 * DB-free, so it is exhaustively unit-testable; `applyPaymentApplication` wraps
 * it with the tx row lock + live SUM read.
 *
 * An unknown payment amount can't prove an over-application, so it passes
 * (mirrors the giftQbTie "can't prove a mismatch ⇒ tied" stance).
 */
export function checkBookOnce(args: BookOnceCheckArgs): BookOnceResult {
  const tolerance = args.tolerance ?? BOOK_ONCE_EPSILON;
  const total = toNum(args.otherAppliedSum) + toNum(args.newAmount);
  if (args.paymentAmount == null || args.paymentAmount === "") {
    return { ok: true, total, cap: null, overage: 0 };
  }
  const base = Number(args.paymentAmount);
  if (Number.isNaN(base)) return { ok: true, total, cap: null, overage: 0 };
  const cap = base + tolerance;
  const overage = total - cap;
  return { ok: overage <= 0, total, cap, overage: overage > 0 ? overage : 0 };
}

/** Thrown by applyPaymentApplication when the live SUM would over-apply a
 * payment beyond its value + tolerance. */
export class PaymentOverApplicationError extends Error {
  constructor(
    public readonly paymentId: string,
    public readonly result: BookOnceResult,
  ) {
    super(
      `payment ${paymentId} over-applied: total ${result.total.toFixed(
        2,
      )} exceeds cap ${result.cap?.toFixed(2) ?? "unknown"}`,
    );
    this.name = "PaymentOverApplicationError";
  }
}

export interface ApplyPaymentApplicationArgs {
  paymentId: string;
  giftId: string;
  /** Numeric string ( > 0 ). */
  amountApplied: string;
  evidenceSource: PaymentApplicationEvidenceSource;
  stripeChargeId?: string | null;
  donorboxDonationId?: string | null;
  matchMethod?: PaymentApplicationMatchMethod;
  confirmedByUserId?: string | null;
  confirmedAt?: Date | null;
  note?: string | null;
  createdTheGift?: boolean;
  /** Fee-band headroom for gross-vs-net splits; defaults to float epsilon. */
  tolerance?: number;
}

/**
 * Idempotently book a QB cash-application ledger row (one per payment↔gift
 * pair). Caller MUST hold an open transaction.
 *
 *  1. Locks the anchoring staged_payment row FOR UPDATE so concurrent
 *     applications of the same payment serialize.
 *  2. Reads the live SUM(amount_applied) already booked to OTHER gifts.
 *  3. Runs the pure book-once guard; throws PaymentOverApplicationError on
 *     over-application.
 *  4. Upserts the (payment_id, gift_id) row (the UNIQUE pair is the book-once
 *     key — re-runs replace the amount instead of duplicating).
 *
 * Zero callers in Phase 1 (additive rollout); the dual-write phase wires this
 * into every QB reconciliation write path.
 */
export async function applyPaymentApplication(
  tx: Tx,
  args: ApplyPaymentApplicationArgs,
): Promise<void> {
  // 1. Lock the anchor payment (serializes concurrent applications of it).
  const paymentRow = await tx
    .select({ amount: stagedPayments.amount })
    .from(stagedPayments)
    .where(eq(stagedPayments.id, args.paymentId))
    .for("update")
    .then((r) => r[0]);
  if (!paymentRow) {
    throw new Error(
      `applyPaymentApplication: staged payment ${args.paymentId} not found`,
    );
  }

  // 2. Live SUM already booked to OTHER gifts for this payment.
  const sumRows = await tx
    .select({
      sum: sql<string>`coalesce(sum(${paymentApplications.amountApplied}), 0)`,
    })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.paymentId, args.paymentId),
        ne(paymentApplications.giftId, args.giftId),
      ),
    );
  const otherSum = sumRows[0]?.sum ?? "0";

  // 3. Pure book-once guard.
  const result = checkBookOnce({
    paymentAmount: paymentRow.amount,
    otherAppliedSum: otherSum,
    newAmount: args.amountApplied,
    tolerance: args.tolerance,
  });
  if (!result.ok) throw new PaymentOverApplicationError(args.paymentId, result);

  // 4. Idempotent upsert (the UNIQUE pair is the book-once key).
  const now = new Date();
  const values = {
    paymentId: args.paymentId,
    giftId: args.giftId,
    amountApplied: args.amountApplied,
    evidenceSource: args.evidenceSource,
    stripeChargeId: args.stripeChargeId ?? null,
    donorboxDonationId: args.donorboxDonationId ?? null,
    matchMethod: args.matchMethod ?? ("system" as const),
    confirmedByUserId: args.confirmedByUserId ?? null,
    confirmedAt: args.confirmedAt ?? null,
    note: args.note ?? null,
    createdTheGift: args.createdTheGift ?? false,
    updatedAt: now,
  };
  await tx
    .insert(paymentApplications)
    .values({ id: newId(), ...values })
    .onConflictDoUpdate({
      target: [paymentApplications.paymentId, paymentApplications.giftId],
      set: values,
    });
}

/**
 * Remove every ledger row for a gift about to be hard-deleted (gift_id is
 * RESTRICT, so the rows must go first). Returns the affected payment ids.
 * Caller holds the transaction.
 */
export async function removePaymentApplicationsForGift(
  tx: Tx,
  giftId: string,
): Promise<string[]> {
  const removed = await tx
    .delete(paymentApplications)
    .where(eq(paymentApplications.giftId, giftId))
    .returning({ paymentId: paymentApplications.paymentId });
  return removed.map((r) => r.paymentId);
}

/**
 * Remove every ledger row anchored to a staged payment being reverted to
 * pending. Returns the affected gift ids (recompute their tie). Caller holds
 * the transaction.
 */
export async function removePaymentApplicationsForPayment(
  tx: Tx,
  paymentId: string,
): Promise<string[]> {
  const removed = await tx
    .delete(paymentApplications)
    .where(eq(paymentApplications.paymentId, paymentId))
    .returning({ giftId: paymentApplications.giftId });
  return removed.map((r) => r.giftId);
}

/**
 * Human confirmation of an auto-applied (`system`) match: promote every
 * `system` ledger row anchored to this payment to `system_confirmed` and stamp
 * who/when. No amount or link change, so no book-once re-check is needed. Rows
 * already `human` or `system_confirmed` are deliberately left untouched (a
 * confirm only graduates auto-applied rows). A payment with no `system` rows —
 * e.g. confirming a pending donor match that never minted a gift — is a clean
 * no-op. Returns the affected gift ids (recompute their tie). Caller holds the
 * transaction.
 */
export async function confirmPaymentApplicationsForPayment(
  tx: Tx,
  paymentId: string,
  confirmedByUserId: string | null,
  confirmedAt: Date,
): Promise<string[]> {
  const updated = await tx
    .update(paymentApplications)
    .set({
      matchMethod: "system_confirmed",
      confirmedByUserId: confirmedByUserId ?? null,
      confirmedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentApplications.paymentId, paymentId),
        eq(paymentApplications.matchMethod, "system"),
      ),
    )
    .returning({ giftId: paymentApplications.giftId });
  return updated.map((r) => r.giftId);
}
