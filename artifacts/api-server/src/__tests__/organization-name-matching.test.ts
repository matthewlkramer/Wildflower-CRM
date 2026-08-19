import { describe, expect, it } from "vitest";
import {
  canonicalOrganizationName,
  organizationNamesEquivalent,
} from "../lib/organizationNameMatching";

describe("organization name matching", () => {
  it("recognizes only harmless presentation variants", () => {
    expect(canonicalOrganizationName("  The College-Board,  ")).toBe(
      "college board",
    );
    expect(
      organizationNamesEquivalent("The College Board", "college board"),
    ).toBe(true);
    expect(
      organizationNamesEquivalent("O’Reilly Foundation", "oreilly foundation"),
    ).toBe(true);
    expect(
      organizationNamesEquivalent("Cafe Foundation", "Café Foundation"),
    ).toBe(true);
  });

  it("does not turn prefixes, suffixes, or fuzzy lookalikes into matches", () => {
    expect(
      organizationNamesEquivalent("College Board", "College Board Foundation"),
    ).toBe(false);
    expect(
      organizationNamesEquivalent("College Board", "College Boards"),
    ).toBe(false);
  });
});