import { describe, expect, it } from "vitest";
import { UpdateGiftOrPaymentBody } from "@workspace/api-zod";
import {
  deriveGiftBookable,
  type BookableGiftInput,
} from "../lib/bookableGift";

const completeGift = (): BookableGiftInput => ({
  organizationId: null,
  individualGiverPersonId: "person_1",
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
  it("requires donor source material for unrestricted institutional gifts", () => {
    const gift = completeGift();
    gift.individualGiverPersonId = null;
    gift.organizationId = "org_1";
    expect(deriveGiftBookable(gift)).toEqual({
      bookable: false,
      reasons: ["missing_restriction_evidence"],
    });
    gift.grantLetterUrl = "/api/storage/objects/grant-letter";
    expect(deriveGiftBookable(gift).bookable).toBe(true);
    gift.grantLetterUrl = null;
    gift.sourceRecordUrl = "https://donorbox.org/example-campaign";
    expect(deriveGiftBookable(gift).bookable).toBe(true);
  });

  it("does not require restriction evidence for unrestricted household gifts", () => {
    const gift = completeGift();
    gift.individualGiverPersonId = null;
    gift.householdId = "household_1";
    expect(deriveGiftBookable(gift).bookable).toBe(true);
  });

  it("keeps off-books institutional gifts exempt", () => {
    const gift = completeGift();
    gift.individualGiverPersonId = null;
    gift.organizationId = "org_1";
    gift.isOffBooks = true;
    expect(deriveGiftBookable(gift).bookable).toBe(true);
  });

  it("retains a reviewed source link through the gift update contract", () => {
    const gift = completeGift();
    gift.allocations[0]!.otherRestrictionType = "donor_restricted";
    gift.allocations[0]!.purposeVerbatim = "Support the campaign purpose.";
    expect(deriveGiftBookable(gift).reasons).toContain(
      "missing_restriction_evidence",
    );

    const patch = UpdateGiftOrPaymentBody.parse({
      sourceRecordUrl: "https://donorbox.org/example-campaign",
    });
    expect(patch.sourceRecordUrl).toBe("https://donorbox.org/example-campaign");
    expect(deriveGiftBookable({ ...gift, ...patch }).bookable).toBe(true);

    const cleared = UpdateGiftOrPaymentBody.parse({ sourceRecordUrl: null });
    expect(cleared).toEqual({ sourceRecordUrl: null });
    expect(deriveGiftBookable({ ...gift, ...cleared }).reasons).toContain(
      "missing_restriction_evidence",
    );
    expect(
      UpdateGiftOrPaymentBody.parse({ name: "Updated title" }),
    ).not.toHaveProperty("sourceRecordUrl");
  });

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
