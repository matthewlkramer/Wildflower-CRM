import { describe, expect, it } from "vitest";
import {
  finalizeGrantLeadHeadline,
  getGrantLeadHeadlineIdentity,
} from "../lib/grantLeadHeadline";

describe("grant lead headline identity", () => {
  it("preserves a headline that already names the funder and program", () => {
    const headline = finalizeGrantLeadHeadline(
      "Cummings Foundation's Cummings $35 Million Grant Program supports Massachusetts nonprofits with letters of inquiry due September 16.",
      {
        funderName: "Cummings Foundation",
        programName: "Cummings $35 Million Grant Program",
      },
    );

    expect(headline).toBe(
      "Cummings Foundation's Cummings $35 Million Grant Program supports Massachusetts nonprofits with letters of inquiry due September 16.",
    );
  });

  it("adds known names when the model returns a generic headline", () => {
    const headline = finalizeGrantLeadHeadline(
      "A funding opportunity supports education nonprofits with applications due September 16.",
      {
        funderName: "Cummings Foundation",
        programName: "Cummings $35 Million Grant Program",
      },
    );

    expect(headline).toContain("Cummings Foundation");
    expect(headline).toContain("Cummings $35 Million Grant Program");
    expect(headline.split(/\s+/).length).toBeLessThanOrEqual(35);
  });

  it("uses the named program when no funder was extracted", () => {
    const identity = getGrantLeadHeadlineIdentity({
      title: "Applications are open",
      funderName: null,
      snippet: "The Camelback Fellowship supports education entrepreneurs.",
    });
    const headline = finalizeGrantLeadHeadline(
      "Education entrepreneurs may apply by September 18.",
      identity,
    );

    expect(identity.programName).toBe("The Camelback Fellowship");
    expect(headline).toContain("The Camelback Fellowship");
  });

  it("keeps the identity when enforcing the 35-word limit", () => {
    const headline = finalizeGrantLeadHeadline(
      Array.from({ length: 50 }, (_, index) => `detail${index}`).join(" "),
      { funderName: "North Star Foundation", programName: null },
    );

    expect(headline).toContain("North Star Foundation");
    expect(headline.split(/\s+/).length).toBeLessThanOrEqual(35);
    expect(headline).toMatch(/[.!?]$/);
  });
});
