import { describe, expect, it } from "vitest";
import { buildGiftPlacementPlan } from "./gift-placement";

const gift = { id: "gift_18", name: "Erica", amount: "18.00" } as any;
const deposit = {
  anchorId: "bdep_18",
  date: "2025-11-17",
  bank: { amount: "18.00" },
  composition: {
    kind: "stripe_payout",
    payoutId: "po_18",
    grossTotal: "20.00",
    feeTotal: "2.00",
    refundTotal: "0.00",
    adjustmentTotal: "0.00",
    netTotal: "18.00",
  },
  charges: [0, 1, 2, 3].map((index) => ({
    chargeId: `ch_${index}`,
    payerName: "Erica Cantoni",
    amount: "5.00",
    chargeDate: index < 3 ? "2025-11-13" : "2025-11-12",
    linkedGiftId: index === 0 ? "gift_18" : null,
    exclusionReason: null,
    refunded: false,
    disputed: false,
    amountRefunded: "0.00",
  })),
} as any;

describe("gift placement", () => {
  it("recognizes a net payout gift and includes the already-linked first charge", () => {
    const plan = buildGiftPlacementPlan(deposit, gift);
    expect(plan.targets).toHaveLength(4);
    expect(plan.split).toMatchObject({
      paymentCount: 4,
      grossAmount: "20.00",
      netAmount: "18.00",
      feeAmount: "2.00",
      giftMatches: "net",
    });
    expect(plan.targets[0]?.currentGiftId).toBe("gift_18");
    expect(plan.directTarget).toBeNull();
  });

  it("links directly only when one remaining payment exactly matches", () => {
    const one = {
      ...deposit,
      bank: { amount: "5.00" },
      composition: {
        kind: "stripe_payout",
        payoutId: "po_one",
        netTotal: "5.00",
      },
      charges: [
        {
          ...deposit.charges[0],
          linkedGiftId: null,
          amount: "5.00",
        },
      ],
    } as any;
    const plan = buildGiftPlacementPlan(one, {
      ...gift,
      amount: "5.00",
    } as any);
    expect(plan.directTarget?.anchor.id).toBe("ch_0");
  });
});
