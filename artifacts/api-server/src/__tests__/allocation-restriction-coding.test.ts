import { describe, expect, it } from "vitest";
import {
  anyDonorRestricted,
  deriveRevenueCoding,
  deriveRevenueType,
  deriveRestrictionLabel,
  deriveRestrictionEvidence,
  deriveDeferredRevenue,
  describePaymentSchedule,
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
    // No fundable project set ⇒ no project_location_missing flag; the old
    // location_default flag was removed (Foundation General is the deliberate
    // fallback, not a flagged default).
    expect(r.flags).not.toContain("location_default");
    expect(r.flags).not.toContain("project_location_missing");
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

/**
 * Task #607 — Revenue Extractor derivation helpers. Pure-logic coverage for the
 * report-only columns that don't drive the object code: revenue type, the
 * restriction label + evidence, deferred-revenue, and the payment-schedule
 * descriptor.
 */
describe("Revenue Extractor derivation helpers", () => {
  it("deriveRestrictionLabel maps the axes (+ forceRestricted) onto the label", () => {
    expect(deriveRestrictionLabel(baseInput, undefined)).toBe("Unrestricted");
    expect(
      deriveRestrictionLabel(
        { ...baseInput, usageRestrictionType: "donor_restricted" },
        undefined,
      ),
    ).toBe("Purpose");
    expect(
      deriveRestrictionLabel(
        { ...baseInput, regionalRestrictionType: "donor_restricted" },
        undefined,
      ),
    ).toBe("Purpose");
    expect(
      deriveRestrictionLabel(
        { ...baseInput, timeRestrictionType: "donor_restricted" },
        undefined,
      ),
    ).toBe("Time");
    expect(
      deriveRestrictionLabel(
        {
          ...baseInput,
          usageRestrictionType: "donor_restricted",
          timeRestrictionType: "donor_restricted",
        },
        undefined,
      ),
    ).toBe("Both");
    // wf_restricted is treated as unrestricted for revenue coding.
    expect(
      deriveRestrictionLabel(
        { ...baseInput, usageRestrictionType: "wf_restricted" },
        undefined,
      ),
    ).toBe("Unrestricted");
    // A forceRestricted entity rule (fiscal sponsee) counts as a purpose restriction.
    expect(
      deriveRestrictionLabel(baseInput, {
        entityId: "x",
        enabled: true,
        forceRestricted: true,
      } as never),
    ).toBe("Purpose");
  });

  it("deriveRevenueType is a grant on a letter, a reporting requirement, or restriction", () => {
    // Unrestricted, no letter / requirement ⇒ donation.
    expect(deriveRevenueType(baseInput, false)).toBe("donation");
    // Restricted ⇒ grant.
    expect(deriveRevenueType(baseInput, true)).toBe("grant");
    // Grant letter on file ⇒ grant even when unrestricted.
    expect(
      deriveRevenueType({ ...baseInput, hasGrantLetter: true }, false),
    ).toBe("grant");
    // Reporting requirement ⇒ grant even when unrestricted.
    expect(
      deriveRevenueType({ ...baseInput, hasReportingRequirement: true }, false),
    ).toBe("grant");
  });

  it("deriveRestrictionEvidence is empty when unrestricted, else verbatim + notes", () => {
    expect(deriveRestrictionEvidence(baseInput, "Unrestricted")).toBe("");
    expect(
      deriveRestrictionEvidence(
        { ...baseInput, purposeVerbatim: "For teacher training only" },
        "Purpose",
      ),
    ).toBe("For teacher training only");
    expect(
      deriveRestrictionEvidence(
        {
          ...baseInput,
          purposeVerbatim: "For teacher training only",
          hasGrantLetter: true,
          hasReportingRequirement: true,
        },
        "Purpose",
      ),
    ).toBe("For teacher training only; Grant letter on file; Reporting requirement");
  });

  it("deriveDeferredRevenue is yes only when the allocation FY starts after the tx FY", () => {
    // Compares FISCAL-YEAR start dates, not raw transaction/recognition dates.
    expect(deriveDeferredRevenue("2025-07-01", "2026-07-01")).toBe("yes");
    expect(deriveDeferredRevenue("2026-07-01", "2025-07-01")).toBe("no");
    // Same fiscal year (revenue recognized in-year) is not deferred.
    expect(deriveDeferredRevenue("2025-07-01", "2025-07-01")).toBe("no");
    expect(deriveDeferredRevenue(null, "2026-07-01")).toBe("na");
    expect(deriveDeferredRevenue("2025-07-01", null)).toBe("na");
  });

  it("describePaymentSchedule labels single payments and pledge installments", () => {
    expect(describePaymentSchedule({})).toBe("Single payment");
    expect(describePaymentSchedule({ isPledgePayment: false })).toBe("Single payment");
    expect(describePaymentSchedule({ isPledgePayment: true })).toBe("Pledge payment");
    expect(
      describePaymentSchedule({
        isPledgePayment: true,
        installmentNumber: 2,
        totalInstallments: 4,
      }),
    ).toBe("Pledge payment 2 of 4");
  });

  it("describePaymentSchedule appends remaining/next-expected notes", () => {
    expect(
      describePaymentSchedule({
        isPledgePayment: true,
        installmentNumber: 1,
        totalInstallments: 3,
        remainingExpected: 2,
        nextExpectedDate: "2026-09-01",
      }),
    ).toBe("Pledge payment 1 of 3 (next expected 2026-09-01, 2 more expected)");
    // Zero/absent remaining and no next date collapse back to the bare label.
    expect(
      describePaymentSchedule({
        isPledgePayment: true,
        remainingExpected: 0,
      }),
    ).toBe("Pledge payment");
  });
});
