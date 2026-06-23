/**
 * loan_or_grant mappers — the single authoritative loan-vs-grant classification.
 *
 * ENV-NEUTRAL: this module is imported by BOTH the API server (dual-write +
 * analytics) and the browser (read-only display). It must contain NO node /
 * DOM / URL globals and NO database imports — pure data + pure functions only.
 *
 * `loan_or_grant` ('loan' | 'grant') supersedes two scattered legacy signals
 * during the transition:
 *   - opportunities_and_pledges.fundraising_category ('revenue' | 'loan_capital')
 *   - gifts_and_payments.type (loan-ness was derived from 'loan_fund_investment')
 *   - fiscal_year_entity_goals.category (= fundraising_category)
 *
 * Mapping (1:1, lossless):
 *   loan_capital / loan_fund_investment  → 'loan'
 *   revenue / every other gift type      → 'grant'
 *
 * NOTE: 'grant' means ALL non-loan money — individual donations, foundation
 * grants, earned revenue, … — NOT literally only grants.
 */

export const LOAN_OR_GRANT_VALUES = ["loan", "grant"] as const;
export type LoanOrGrant = (typeof LOAN_OR_GRANT_VALUES)[number];

/**
 * Legacy opportunity/goal `fundraising_category` → authoritative `loan_or_grant`.
 * Only 'loan_capital' is a loan; everything else (including null/undefined,
 * which the DB stores as the 'revenue' default) maps to 'grant'.
 */
export function legacyCategoryToLoanOrGrant(
  category: string | null | undefined,
): LoanOrGrant {
  return category === "loan_capital" ? "loan" : "grant";
}

/**
 * Authoritative `loan_or_grant` → legacy `fundraising_category`. Used for the
 * reverse dual-write / rollback direction once reads flip to loan_or_grant.
 */
export function loanOrGrantToLegacyCategory(
  flag: string | null | undefined,
): "revenue" | "loan_capital" {
  return flag === "loan" ? "loan_capital" : "revenue";
}

/**
 * Gift `type` → authoritative `loan_or_grant`. Only 'loan_fund_investment' is a
 * loan; every other gift type (and null/undefined) maps to 'grant'.
 */
export function giftTypeToLoanOrGrant(
  giftType: string | null | undefined,
): LoanOrGrant {
  return giftType === "loan_fund_investment" ? "loan" : "grant";
}
