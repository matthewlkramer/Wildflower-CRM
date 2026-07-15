import { describe, expect, it } from "vitest";
import { deriveCardVerdict } from "../lib/reconciliationGate";

// Server-authoritative card verdict (ported from the retired client-side
// deriveCardStatus / isSettledGiftLink in wildflower-crm src/lib/reconciliation):
// the 3-state "Status:" line + the settled bucketing flag now ship on every
// ReconciliationCard so the workbench never re-derives settlement math.

describe("deriveCardVerdict — 3-state match status", () => {
  it("is none with no candidates", () => {
    expect(deriveCardVerdict({ giftState: "none" }).status).toBe("none");
    expect(deriveCardVerdict({}).status).toBe("none");
  });

  it("is proposal when a donor candidate exists", () => {
    expect(
      deriveCardVerdict({ proposedDonorName: "Jane Doe", giftState: "none" })
        .status,
    ).toBe("proposal");
    expect(
      deriveCardVerdict({ proposedDonorId: "org_1", giftState: "none" }).status,
    ).toBe("proposal");
  });

  it("is proposal when a gift candidate exists", () => {
    expect(
      deriveCardVerdict({ proposedGiftId: "gift_1", giftState: "determined" })
        .status,
    ).toBe("proposal");
    expect(deriveCardVerdict({ giftState: "determined" }).status).toBe(
      "proposal",
    );
    expect(deriveCardVerdict({ giftState: "ambiguous" }).status).toBe(
      "proposal",
    );
  });

  it("is matched when a resolved gift exists — regardless of edge state", () => {
    expect(
      deriveCardVerdict({ resolvedGiftId: "gift_1", giftState: "determined" })
        .status,
    ).toBe("matched");
    expect(
      deriveCardVerdict({ resolvedGiftId: "gift_1", giftState: "none" }).status,
    ).toBe("matched");
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        proposedDonorName: "Jane Doe",
        giftState: "ambiguous",
      }).status,
    ).toBe("matched");
  });
});

describe("deriveCardVerdict — settled bucketing", () => {
  it("is never settled without a resolved gift", () => {
    expect(deriveCardVerdict({}).settled).toBe(false);
    expect(
      deriveCardVerdict({ resolvedGiftAmount: "100.00", amount: "100.00" })
        .settled,
    ).toBe(false);
    expect(
      deriveCardVerdict({ proposedGiftId: "gift_1", amount: "100.00" }).settled,
    ).toBe(false);
  });

  it("settles an exact-amount resolved gift", () => {
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "100.00",
        amount: "100.00",
      }).settled,
    ).toBe(true);
  });

  it("treats unknown amounts as settled (no discrepancy to review)", () => {
    expect(
      deriveCardVerdict({ resolvedGiftId: "gift_1", amount: "100.00" }).settled,
    ).toBe(true);
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "100.00",
      }).settled,
    ).toBe(true);
  });

  it("settles a gift within the QB fee band (up to 10% + $1 above evidence)", () => {
    // gift = evidence * 1.1 + 1 exactly — the band's upper edge.
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "111.00",
        amount: "100.00",
      }).settled,
    ).toBe(true);
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "111.01",
        amount: "100.00",
      }).settled,
    ).toBe(false);
  });

  it("does NOT settle a gift below the evidence (asymmetric gate band)", () => {
    // The retired client check was symmetric (a $90 gift on a $100 deposit
    // counted as settled); the gate band is authoritative and asymmetric —
    // the gift must cover the evidence.
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "90.00",
        amount: "100.00",
      }).settled,
    ).toBe(false);
  });

  it("uses the group total for a group card (ignoring the representative's own amount)", () => {
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "300.00",
        amount: "100.00",
        sourceGroupTotalAmount: "300.00",
      }).settled,
    ).toBe(true);
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "100.00",
        amount: "100.00",
        sourceGroupTotalAmount: "300.00",
      }).settled,
    ).toBe(false);
  });

  it("opens the [net, gross] window when a Stripe charge backs the money", () => {
    // Gift booked at the NET behind a gross-amount charge — settled via the
    // known-net window (the QB-only band would reject it: 104.00 < 104.42).
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "104.00",
        amount: "104.42",
        stripeGrossAmount: "104.42",
        stripeNetAmount: "104.00",
      }).settled,
    ).toBe(true);
    // Below the net → outside the window.
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "103.50",
        amount: "104.42",
        stripeGrossAmount: "104.42",
        stripeNetAmount: "104.00",
      }).settled,
    ).toBe(false);
  });

  it("never applies a per-charge net to a group card", () => {
    // A group reconciles for its combined total with the plain QB band; a
    // stray net must not open a window around the wrong number.
    expect(
      deriveCardVerdict({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "150.00",
        amount: "100.00",
        sourceGroupTotalAmount: "300.00",
        stripeNetAmount: "150.00",
      }).settled,
    ).toBe(false);
  });
});
