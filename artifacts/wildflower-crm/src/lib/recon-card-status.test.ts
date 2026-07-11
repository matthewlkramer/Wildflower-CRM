import { describe, expect, it } from "vitest";
import { deriveCardStatus, isSettledGiftLink } from "./reconciliation";

describe("deriveCardStatus — 3-state match status", () => {
  it("returns 'none' when there is neither a donor nor a gift candidate", () => {
    expect(deriveCardStatus({ giftState: "none" }).key).toBe("none");
    expect(deriveCardStatus({}).key).toBe("none");
  });

  it("returns 'proposal' when the matcher proposed a donor (create-gift candidate)", () => {
    expect(
      deriveCardStatus({ proposedDonorName: "Jane Doe", giftState: "none" })
        .key,
    ).toBe("proposal");
    expect(
      deriveCardStatus({ proposedDonorId: "org_1", giftState: "none" }).key,
    ).toBe("proposal");
  });

  it("returns 'proposal' for a proposed / determined / ambiguous gift candidate", () => {
    expect(
      deriveCardStatus({ proposedGiftId: "gift_1", giftState: "determined" })
        .key,
    ).toBe("proposal");
    expect(deriveCardStatus({ giftState: "determined" }).key).toBe("proposal");
    expect(deriveCardStatus({ giftState: "ambiguous" }).key).toBe("proposal");
  });

  it("returns 'matched' whenever the card has a resolved gift, regardless of amounts", () => {
    expect(
      deriveCardStatus({ resolvedGiftId: "gift_1", giftState: "determined" })
        .key,
    ).toBe("matched");
    // Amount divergence does NOT change the status — bucketing handles that.
    expect(
      deriveCardStatus({ resolvedGiftId: "gift_1", giftState: "none" }).key,
    ).toBe("matched");
  });

  it("resolved gift wins over any lingering proposal fields", () => {
    expect(
      deriveCardStatus({
        resolvedGiftId: "gift_1",
        proposedGiftId: "gift_2",
        proposedDonorId: "org_1",
        giftState: "ambiguous",
      }).key,
    ).toBe("matched");
  });
});

describe("isSettledGiftLink — review-column bucketing", () => {
  it("is false without a resolved gift (nothing to settle)", () => {
    expect(isSettledGiftLink({})).toBe(false);
    expect(
      isSettledGiftLink({ resolvedGiftAmount: "100.00", amount: "100.00" }),
    ).toBe(false);
  });

  it("settled on an exact amount match", () => {
    expect(
      isSettledGiftLink({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "200.00",
        amount: "200.00",
      }),
    ).toBe(true);
  });

  it("settled within the fee band (10% + $1) — processor fee, not a split", () => {
    // gift 200 gross vs deposit 190.40 net.
    expect(
      isSettledGiftLink({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "200.00",
        amount: "190.40",
      }),
    ).toBe(true);
  });

  it("NOT settled when the gift is bigger than the deposit (partial payment stays in review)", () => {
    expect(
      isSettledGiftLink({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "1000.00",
        amount: "250.00",
      }),
    ).toBe(false);
  });

  it("NOT settled when the deposit is bigger than the gift (covers more than this gift)", () => {
    expect(
      isSettledGiftLink({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "250.00",
        amount: "1000.00",
      }),
    ).toBe(false);
  });

  it("uses the group total (not the representative row) for grouped cards", () => {
    // Representative row is only $250 but the group sums to $1000 = the gift.
    expect(
      isSettledGiftLink({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: "1000.00",
        amount: "250.00",
        sourceGroupTotalAmount: "1000.00",
      }),
    ).toBe(true);
  });

  it("falls back to settled when amounts are missing/unparseable", () => {
    expect(
      isSettledGiftLink({
        resolvedGiftId: "gift_1",
        resolvedGiftAmount: null,
        amount: null,
      }),
    ).toBe(true);
  });
});
