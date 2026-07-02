import { describe, it, expect } from "vitest";
import { deriveGiftQbTie } from "../lib/giftQbTie";

// The pure deriver encodes INV-2 / INV-3 / INV-10. It is the single source of
// truth for the persisted `quickbooks_tie_status` and is DB-free, so it is
// exhaustively unit-testable here.
//
// Post-flip the deriver is SOURCE-AGNOSTIC: it takes a resolved `hasLink`
// (any counted ledger row of any source) + `linkAmount` (the per-source
// PRECEDENCE-resolved amount, computed by `applyGiftQbTieMany`). The old
// amount-blind `finalAmountSource === 'stripe'` shortcut is gone.

describe("deriveGiftQbTie", () => {
  it("exempts an off-books gift regardless of linkage", () => {
    expect(
      deriveGiftQbTie({
        offBooks: true,
        giftAmount: "100.00",
        hasLink: false,
        linkAmount: null,
      }),
    ).toBe("exempt");
    // Off-books wins even when a linked amount would otherwise mismatch.
    expect(
      deriveGiftQbTie({
        offBooks: true,
        giftAmount: "100.00",
        hasLink: true,
        linkAmount: "5000.00",
      }),
    ).toBe("exempt");
  });

  it("exempts a payment_expected=false gift (folded into offBooks)", () => {
    // The applier feeds `offBooks = off_books_fiscal_sponsor OR
    // designated_to_school OR NOT payment_expected`, so a gift that expects no
    // payment reads as exempt and drops out of the "untied" filter — even with
    // no evidence (which would otherwise be `missing`).
    expect(
      deriveGiftQbTie({
        offBooks: true,
        giftAmount: "100.00",
        hasLink: false,
        linkAmount: null,
      }),
    ).toBe("exempt");
  });

  it("ties a linked gift whose amount sits within the fee band", () => {
    // Exact match.
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "250.00",
        hasLink: true,
        linkAmount: "250.00",
      }),
    ).toBe("tied");
    // Gross slightly above evidence net — within the generous processor fee band.
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "103.00",
        hasLink: true,
        linkAmount: "100.00",
      }),
    ).toBe("tied");
  });

  it("flags a linked gift whose amount is outside the fee band", () => {
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "100.00",
        hasLink: true,
        linkAmount: "5000.00",
      }),
    ).toBe("amount_mismatch");
    // Gift below the evidence amount can never be explained by a processor fee.
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "50.00",
        hasLink: true,
        linkAmount: "100.00",
      }),
    ).toBe("amount_mismatch");
  });

  it("ties when linked but an amount is unknown (can't prove a mismatch)", () => {
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: null,
        hasLink: true,
        linkAmount: "100.00",
      }),
    ).toBe("tied");
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "100.00",
        hasLink: true,
        linkAmount: null,
      }),
    ).toBe("tied");
  });

  it("ties a Stripe-settled gift through its own counted ledger row", () => {
    // Post-flip: a Stripe gift ties via a real counted Stripe ledger row +
    // amount compare (the applier resolves `linkAmount` to the Stripe sum when
    // no QB row exists), NOT via the removed amount-blind source shortcut.
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "100.00",
        hasLink: true,
        linkAmount: "100.00",
      }),
    ).toBe("tied");
  });

  it("marks an on-books gift with no counted evidence as missing", () => {
    expect(
      deriveGiftQbTie({
        offBooks: false,
        giftAmount: "100.00",
        hasLink: false,
        linkAmount: null,
      }),
    ).toBe("missing");
  });
});
