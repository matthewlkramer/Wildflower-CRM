import { describe, it, expect } from "vitest";
import { deriveGiftQbTie } from "../lib/giftQbTie";

// The pure deriver encodes INV-2 / INV-3 / INV-10. It is the single source of
// truth for the persisted `quickbooks_tie_status` and is DB-free, so it is
// exhaustively unit-testable here.

describe("deriveGiftQbTie", () => {
  it("exempts an off-books gift regardless of QB linkage", () => {
    expect(
      deriveGiftQbTie({
        offBooks: true,
        giftAmount: "100.00",
        hasQbLink: false,
        qbAmount: null,
        finalAmountSource: "human",
      }),
    ).toBe("exempt");
    // Off-books wins even when a QB amount would otherwise mismatch.
    expect(
      deriveGiftQbTie({
        offBooks: true,
        giftAmount: "100.00",
        hasQbLink: true,
        qbAmount: "5000.00",
        finalAmountSource: "quickbooks",
      }),
    ).toBe("exempt");
  });

  it("ties a QB-linked gift whose amount sits within the fee band", () => {
    // Exact match.
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "250.00",
        hasQbLink: true,
        qbAmount: "250.00",
        finalAmountSource: "quickbooks",
      }),
    ).toBe("tied");
    // Gross slightly above QB net — within the generous processor fee band.
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "103.00",
        hasQbLink: true,
        qbAmount: "100.00",
        finalAmountSource: "quickbooks",
      }),
    ).toBe("tied");
  });

  it("flags a QB-linked gift whose amount is outside the fee band", () => {
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "100.00",
        hasQbLink: true,
        qbAmount: "5000.00",
        finalAmountSource: "quickbooks",
      }),
    ).toBe("amount_mismatch");
    // Gift below the QB amount can never be explained by a processor fee.
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "50.00",
        hasQbLink: true,
        qbAmount: "100.00",
        finalAmountSource: "quickbooks",
      }),
    ).toBe("amount_mismatch");
  });

  it("ties when QB-linked but an amount is unknown (can't prove a mismatch)", () => {
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: null,
        hasQbLink: true,
        qbAmount: "100.00",
        finalAmountSource: "quickbooks",
      }),
    ).toBe("tied");
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "100.00",
        hasQbLink: true,
        qbAmount: null,
        finalAmountSource: "quickbooks",
      }),
    ).toBe("tied");
  });

  it("ties a Stripe-sourced gift with no direct QB link (payout-level tie)", () => {
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "100.00",
        hasQbLink: false,
        qbAmount: null,
        finalAmountSource: "stripe",
      }),
    ).toBe("tied");
  });

  it("marks an on-books gift with no QB evidence as missing", () => {
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "100.00",
        hasQbLink: false,
        qbAmount: null,
        finalAmountSource: "human",
      }),
    ).toBe("missing");
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "100.00",
        hasQbLink: false,
        qbAmount: null,
        finalAmountSource: null,
      }),
    ).toBe("missing");
  });
});
