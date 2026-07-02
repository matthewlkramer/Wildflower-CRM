import { describe, it, expect } from "vitest";
import { reconcileTarget, type GiftWindowCandidate } from "../lib/quickbooksMatch";

const g = (
  id: string,
  dateReceived: string | null = null,
): GiftWindowCandidate => ({ id, dateReceived });

describe("reconcileTarget", () => {
  it("reconciles to a single exact-amount gift", () => {
    expect(reconcileTarget([g("g1")], [g("g1")])).toBe("g1");
  });

  it("prefers the exact gift even when other fee-band gifts exist", () => {
    expect(reconcileTarget([g("g1")], [g("g1"), g("g2")])).toBe("g1");
  });

  it("falls back to a single fee-band gift when there is no exact match", () => {
    expect(reconcileTarget([], [g("g2")])).toBe("g2");
  });

  it("is ambiguous (null) with two fee-band gifts and no exact match", () => {
    expect(reconcileTarget([], [g("g2"), g("g3")])).toBeNull();
  });

  it("is ambiguous (null) with multiple exact-amount gifts and no anchor date", () => {
    expect(reconcileTarget([g("g1"), g("g2")], [g("g1"), g("g2")])).toBeNull();
  });

  it("is null when there are no gifts (a new gift is minted instead)", () => {
    expect(reconcileTarget([], [])).toBeNull();
  });

  describe("date tiebreak among several same-amount gifts (recurring donor)", () => {
    const monthly = [
      g("jul", "2022-07-20"),
      g("aug", "2022-08-20"),
      g("sep", "2022-09-20"),
    ];

    it("picks the one exact gift that lands on the payment's own date", () => {
      expect(reconcileTarget(monthly, monthly, "2022-08-20")).toBe("aug");
    });

    it("normalises an ISO datetime anchor to the calendar day", () => {
      expect(reconcileTarget(monthly, monthly, "2022-08-20T00:00:00.000Z")).toBe(
        "aug",
      );
    });

    it("stays ambiguous (null) when no exact gift is on the payment date", () => {
      expect(reconcileTarget(monthly, monthly, "2022-06-20")).toBeNull();
    });

    it("stays ambiguous (null) when two exact gifts share the payment date", () => {
      const sameDay = [g("a", "2022-08-20"), g("b", "2022-08-20")];
      expect(reconcileTarget(sameDay, sameDay, "2022-08-20")).toBeNull();
    });

    it("ignores the tiebreak for a single exact gift (already unambiguous)", () => {
      expect(reconcileTarget([g("only", "2022-01-01")], [g("only", "2022-01-01")], "2022-08-20")).toBe(
        "only",
      );
    });
  });
});
