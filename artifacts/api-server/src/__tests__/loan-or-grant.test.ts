import { describe, it, expect } from "vitest";
import {
  giftTypeToLoanOrGrant,
} from "@workspace/api-zod";

// Pure mapper backing the loan_or_grant classification. Guards the semantic
// contract: only loan_fund_investment is a loan, and "grant" is the catch-all
// for ALL non-loan money.
describe("loan_or_grant mappers", () => {
  it("giftTypeToLoanOrGrant: only loan_fund_investment is a loan", () => {
    expect(giftTypeToLoanOrGrant("loan_fund_investment")).toBe("loan");
    for (const t of [
      "standard_gift",
      "pledge_payment",
      "directed_gift",
      "matching_gift",
    ]) {
      expect(giftTypeToLoanOrGrant(t)).toBe("grant");
    }
    expect(giftTypeToLoanOrGrant(null)).toBe("grant");
    expect(giftTypeToLoanOrGrant(undefined)).toBe("grant");
  });
});
