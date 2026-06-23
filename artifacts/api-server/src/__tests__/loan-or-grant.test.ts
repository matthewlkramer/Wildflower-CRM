import { describe, it, expect } from "vitest";
import {
  legacyCategoryToLoanOrGrant,
  loanOrGrantToLegacyCategory,
  giftTypeToLoanOrGrant,
} from "@workspace/api-zod";

// Pure 1:1 mappers backing the loan_or_grant transition. These guard the
// semantic contract: only loan_capital / loan_fund_investment are loans, and
// "grant" is the catch-all for ALL non-loan money.
describe("loan_or_grant mappers", () => {
  it("legacyCategoryToLoanOrGrant: only loan_capital is a loan", () => {
    expect(legacyCategoryToLoanOrGrant("loan_capital")).toBe("loan");
    expect(legacyCategoryToLoanOrGrant("revenue")).toBe("grant");
    expect(legacyCategoryToLoanOrGrant(null)).toBe("grant");
    expect(legacyCategoryToLoanOrGrant(undefined)).toBe("grant");
    expect(legacyCategoryToLoanOrGrant("something_unexpected")).toBe("grant");
  });

  it("loanOrGrantToLegacyCategory: only loan maps back to loan_capital", () => {
    expect(loanOrGrantToLegacyCategory("loan")).toBe("loan_capital");
    expect(loanOrGrantToLegacyCategory("grant")).toBe("revenue");
    expect(loanOrGrantToLegacyCategory(null)).toBe("revenue");
    expect(loanOrGrantToLegacyCategory(undefined)).toBe("revenue");
  });

  it("category round-trips through loan_or_grant losslessly", () => {
    for (const c of ["revenue", "loan_capital"] as const) {
      expect(loanOrGrantToLegacyCategory(legacyCategoryToLoanOrGrant(c))).toBe(c);
    }
  });

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
