import { describe, expect, it } from "vitest";
import {
  looksLikeIntermediary,
  donorNameFromMemo,
  trimToEssentialName,
} from "./donor-seed";

describe("looksLikeIntermediary", () => {
  it("flags known processors / DAFs (case-insensitive)", () => {
    expect(looksLikeIntermediary("Stripe")).toBe(true);
    expect(looksLikeIntermediary("DONORBOX")).toBe(true);
    expect(looksLikeIntermediary("Fidelity Charitable Gift Fund")).toBe(true);
    expect(looksLikeIntermediary("Some DAF")).toBe(true);
  });

  it("flags the DAF sponsors / rails added from the production audit", () => {
    expect(looksLikeIntermediary("Fidelity Charitable")).toBe(true);
    expect(looksLikeIntermediary("Schwab Charitable")).toBe(true);
    expect(looksLikeIntermediary("Vanguard Charitable")).toBe(true);
    expect(looksLikeIntermediary("Bill.com")).toBe(true);
  });

  it("does not flag ordinary donors or empty input", () => {
    expect(looksLikeIntermediary("Angie Schiavoni")).toBe(false);
    expect(looksLikeIntermediary(null)).toBe(false);
    expect(looksLikeIntermediary(undefined)).toBe(false);
  });
});

describe("donorNameFromMemo", () => {
  it("pulls the real donor after 'from'", () => {
    expect(
      donorNameFromMemo(
        "Donor Advised Fund Gift from Nic and Lindsey Barnes, for Dahlia SF",
      ),
    ).toBe("Nic and Lindsey Barnes");
  });

  it("pulls the real donor after 'by'", () => {
    expect(donorNameFromMemo("Donorbox gift by Jane Doe")).toBe("Jane Doe");
  });

  it("pulls a trailing dash-delimited donor", () => {
    expect(donorNameFromMemo("Stripe donation - Angie Schiavoni")).toBe(
      "Angie Schiavoni",
    );
  });

  it("stops at descriptor words so 'donation'/'gift' aren't captured", () => {
    expect(donorNameFromMemo("from John Smith donation")).toBe("John Smith");
  });

  it("does not split an intra-name hyphen on the trailing-dash path", () => {
    // The dash delimiter requires trailing whitespace, so "Mendez-Ortiz" is
    // treated as one surname rather than a "- Ortiz" delimiter.
    expect(donorNameFromMemo("Charge for Burgess and Mendez-Ortiz")).toBe(
      "Burgess and Mendez-Ortiz",
    );
  });

  // Patterns added after auditing real production Stripe/Donorbox/DAF memos.
  it("pulls a donor named first, before the 'donation' keyword", () => {
    expect(donorNameFromMemo("Erica Cantoni donation via Stripe")).toBe(
      "Erica Cantoni",
    );
    expect(donorNameFromMemo("Alexander Brown donation to BWF via Stripe")).toBe(
      "Alexander Brown",
    );
    expect(donorNameFromMemo("Amy Hertel Donation")).toBe("Amy Hertel");
    expect(donorNameFromMemo("Constance G donation pass thru to MN")).toBe(
      "Constance G",
    );
  });

  it("pulls the donor from a 'Charge for <name>' memo", () => {
    expect(donorNameFromMemo("Charge for Michelle Yang")).toBe("Michelle Yang");
  });

  it("does not treat an intermediary or category as a leading donor", () => {
    expect(donorNameFromMemo("Stripe donation")).toBeNull();
    expect(donorNameFromMemo("Stripe Charges")).toBeNull();
    expect(donorNameFromMemo("Anonymous donation")).toBeNull();
    expect(donorNameFromMemo("Individual Donations Paul Serotkin")).toBeNull();
    expect(donorNameFromMemo("EE Donation hermann.elisa@gmail.com")).toBeNull();
  });

  it("stays null on multi-donor split memos (never seeds just one)", () => {
    expect(
      donorNameFromMemo("Charges- Lutterman, Auletta, Hollenback, Waggoner"),
    ).toBeNull();
    expect(
      donorNameFromMemo("Donations- Marianne H, Lara B, Mara M, Chris O"),
    ).toBeNull();
  });

  it("returns null when nothing confident is found", () => {
    expect(donorNameFromMemo("")).toBeNull();
    expect(donorNameFromMemo(null)).toBeNull();
    expect(donorNameFromMemo("monthly recurring")).toBeNull();
  });
});

describe("trimToEssentialName", () => {
  it("drops a trailing generic org word", () => {
    expect(trimToEssentialName("CityBridge Foundation")).toBe("CityBridge");
  });

  it("drops a leading 'The' and trailing org words", () => {
    expect(trimToEssentialName("The Smith Family Foundation")).toBe(
      "Smith Family",
    );
  });

  it("handles Inc / LLC with trailing punctuation", () => {
    expect(trimToEssentialName("Acme Widgets Inc.")).toBe("Acme Widgets");
    expect(trimToEssentialName("Helios Co., LLC")).toBe("Helios");
  });

  it("drops 'Philanthropies' / 'Philanthropy' (from the production audit)", () => {
    expect(trimToEssentialName("Rockefeller Philanthropies")).toBe(
      "Rockefeller",
    );
  });

  it("leaves single-word and non-org names unchanged", () => {
    expect(trimToEssentialName("CityBridge")).toBe("CityBridge");
    expect(trimToEssentialName("Nic and Lindsey Barnes")).toBe(
      "Nic and Lindsey Barnes",
    );
  });

  it("keeps the original when every word is generic", () => {
    expect(trimToEssentialName("The Foundation Fund")).toBe(
      "The Foundation Fund",
    );
  });

  it("returns the input unchanged when empty", () => {
    expect(trimToEssentialName("")).toBe("");
  });
});
