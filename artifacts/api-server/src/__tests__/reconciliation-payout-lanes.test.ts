import { describe, it, expect } from "vitest";
import { derivePayoutLanes } from "../lib/reconciliationLanes";

// `derivePayoutLanes` reads the `settlement_links` mirror (its `lifecycle`) — the
// authoritative payout↔deposit store. A batch payout has no CRM record of its own;
// its funding lane is the link's lifecycle, or `unlinked` when there is no link.

describe("derivePayoutLanes (settlement_links-sourced)", () => {
  it("crmRecord is always null for a batch payout", () => {
    expect(derivePayoutLanes(null).crmRecord).toBeNull();
    expect(derivePayoutLanes({ lifecycle: "confirmed" }).crmRecord).toBeNull();
  });

  it("orphan (no link) reads funding=unlinked", () => {
    expect(derivePayoutLanes(null).funding).toBe("unlinked");
    expect(derivePayoutLanes(undefined).funding).toBe("unlinked");
  });

  it("maps lifecycle straight onto the funding lane", () => {
    expect(derivePayoutLanes({ lifecycle: "proposed" }).funding).toBe(
      "proposed",
    );
    expect(derivePayoutLanes({ lifecycle: "confirmed" }).funding).toBe(
      "confirmed",
    );
    expect(derivePayoutLanes({ lifecycle: "exempt" }).funding).toBe("exempt");
  });
});
