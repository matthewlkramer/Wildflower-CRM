import { describe, it, expect } from "vitest";
import { candidateNamesFromReference } from "../lib/quickbooksMatch";

describe("candidateNamesFromReference", () => {
  it("returns nothing for empty / null / whitespace references", () => {
    expect(candidateNamesFromReference(null)).toEqual([]);
    expect(candidateNamesFromReference("")).toEqual([]);
    expect(candidateNamesFromReference("   ")).toEqual([]);
  });

  it("pulls the trailing name after the last dash", () => {
    expect(
      candidateNamesFromReference("Donation for BWF - Kathleen Rash"),
    ).toContain("Kathleen Rash");
  });

  it("pulls a name following from/for/by keywords", () => {
    expect(
      candidateNamesFromReference("Contribution from Fidelity Foundation"),
    ).toContain("Fidelity Foundation");
    expect(candidateNamesFromReference("Gift by Jane Q. Public")).toContain(
      "Jane Q. Public",
    );
  });

  it("ignores single-token / short candidates (acronyms, common words)", () => {
    // "from BWF" → single token, dropped; nothing else extractable.
    expect(candidateNamesFromReference("Wire from BWF")).toEqual([]);
    expect(candidateNamesFromReference("Donation - ACH")).toEqual([]);
  });

  it("de-dupes when dash and keyword resolve to the same name", () => {
    const out = candidateNamesFromReference("Payment for John Smith");
    expect(out).toEqual(["John Smith"]);
  });

  it("collapses internal whitespace", () => {
    expect(
      candidateNamesFromReference("Donation for   BWF  -  Kathleen   Rash"),
    ).toContain("Kathleen Rash");
  });
});
