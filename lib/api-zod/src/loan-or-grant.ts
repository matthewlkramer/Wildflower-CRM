/**
 * loan_or_grant mappers — the single authoritative loan-vs-grant classification.
 *
 * ENV-NEUTRAL: this module is imported by BOTH the API server and the browser.
 * It must contain NO node / DOM / URL globals and NO database imports — pure
 * data + pure functions only.
 *
 * `loan_or_grant` ('loan' | 'grant') is the SOLE classification signal.
 * NOTE: 'grant' means ALL non-loan money — individual donations, foundation
 * grants, earned revenue, … — NOT literally only grants.
 */

export const LOAN_OR_GRANT_VALUES = ["loan", "grant"] as const;
export type LoanOrGrant = (typeof LOAN_OR_GRANT_VALUES)[number];

/**
 * Gift `type` → authoritative `loan_or_grant`. Only 'loan_fund_investment' is a
 * loan; every other gift type (and null/undefined) maps to 'grant'.
 */
export function giftTypeToLoanOrGrant(
  giftType: string | null | undefined,
): LoanOrGrant {
  return giftType === "loan_fund_investment" ? "loan" : "grant";
}
