import { describe, expect, it } from "vitest";
import {
  canOverrideCrossCheck,
  isCrossCheckApplyable,
  type GatableCrossCheck,
} from "./coding-form-gating";

function check(over: Partial<GatableCrossCheck>): GatableCrossCheck {
  return {
    attribute: "restrictionDescription",
    applicable: true,
    status: "new",
    blockedReason: null,
    ...over,
  };
}

describe("canOverrideCrossCheck", () => {
  it("offers the override picker for an applicable non-address check", () => {
    expect(canOverrideCrossCheck(check({}), "confirmed")).toBe(true);
  });

  it("offers the timeRestriction picker even when not applicable (na, no override yet)", () => {
    const c = check({
      attribute: "timeRestriction",
      applicable: false,
      status: "na",
    });
    expect(canOverrideCrossCheck(c, "confirmed")).toBe(true);
  });

  it("hides pickers for other non-applicable attributes", () => {
    const c = check({ applicable: false, status: "na" });
    expect(canOverrideCrossCheck(c, "confirmed")).toBe(false);
  });

  it("never offers an address override and never on applied rows", () => {
    expect(canOverrideCrossCheck(check({ attribute: "address" }), "confirmed")).toBe(false);
    expect(canOverrideCrossCheck(check({}), "applied")).toBe(false);
  });
});

describe("isCrossCheckApplyable", () => {
  it("applicable new/conflict checks are applyable", () => {
    expect(isCrossCheckApplyable(check({ status: "new" }), {})).toBe(true);
    expect(isCrossCheckApplyable(check({ status: "conflict" }), {})).toBe(true);
  });

  it("same-status and blocked checks are not applyable", () => {
    expect(isCrossCheckApplyable(check({ status: "same" }), {})).toBe(false);
    expect(
      isCrossCheckApplyable(check({ blockedReason: "no allocation" }), {}),
    ).toBe(false);
  });

  it("timeRestriction with no local override stays not applyable", () => {
    const c = check({
      attribute: "timeRestriction",
      applicable: false,
      status: "na",
    });
    expect(isCrossCheckApplyable(c, {})).toBe(false);
    expect(isCrossCheckApplyable(c, { timeRestriction: "   " })).toBe(false);
  });

  it("timeRestriction becomes applyable once the reviewer types an override", () => {
    const c = check({
      attribute: "timeRestriction",
      applicable: false,
      status: "na",
    });
    expect(isCrossCheckApplyable(c, { timeRestriction: "unrestricted" })).toBe(
      true,
    );
  });

  it("a local timeRestriction override does not unlock other attributes", () => {
    const c = check({ applicable: false, status: "na" });
    expect(isCrossCheckApplyable(c, { timeRestriction: "unrestricted" })).toBe(
      false,
    );
  });
});
