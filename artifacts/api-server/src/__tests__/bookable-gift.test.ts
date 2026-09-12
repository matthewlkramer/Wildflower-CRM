import { describe, expect, it } from "vitest";
import {
  deriveGiftBookable,
  type BookableGiftInput,
} from "../lib/bookableGift";

const completeGift = (): BookableGiftInput => ({
  organizationId: "org_1",
  individualGiverPersonId: null,
  householdId: null,
  amount: "100.00",
  dateReceived: "2026-09-12",
  grantLetterUrl: null,
  sourceRecordUrl: null,
  isOffBooks: false,
  allocations: [
    {
      subAmount: "100.00",
      entityId: "foundation",
      grantYear: "fy2027",
      intendedUsage: "gen_ops",
      fundableProjectId: null,
      regionalRestrictionType: "unrestricted",
      otherRestrictionType: "unrestricted",
      timeRestrictionType: "unrestricted",
      purposeVerbatim: null,
    },
  ],
  hasOpportunity: true,
  reportRequired: false,
  hasReportingDeadlineTask: false,
});

describe("CRM-native bookable gift safeguards", () => {
  it("accepts a complete unrestricted gift without coding-form evidence", () => {
    expect(deriveGiftBookable(completeGift())).toEqual({
      bookable: true,
      reasons: [],
    });
  });

  it("requires exact source language on a donor-restricted allocation", () => {
    const gift = completeGift();
    gift.grantLetterUrl = "/api/storage/objects/grant-letter";
    gift.allocations[0]!.regionalRestrictionType = "donor_restricted";

    expect(deriveGiftBookable(gift)).toEqual({
      bookable: false,
      reasons: ["missing_restriction_language"],
    });
  });

  it("requires a reporting deadline only when the opportunity says reporting is required", () => {
    const gift = completeGift();
    gift.reportRequired = true;

    expect(deriveGiftBookable(gift).reasons).toEqual([
      "missing_reporting_deadline",
    ]);

    gift.hasReportingDeadlineTask = true;
    expect(deriveGiftBookable(gift).bookable).toBe(true);
  });

  it("blocks an unreviewed historical reporting requirement", () => {
    const gift = completeGift();
    gift.reportRequired = null;

    expect(deriveGiftBookable(gift).reasons).toEqual([
      "missing_reporting_requirement_decision",
    ]);
  });

  it("does not allow an allocation without an amount to be export-ready", () => {
    const gift = completeGift();
    gift.allocations[0]!.subAmount = null;

    expect(deriveGiftBookable(gift).reasons).toContain(
      "missing_allocation_amount",
    );
  });
});
