import { describe, it, expect } from "vitest";
import { pledgeStateFrom, giftStateFrom } from "./allocation-editors";
import type { PledgeAllocation, GiftAllocation } from "@workspace/api-client-react";

const DEFAULTS = { currentFiscalYearId: "FY2025-26" };

function makePledgeAlloc(overrides: Partial<PledgeAllocation> = {}): PledgeAllocation {
  return {
    id: "pa-1",
    directToSchool: false,
    regionalRestrictionType: "unrestricted",
    otherRestrictionType: "unrestricted",
    timeRestrictionType: "unrestricted",
    conditionsMet: "no",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeGiftAlloc(overrides: Partial<GiftAllocation> = {}): GiftAllocation {
  return {
    id: "ga-1",
    regionalRestrictionType: "unrestricted",
    otherRestrictionType: "unrestricted",
    timeRestrictionType: "unrestricted",
    countsTowardGoal: true,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("pledgeStateFrom — add allocation defaults", () => {
  it("defaults intendedUsage to gen_ops for a new allocation", () => {
    const state = pledgeStateFrom(null, DEFAULTS);
    expect(state.intendedUsage).toBe("gen_ops");
  });

  it("defaults grantYear to the current fiscal year for a new allocation", () => {
    const state = pledgeStateFrom(null, DEFAULTS);
    expect(state.grantYear).toBe("FY2025-26");
  });

  it("leaves grantYear empty when no currentFiscalYearId is provided", () => {
    const state = pledgeStateFrom(null, { currentFiscalYearId: "" });
    expect(state.grantYear).toBe("");
  });

  it("leaves grantYear empty when defaults are omitted", () => {
    const state = pledgeStateFrom(null);
    expect(state.grantYear).toBe("");
  });
});

describe("pledgeStateFrom — edit allocation preserves saved values", () => {
  it("uses the saved intendedUsage, not the new-allocation default", () => {
    const existing = makePledgeAlloc({ intendedUsage: "growth", grantYear: "FY2024-25" });
    const state = pledgeStateFrom(existing, DEFAULTS);
    expect(state.intendedUsage).toBe("growth");
  });

  it("uses the saved grantYear, not the current FY default", () => {
    const existing = makePledgeAlloc({ intendedUsage: "growth", grantYear: "FY2024-25" });
    const state = pledgeStateFrom(existing, DEFAULTS);
    expect(state.grantYear).toBe("FY2024-25");
  });

  it("uses a null intendedUsage when the saved value is null", () => {
    const existing = makePledgeAlloc({ intendedUsage: null, grantYear: "FY2024-25" });
    const state = pledgeStateFrom(existing, DEFAULTS);
    expect(state.intendedUsage).toBe("");
  });

  it("uses a null grantYear when the saved value is null", () => {
    const existing = makePledgeAlloc({ intendedUsage: "teacher_training", grantYear: null });
    const state = pledgeStateFrom(existing, DEFAULTS);
    expect(state.grantYear).toBe("");
  });
});

describe("giftStateFrom — add allocation defaults", () => {
  it("defaults intendedUsage to gen_ops for a new allocation", () => {
    const state = giftStateFrom(null, DEFAULTS);
    expect(state.intendedUsage).toBe("gen_ops");
  });

  it("defaults grantYear to the current fiscal year for a new allocation", () => {
    const state = giftStateFrom(null, DEFAULTS);
    expect(state.grantYear).toBe("FY2025-26");
  });

  it("leaves grantYear empty when no currentFiscalYearId is provided", () => {
    const state = giftStateFrom(null, { currentFiscalYearId: "" });
    expect(state.grantYear).toBe("");
  });

  it("leaves grantYear empty when defaults are omitted", () => {
    const state = giftStateFrom(null);
    expect(state.grantYear).toBe("");
  });
});

describe("giftStateFrom — edit allocation preserves saved values", () => {
  it("uses the saved intendedUsage, not the new-allocation default", () => {
    const existing = makeGiftAlloc({ intendedUsage: "school_startup", grantYear: "FY2024-25" });
    const state = giftStateFrom(existing, DEFAULTS);
    expect(state.intendedUsage).toBe("school_startup");
  });

  it("uses the saved grantYear, not the current FY default", () => {
    const existing = makeGiftAlloc({ intendedUsage: "school_startup", grantYear: "FY2024-25" });
    const state = giftStateFrom(existing, DEFAULTS);
    expect(state.grantYear).toBe("FY2024-25");
  });

  it("uses a null intendedUsage when the saved value is null", () => {
    const existing = makeGiftAlloc({ intendedUsage: null, grantYear: "FY2024-25" });
    const state = giftStateFrom(existing, DEFAULTS);
    expect(state.intendedUsage).toBe("");
  });

  it("uses a null grantYear when the saved value is null", () => {
    const existing = makeGiftAlloc({ intendedUsage: "growth", grantYear: null });
    const state = giftStateFrom(existing, DEFAULTS);
    expect(state.grantYear).toBe("");
  });
});
