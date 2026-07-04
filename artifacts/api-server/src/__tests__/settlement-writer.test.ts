import { describe, it, expect } from "vitest";
import {
  proposeSettlementLink,
  confirmSettlementLink,
} from "../lib/settlementWriter";

/**
 * Builder unit tests for the settlement-link INTENT constructors. These are the
 * only shapes any reconciliation write path expresses; `settlement_links` is the
 * authoritative store (the retired legacy `stripe_payouts.qb_reconciliation_status`
 * + pointer mirror columns these builders once fed have been dropped).
 */
describe("proposeSettlementLink", () => {
  it("builds a clean proposed link", () => {
    expect(proposeSettlementLink("dep_1", null)).toEqual({
      lifecycle: "proposed",
      provenance: "system",
      depositStagedPaymentId: "dep_1",
      conflictGiftId: null,
      confirmedByUserId: null,
      confirmedAt: null,
    });
  });

  it("carries the conflict gift when the deposit is already booked", () => {
    expect(proposeSettlementLink("dep_1", "gift_c")).toEqual({
      lifecycle: "proposed",
      provenance: "system",
      depositStagedPaymentId: "dep_1",
      conflictGiftId: "gift_c",
      confirmedByUserId: null,
      confirmedAt: null,
    });
  });
});

describe("confirmSettlementLink", () => {
  const AT = new Date("2026-03-15T08:00:00.000Z");

  it("builds a human confirmed link (real user ⇒ human provenance)", () => {
    expect(
      confirmSettlementLink({
        depositStagedPaymentId: "dep_1",
        conflictGiftId: null,
        confirmedByUserId: "user_1",
        confirmedAt: AT,
      }),
    ).toEqual({
      lifecycle: "confirmed",
      provenance: "human",
      depositStagedPaymentId: "dep_1",
      conflictGiftId: null,
      confirmedByUserId: "user_1",
      confirmedAt: AT,
    });
  });

  it("null confirmer ⇒ system_confirmed provenance", () => {
    const link = confirmSettlementLink({
      depositStagedPaymentId: "dep_1",
      conflictGiftId: null,
      confirmedByUserId: null,
      confirmedAt: AT,
    });
    expect(link.provenance).toBe("system_confirmed");
    expect(link.confirmedByUserId).toBeNull();
  });

  it("carries the kept gift as the confirmed 'keep' discriminator", () => {
    const link = confirmSettlementLink({
      depositStagedPaymentId: "dep_1",
      conflictGiftId: "gift_c",
      confirmedByUserId: "user_1",
      confirmedAt: AT,
    });
    expect(link.conflictGiftId).toBe("gift_c");
  });

  // A confirmed link MUST always carry an explicit non-null timestamp (the arg
  // type makes a null unrepresentable); prove it across all four confirm shapes.
  it("always stamps a non-null confirmedAt", () => {
    for (const confirmedByUserId of ["user_1", null] as const) {
      for (const conflictGiftId of ["gift_c", null] as const) {
        const link = confirmSettlementLink({
          depositStagedPaymentId: "dep_1",
          conflictGiftId,
          confirmedByUserId,
          confirmedAt: AT,
        });
        expect(link.confirmedAt).toEqual(AT);
      }
    }
  });
});
