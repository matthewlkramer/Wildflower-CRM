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
