import { describe, it, expect } from "vitest";
import { reconcileTarget } from "../lib/quickbooksMatch";

describe("reconcileTarget", () => {
  it("reconciles to a single exact-amount gift", () => {
    expect(reconcileTarget(["g1"], ["g1"])).toBe("g1");
  });

  it("prefers the exact gift even when other fee-band gifts exist", () => {
    expect(reconcileTarget(["g1"], ["g1", "g2"])).toBe("g1");
  });

  it("falls back to a single fee-band gift when there is no exact match", () => {
    expect(reconcileTarget([], ["g2"])).toBe("g2");
  });

  it("is ambiguous (null) with two fee-band gifts and no exact match", () => {
    expect(reconcileTarget([], ["g2", "g3"])).toBeNull();
  });

  it("is ambiguous (null) with multiple exact-amount gifts", () => {
    expect(reconcileTarget(["g1", "g2"], ["g1", "g2"])).toBeNull();
  });

  it("is null when there are no gifts (a new gift is minted instead)", () => {
    expect(reconcileTarget([], [])).toBeNull();
  });
});
