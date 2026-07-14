import { describe, it, expect } from "vitest";
import {
  applicationCountsTowardMoney,
  checkBookOnce,
} from "../lib/paymentApplications";

describe("applicationCountsTowardMoney", () => {
  it("counts only confirmed counted applications", () => {
    expect(
      applicationCountsTowardMoney({
        linkRole: "counted",
        lifecycle: "confirmed",
      }),
    ).toBe(true);

    for (const lifecycle of ["proposed", "exempt"] as const) {
      expect(
        applicationCountsTowardMoney({
          linkRole: "counted",
          lifecycle,
        }),
      ).toBe(false);
    }

    for (const lifecycle of ["proposed", "confirmed", "exempt"] as const) {
      expect(
        applicationCountsTowardMoney({
          linkRole: "corroborating",
          lifecycle,
        }),
      ).toBe(false);
    }
  });
});

describe("checkBookOnce", () => {
  it("passes when the new amount fits under the payment cap", () => {
    const result = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "0",
      newAmount: "60.00",
    });
    expect(result.ok).toBe(true);
    expect(result.overage).toBe(0);
    expect(result.total).toBeCloseTo(60);
  });

  it("passes when other applications plus the new one equal the cap", () => {
    const result = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "40.00",
      newAmount: "60.00",
    });
    expect(result.ok).toBe(true);
    expect(result.total).toBeCloseTo(100);
    expect(result.overage).toBe(0);
  });

  it("fails when the running total exceeds the payment cap", () => {
    const result = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "80.00",
      newAmount: "60.00",
    });
    expect(result.ok).toBe(false);
    expect(result.total).toBeCloseTo(140);
    expect(result.overage).toBeGreaterThan(39);
  });

  it("absorbs a gross-over-net split with an explicit fee-band tolerance", () => {
    const first = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "0",
      newAmount: "53.00",
      tolerance: 3.5,
    });
    expect(first.ok).toBe(true);

    const second = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "53.00",
      newAmount: "50.00",
      tolerance: 3.5,
    });
    expect(second.ok).toBe(true);
    expect(second.total).toBeCloseTo(103);
  });

  it("rejects a split that overruns even the fee-band tolerance", () => {
    const result = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "60.00",
      newAmount: "60.00",
      tolerance: 3.5,
    });
    expect(result.ok).toBe(false);
    expect(result.overage).toBeGreaterThan(16);
  });

  it("passes when an unknown payment amount cannot prove over-application", () => {
    for (const amount of [null, ""] as const) {
      const result = checkBookOnce({
        paymentAmount: amount,
        otherAppliedSum: "999.00",
        newAmount: "999.00",
      });
      expect(result.ok).toBe(true);
      expect(result.cap).toBeNull();
      expect(result.overage).toBe(0);
    }
  });

  it("treats null or empty prior sums as zero", () => {
    const result = checkBookOnce({
      paymentAmount: "50.00",
      otherAppliedSum: null,
      newAmount: 50,
    });
    expect(result.ok).toBe(true);
    expect(result.total).toBeCloseTo(50);
  });

  it("allows only float-noise headroom by default", () => {
    const result = checkBookOnce({
      paymentAmount: "100.00",
      otherAppliedSum: "0",
      newAmount: "101.00",
    });
    expect(result.ok).toBe(false);
    expect(result.overage).toBeCloseTo(1, 2);
  });
});
