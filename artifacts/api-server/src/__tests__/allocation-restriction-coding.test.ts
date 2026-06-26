import { describe, expect, it } from "vitest";
import {
  anyDonorRestricted,
  deriveRevenueCoding,
  effectiveCoding,
  type CodingInput,
} from "@workspace/api-zod";
import {
  canonicalWinProbability,
  isConditionalPledge,
} from "../lib/pledgeStage";

/**
 * Task #449 — allocation restriction & coding cleanup.
 *
 * Pure-logic coverage for the three behaviours the cleanup introduced:
 *   1. the three-axis restriction taxonomy driving the revenue object code
 *      (ANY axis donor_restricted ⇒ restricted 4100.x; wf_restricted /
 *      unrestricted ⇒ 4000.x),
 *   2. the on-demand coding preview deriving cleanly from allocation scope, and
 *   3. the grant-conditions → win-probability weighting (conditional pledges
 *      weight 0.7500, otherwise 0.9000).
 *
 * The reimbursable_share → reimbursement_type rename and the SQL exclusion are
 * exercised end-to-end in reimbursable-share-analytics.integration.test.ts.
 */

const baseInput: CodingInput = {
  donorKind: "individual",
  orgEntityType: null,
  entityId: null,
  regionalRestrictionType: "unrestricted",
  usageRestrictionType: "unrestricted",
  timeRestrictionType: "unrestricted",
};

describe("three-axis restriction taxonomy", () => {
  it("anyDonorRestricted is true only when an axis is donor_restricted", () => {
    expect(anyDonorRestricted("unrestricted", "unrestricted", "unrestricted")).toBe(false);
    expect(anyDonorRestricted("wf_restricted", "unrestricted", "wf_restricted")).toBe(false);
    expect(anyDonorRestricted("unrestricted", "donor_restricted", "unrestricted")).toBe(true);
    expect(anyDonorRestricted(null, undefined, "donor_restricted")).toBe(true);
  });

  it("codes to the unrestricted contribution account when no axis is donor_restricted", () => {
    const r = deriveRevenueCoding(baseInput);
    expect(r.objectCode).toBe("4000.1");
  });

  it("treats wf_restricted as unrestricted for revenue coding", () => {
    const r = deriveRevenueCoding({
      ...baseInput,
      regionalRestrictionType: "wf_restricted",
      timeRestrictionType: "wf_restricted",
    });
    expect(r.objectCode).toBe("4000.1");
  });

  it("upgrades to the restricted contribution account when ANY axis is donor_restricted", () => {
    expect(
      deriveRevenueCoding({ ...baseInput, regionalRestrictionType: "donor_restricted" }).objectCode,
    ).toBe("4100.1");
    expect(
      deriveRevenueCoding({ ...baseInput, usageRestrictionType: "donor_restricted" }).objectCode,
    ).toBe("4100.1");
    expect(
      deriveRevenueCoding({ ...baseInput, timeRestrictionType: "donor_restricted" }).objectCode,
    ).toBe("4100.1");
  });

  it("never emits an 'unclear' / review flag from the axes (axes default unrestricted)", () => {
    const r = deriveRevenueCoding(baseInput);
    expect(r.flags).not.toContain("restriction_unclear");
  });
});

describe("on-demand coding preview derives from allocation scope", () => {
  it("derives object code, location and class for an org foundation donor", () => {
    const r = deriveRevenueCoding({
      donorKind: "organization",
      orgEntityType: "institutional_foundation",
      entityId: null,
      regionalRestrictionType: "unrestricted",
      usageRestrictionType: "donor_restricted",
      timeRestrictionType: "unrestricted",
    });
    // foundation payer (.2) + donor_restricted ⇒ 4100.2.
    expect(r.objectCode).toBe("4100.2");
    expect(r.location).toBe("Foundation General");
    expect(r.flags).toContain("location_default");
  });

  it("an entity coding rule can force restriction regardless of the axes", () => {
    const r = deriveRevenueCoding({
      ...baseInput,
      entityId: "black_wildflowers_fund",
    });
    // forceRestricted SPO ⇒ 4100.x even though every axis is unrestricted.
    expect(r.objectCode).toBe("4100.1");
    expect(r.location).toBe("Spo- Black Wildflowers Fund");
  });

  it("effectiveCoding prefers a manual override over the derived snapshot", () => {
    expect(effectiveCoding("4099", "4000.1")).toBe("4099");
    expect(effectiveCoding(null, "4000.1")).toBe("4000.1");
    expect(effectiveCoding(undefined, undefined)).toBeNull();
  });
});

describe("grant conditions → win-probability weighting", () => {
  it("classifies only the genuinely-uncertain conditional kinds as conditional", () => {
    expect(isConditionalPledge("conditional_unspecified")).toBe(true);
    expect(isConditionalPledge("conditional_on_funder_determination")).toBe(true);
    expect(isConditionalPledge("conditional_on_target")).toBe(true);
    expect(isConditionalPledge("unconditional")).toBe(false);
    expect(isConditionalPledge("reimbursable")).toBe(false);
    expect(isConditionalPledge(null)).toBe(false);
  });

  it("weights an unconditional written pledge at 0.9000", () => {
    expect(canonicalWinProbability("pledge", "complete", "unconditional")).toBe("0.9000");
    expect(canonicalWinProbability("pledge", "complete", null)).toBe("0.9000");
  });

  it("discounts a conditional written pledge to 0.7500", () => {
    expect(canonicalWinProbability("pledge", "complete", "conditional_unspecified")).toBe("0.7500");
    expect(canonicalWinProbability("pledge", "complete", "conditional_on_target")).toBe("0.7500");
  });

  it("keeps terminal statuses at their fixed weights regardless of conditional", () => {
    expect(canonicalWinProbability("cash_in", "complete", "conditional_unspecified")).toBe("1.0000");
    expect(canonicalWinProbability("lost", null, "conditional_unspecified")).toBe("0.0000");
    expect(canonicalWinProbability("dormant", null, null)).toBe("0.0000");
  });
});
