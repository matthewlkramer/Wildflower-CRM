import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { rollupPayout } from "../lib/stripeSync";

/**
 * Shapes below mirror the five real payouts whose stored net_total disagreed
 * with the bank amount ONLY because the old rollup ignored adjustment-type
 * balance transactions (fee-refund `adjustment`s, `payment_failure_refund`
 * reversals, `payout_failure` recoveries). The invariant under test: netTotal
 * equals Σ bt.net over every non-payout transaction — i.e. exactly what
 * arrived at the bank when Stripe's books balance.
 */

function bt(
  type: string,
  amountMinor: number,
  feeMinor: number,
): Stripe.BalanceTransaction {
  return {
    type,
    amount: amountMinor,
    fee: feeMinor,
    net: amountMinor - feeMinor,
  } as unknown as Stripe.BalanceTransaction;
}

/** The payout's own bank-transfer txn (skipped by the rollup). */
function payoutBt(payoutAmountMinor: number): Stripe.BalanceTransaction {
  return bt("payout", -payoutAmountMinor, 0);
}

function ledgerNetMinor(bts: Stripe.BalanceTransaction[]): number {
  return bts
    .filter((t) => t.type !== "payout")
    .reduce((sum, t) => sum + t.net, 0);
}

describe("rollupPayout", () => {
  it("plain charges: gross − fees = net, no adjustment", () => {
    const bts = [
      bt("charge", 10000, 320),
      bt("payment", 25000, 780),
      payoutBt(33900),
    ];
    const r = rollupPayout(bts);
    expect(r.grossTotal).toBe("350.00");
    expect(r.feeTotal).toBe("11.00");
    expect(r.refundTotal).toBe("0.00");
    expect(r.adjustmentTotal).toBe("0.00");
    expect(r.netTotal).toBe("339.00");
    expect(r.chargeCount).toBe(2);
    expect(Number(r.netTotal) * 100).toBeCloseTo(ledgerNetMinor(bts), 5);
  });

  it("refunds subtract, and refund fees count as fees", () => {
    const bts = [
      bt("charge", 50000, 1500),
      bt("refund", -10000, 30),
      payoutBt(38470),
    ];
    const r = rollupPayout(bts);
    expect(r.refundTotal).toBe("100.00");
    expect(r.feeTotal).toBe("15.30");
    expect(r.netTotal).toBe("384.70");
    expect(Number(r.netTotal) * 100).toBeCloseTo(ledgerNetMinor(bts), 5);
  });

  it("failed-payment reversal + fee-refund adjustment (the +504.10 phantom gap)", () => {
    // Real shape: charges netted X, then a payment_failure_refund pulled
    // −512.98 back out and an adjustment returned +8.98 of its fees; the old
    // rollup reported net 504.10 ABOVE what the bank received.
    const bts = [
      bt("payment", 100000, 2500),
      bt("payment_failure_refund", -51298, 0),
      bt("adjustment", 898, 0),
      payoutBt(47100),
    ];
    const r = rollupPayout(bts);
    expect(r.grossTotal).toBe("1000.00");
    expect(r.feeTotal).toBe("25.00");
    expect(r.adjustmentTotal).toBe("-504.00");
    expect(r.netTotal).toBe("471.00");
    expect(Number(r.netTotal) * 100).toBeCloseTo(ledgerNetMinor(bts), 5);
  });

  it("negative fee-refund adjustment (the −18.23 phantom gap)", () => {
    // A fee-refund style adjustment withdrawn from the balance: the bank got
    // LESS than gross − fees, and the old rollup flagged a phantom gap.
    const bts = [
      bt("charge", 120000, 3600),
      bt("adjustment", -1823, 0),
      payoutBt(114577),
    ];
    const r = rollupPayout(bts);
    expect(r.adjustmentTotal).toBe("-18.23");
    expect(r.netTotal).toBe("1145.77");
    expect(Number(r.netTotal) * 100).toBeCloseTo(ledgerNetMinor(bts), 5);
  });

  it("payout_failure recovery lands as a positive adjustment (the +256.00 case)", () => {
    // A prior payout failed at the bank; Stripe returns the funds via a
    // payout_failure txn that settles inside a LATER payout.
    const bts = [
      bt("charge", 30000, 900),
      bt("payout_failure", 25600, 0),
      payoutBt(54700),
    ];
    const r = rollupPayout(bts);
    expect(r.adjustmentTotal).toBe("256.00");
    expect(r.netTotal).toBe("547.00");
    expect(Number(r.netTotal) * 100).toBeCloseTo(ledgerNetMinor(bts), 5);
  });

  it("adjustment-only payout (no charges at all)", () => {
    const bts = [bt("adjustment", -311, 0), payoutBt(-311)];
    const r = rollupPayout(bts);
    expect(r.grossTotal).toBe("0.00");
    expect(r.chargeCount).toBe(0);
    expect(r.adjustmentTotal).toBe("-3.11");
    expect(r.netTotal).toBe("-3.11");
    expect(Number(r.netTotal) * 100).toBeCloseTo(ledgerNetMinor(bts), 5);
  });

  it("an adjustment's own fee is folded into net, never double-counted", () => {
    const bts = [bt("charge", 10000, 300), bt("adjustment", 500, 100)];
    const r = rollupPayout(bts);
    // adjustment net = 500 − 100 = 400; fees bucket holds only the charge fee.
    expect(r.feeTotal).toBe("3.00");
    expect(r.adjustmentTotal).toBe("4.00");
    expect(r.netTotal).toBe("101.00");
    expect(Number(r.netTotal) * 100).toBeCloseTo(ledgerNetMinor(bts), 5);
  });

  it("empty transaction list yields zeros", () => {
    const r = rollupPayout([]);
    expect(r.grossTotal).toBe("0.00");
    expect(r.feeTotal).toBe("0.00");
    expect(r.refundTotal).toBe("0.00");
    expect(r.adjustmentTotal).toBe("0.00");
    expect(r.netTotal).toBe("0.00");
    expect(r.chargeCount).toBe(0);
  });
});
