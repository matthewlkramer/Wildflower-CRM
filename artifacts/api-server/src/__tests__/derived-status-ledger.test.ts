import { describe, expect, it } from "vitest";
import { deriveStripeChargeStatus } from "../lib/derivedStatus";

describe("deriveStripeChargeStatus", () => {
  it("gives exclusion precedence over ledger relationships", () => {
    expect(
      deriveStripeChargeStatus({
        exclusionReason: "non_donation",
        hasProposedApplication: true,
        hasConfirmedApplication: true,
      }),
    ).toBe("excluded");
  });

  it("derives a system proposal from a proposed application", () => {
    expect(
      deriveStripeChargeStatus({
        exclusionReason: null,
        hasProposedApplication: true,
        hasConfirmedApplication: false,
      }),
    ).toBe("match_proposed");
  });

  it("derives a confirmed match only from a confirmed application", () => {
    expect(
      deriveStripeChargeStatus({
        exclusionReason: null,
        hasProposedApplication: false,
        hasConfirmedApplication: true,
      }),
    ).toBe("match_confirmed");
  });

  it("keeps a charge pending when it has no active ledger relationship", () => {
    expect(
      deriveStripeChargeStatus({
        exclusionReason: null,
        hasProposedApplication: false,
        hasConfirmedApplication: false,
      }),
    ).toBe("pending");
  });

  it("temporarily supports pointer facts for legacy in-memory callers", () => {
    expect(
      deriveStripeChargeStatus({
        exclusionReason: null,
        autoApplied: false,
        matchConfirmedAt: null,
        matchedGiftId: "gift_legacy",
        createdGiftId: null,
      }),
    ).toBe("match_confirmed");
  });
});
