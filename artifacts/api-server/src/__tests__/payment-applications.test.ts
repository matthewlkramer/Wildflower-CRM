import { describe, it, expect } from "vitest";
import { checkBookOnce } from "../lib/paymentApplications";

// The pure book-once guard is the single source of truth for "a QB payment is
// never applied to gifts for more than it is worth". It is DB-free, so it is
// exhaustively unit-testable here; the DB wrapper (applyPaymentApplication)
// only adds the row lock + live SUM read around it.

describe("checkBookOnce", () => {
  it("passes when the new amount fits under the payment cap", () => {
    const r = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "0",
      newAmount: "60.00",
    });
    expect(r.ok).toBe(true);
    expect(r.overage).toBe(0);
    expect(r.total).toBeCloseTo(60);
  });

  it("passes when other applications + new exactly equal the cap", () => {
    const r = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "40.00",
      newAmount: "60.00",
    });
    expect(r.ok).toBe(true);
    expect(r.total).toBeCloseTo(100);
    expect(r.overage).toBe(0);
  });

  it("fails when the running total exceeds the payment cap", () => {
    const r = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "80.00",
      newAmount: "60.00",
    });
    expect(r.ok).toBe(false);
    expect(r.total).toBeCloseTo(140);
    expect(r.overage).toBeGreaterThan(39);
  });

  it("absorbs a gross-over-net split with a caller-supplied fee-band tolerance", () => {
    // Net deposit 100; two gross sub-amounts sum to 103 (within the 3.50 band).
    const a = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "0",
      newAmount: "53.00",
      tolerance: 3.5,
    });
    expect(a.ok).toBe(true);
    const b = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "53.00",
      newAmount: "50.00",
      tolerance: 3.5,
    });
    expect(b.ok).toBe(true);
    expect(b.total).toBeCloseTo(103);
  });

  it("rejects a split that overruns even the fee-band tolerance", () => {
    const r = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "60.00",
      newAmount: "60.00",
      tolerance: 3.5,
    });
    expect(r.ok).toBe(false);
    expect(r.overage).toBeGreaterThan(16);
  });

  it("passes (can't prove an over-application) when the payment amount is unknown", () => {
    for (const amt of [null, ""] as const) {
      const r = checkBookOnce({
        paymentAmount: amt,
        otherAppliedSum: "999.00",
        newAmount: "999.00",
      });
      expect(r.ok).toBe(true);
      expect(r.cap).toBeNull();
      expect(r.overage).toBe(0);
    }
  });

  it("treats null/empty other-sum and numeric inputs as 0", () => {
    const r = checkBookOnce({
      paymentAmount: "50.00",
      otherAppliedSum: null,
      newAmount: 50,
    });
    expect(r.ok).toBe(true);
    expect(r.total).toBeCloseTo(50);
  });

  it("only allows float-noise headroom by default (no implicit fee band)", () => {
    const r = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "0",
      newAmount: "101.00",
    });
    expect(r.ok).toBe(false);
    expect(r.overage).toBeCloseTo(1, 2);
  });
});
