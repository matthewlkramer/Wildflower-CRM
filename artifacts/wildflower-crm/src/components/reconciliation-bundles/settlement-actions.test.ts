import { describe, expect, it } from "vitest";
import { apiErrorHasIssue } from "./settlement-actions";

describe("apiErrorHasIssue", () => {
  it("finds a nested consistency-gate issue", () => {
    const err = {
      status: 409,
      data: {
        error: "consistency_gate",
        details: {
          issues: [
            {
              code: "gift_already_stripe_sourced",
              message: "Already sourced",
            },
          ],
        },
      },
    };

    expect(apiErrorHasIssue(err, "gift_already_stripe_sourced")).toBe(true);
    expect(apiErrorHasIssue(err, "gift_already_qb_linked")).toBe(false);
  });

  it("returns false for ordinary API errors", () => {
    expect(
      apiErrorHasIssue(
        { status: 409, data: { error: "not_pending" } },
        "gift_already_stripe_sourced",
      ),
    ).toBe(false);
  });
});
