import { describe, it, expect } from "vitest";
import { derivePayoutLanes } from "../lib/reconciliationLanes";

// `derivePayoutLanes` reads plain payout settlement facts: whether a QBO lump
// carries the payout's pairing fact (settled_stripe_payout_id) and whether the
// payout is a negative-amount withdrawal. A batch payout has no CRM record of
// its own, so crmRecord is always null.

describe("derivePayoutLanes (pairing-fact-sourced)", () => {
  it("crmRecord is always null for a batch payout", () => {
    expect(
      derivePayoutLanes({ settled: false, withdrawal: false }).crmRecord,
    ).toBeNull();
    expect(
      derivePayoutLanes({ settled: true, withdrawal: false }).crmRecord,
    ).toBeNull();
  });

  it("unpaired, non-withdrawal reads funding=unlinked", () => {
    expect(
      derivePayoutLanes({ settled: false, withdrawal: false }).funding,
    ).toBe("unlinked");
  });

  it("a settled pairing reads funding=confirmed", () => {
    expect(
      derivePayoutLanes({ settled: true, withdrawal: false }).funding,
    ).toBe("confirmed");
  });

  it("an unpaired withdrawal reads funding=exempt", () => {
    expect(
      derivePayoutLanes({ settled: false, withdrawal: true }).funding,
    ).toBe("exempt");
  });

  it("a settled withdrawal still reads confirmed (pairing wins)", () => {
    expect(derivePayoutLanes({ settled: true, withdrawal: true }).funding).toBe(
      "confirmed",
    );
  });
});
