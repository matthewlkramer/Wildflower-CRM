import { describe, expect, it } from "vitest";
import { pledgePaymentBlockedReason } from "./gift-column-dialogs";

describe("pledge payment eligibility", () => {
  it("accepts finalized verbal pledges", () => {
    expect(
      pledgePaymentBlockedReason(
        {
          id: "verbal",
          pledgeCommittedAt: "2026-01-15",
          commitmentPath: "verbal_pledge",
          writtenPledge: false,
          loanOrGrant: "grant",
        } as any,
        true,
      ),
    ).toBeNull();
  });

  it("blocks an opportunity that is not yet a pledge", () => {
    expect(
      pledgePaymentBlockedReason(
        {
          id: "open",
          pledgeCommittedAt: null,
          commitmentPath: null,
          writtenPledge: false,
          loanOrGrant: "grant",
        } as any,
        true,
      ),
    ).toContain("finalize it as a written or verbal pledge");
  });
});
