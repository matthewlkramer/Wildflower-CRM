import { describe, expect, it } from "vitest";
import { accountingPostingLabel } from "./payment-evidence";

describe("accountingPostingLabel", () => {
  it("flags bank-sourced payment evidence without an accounting record", () => {
    expect(accountingPostingLabel({ stagedPaymentId: null })).toBe(
      "Not Yet Posted",
    );
  });

  it("does not flag payment evidence backed by an imported accounting record", () => {
    expect(
      accountingPostingLabel({ stagedPaymentId: "staged_123" }),
    ).toBeNull();
  });
});
