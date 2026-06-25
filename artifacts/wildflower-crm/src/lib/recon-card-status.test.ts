import { describe, expect, it } from "vitest";
import { deriveCardStatus } from "./reconciliation";

describe("deriveCardStatus", () => {
  it("returns 'none' when there is neither a donor nor a gift", () => {
    expect(deriveCardStatus({ giftState: "none" }).key).toBe("none");
  });

  it("returns 'create_new' when a donor is present but no gift", () => {
    expect(
      deriveCardStatus({ proposedDonorName: "Jane Doe", giftState: "none" })
        .key,
    ).toBe("create_new");
    expect(
      deriveCardStatus({ proposedDonorId: "org_1", giftState: "none" }).key,
    ).toBe("create_new");
  });

  it("returns 'awaiting' for a proposed/ambiguous gift candidate", () => {
    expect(
      deriveCardStatus({ proposedGiftId: "gift_1", giftState: "determined" })
        .key,
    ).toBe("awaiting");
    expect(deriveCardStatus({ giftState: "ambiguous" }).key).toBe("awaiting");
  });

  it("treats an exact resolved-gift amount as confirmed", () => {
    expect(
      deriveCardStatus({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "200.00",
        amount: "200.00",
        giftState: "determined",
      }).key,
    ).toBe("confirmed");
  });

  it("treats a within-fee-band difference as confirmed (processor fee, not a split)", () => {
    // gift 200 gross vs deposit 190.40 net — inside the 10% + $1 band.
    expect(
      deriveCardStatus({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "200.00",
        amount: "190.40",
        giftState: "determined",
      }).key,
    ).toBe("confirmed");
  });

  it("flags a gift bigger than the deposit as a partial payment", () => {
    expect(
      deriveCardStatus({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "1000.00",
        amount: "250.00",
        giftState: "determined",
      }).key,
    ).toBe("partial");
  });

  it("flags a deposit bigger than the gift as covering multiple gifts", () => {
    expect(
      deriveCardStatus({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "250.00",
        amount: "1000.00",
        giftState: "determined",
      }).key,
    ).toBe("multiple");
  });

  it("uses the group total (not the representative row) for grouped cards", () => {
    // Representative row is only $250 but the group sums to $1000 = the gift,
    // so it is confirmed, not 'partial'.
    expect(
      deriveCardStatus({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "1000.00",
        amount: "250.00",
        sourceGroupTotalAmount: "1000.00",
        giftState: "determined",
      }).key,
    ).toBe("confirmed");
  });

  it("falls back to confirmed when amounts are missing/unparseable", () => {
    expect(
      deriveCardStatus({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: null,
        amount: null,
        giftState: "determined",
      }).key,
    ).toBe("confirmed");
  });
});
