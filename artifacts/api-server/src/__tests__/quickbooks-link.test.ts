import { describe, it, expect } from "vitest";
import {
  donorOf,
  donorsMatch,
  hasExactlyOneDonor,
  validateGiftLink,
  type LinkDonor,
} from "../lib/quickbooksLink";

const org = (id: string): LinkDonor => ({
  organizationId: id,
  individualGiverPersonId: null,
  householdId: null,
});
const person = (id: string): LinkDonor => ({
  organizationId: null,
  individualGiverPersonId: id,
  householdId: null,
});
const household = (id: string): LinkDonor => ({
  organizationId: null,
  individualGiverPersonId: null,
  householdId: id,
});
const none: LinkDonor = {
  organizationId: null,
  individualGiverPersonId: null,
  householdId: null,
};

describe("donorOf", () => {
  it("normalizes undefined FKs to null", () => {
    expect(donorOf({ organizationId: "o1" })).toEqual({
      organizationId: "o1",
      individualGiverPersonId: null,
      householdId: null,
    });
  });
});

describe("hasExactlyOneDonor", () => {
  it("true for exactly one FK", () => {
    expect(hasExactlyOneDonor(org("o1"))).toBe(true);
    expect(hasExactlyOneDonor(person("p1"))).toBe(true);
    expect(hasExactlyOneDonor(household("h1"))).toBe(true);
  });
  it("false for none or multiple", () => {
    expect(hasExactlyOneDonor(none)).toBe(false);
    expect(
      hasExactlyOneDonor({
        organizationId: "o1",
        individualGiverPersonId: "p1",
        householdId: null,
      }),
    ).toBe(false);
  });
});

describe("donorsMatch", () => {
  it("matches same type + id", () => {
    expect(donorsMatch(org("o1"), org("o1"))).toBe(true);
    expect(donorsMatch(person("p1"), person("p1"))).toBe(true);
  });
  it("rejects different id or type", () => {
    expect(donorsMatch(org("o1"), org("o2"))).toBe(false);
    expect(donorsMatch(org("o1"), person("o1"))).toBe(false);
  });
});

describe("validateGiftLink", () => {
  it("allows a clean link (same donor, not already linked)", () => {
    expect(
      validateGiftLink({
        stagedDonor: org("o1"),
        giftDonor: org("o1"),
        alreadyLinkedStagedPaymentId: null,
      }),
    ).toEqual([]);
  });

  it("rejects when the staged row has no donor", () => {
    const issues = validateGiftLink({
      stagedDonor: none,
      giftDonor: org("o1"),
      alreadyLinkedStagedPaymentId: null,
    });
    expect(issues.map((i) => i.code)).toContain("no_donor");
    // Donor-mismatch is suppressed when there is no staged donor to compare.
    expect(issues.map((i) => i.code)).not.toContain("donor_mismatch");
  });

  it("rejects when the gift is already linked elsewhere", () => {
    const issues = validateGiftLink({
      stagedDonor: org("o1"),
      giftDonor: org("o1"),
      alreadyLinkedStagedPaymentId: "sp_other",
    });
    expect(issues.map((i) => i.code)).toEqual(["already_linked"]);
  });

  it("rejects when the gift's donor differs from the staged donor", () => {
    const issues = validateGiftLink({
      stagedDonor: person("p1"),
      giftDonor: org("o1"),
      alreadyLinkedStagedPaymentId: null,
    });
    expect(issues.map((i) => i.code)).toContain("donor_mismatch");
  });

  it("can return multiple issues at once", () => {
    const issues = validateGiftLink({
      stagedDonor: household("h1"),
      giftDonor: org("o1"),
      alreadyLinkedStagedPaymentId: "sp_other",
    });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("already_linked");
    expect(codes).toContain("donor_mismatch");
  });
});
