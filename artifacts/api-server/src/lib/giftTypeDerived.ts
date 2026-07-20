import { sql, type SQL } from "drizzle-orm";
import { giftsAndPayments } from "@workspace/db/schema";

/**
 * SQL CASE expression that derives the gift `type` from the gift row's link
 * columns, replacing the retired stored `type` column (Task #451).
 *
 * Precedence (most-specific wins):
 *   loan_fund_investment — loan_or_grant = 'loan' (authoritative; wins even
 *                          when opportunity_id is set, e.g. a reimbursable
 *                          loan pledge payment stays as loan_fund_investment).
 *   matching_gift        — gift_being_matched_id IS NOT NULL
 *   directed_gift        — advisor_person_id IS NOT NULL
 *   reimbursement        — opportunity_id linked to a pledge with a
 *                          conditional='reimbursable' allocation.
 *   pledge_payment       — opportunity_id IS NOT NULL (non-reimbursable pledge).
 *   standard_gift        — else (outright donation, no special links).
 *
 * Uses Drizzle column references that Drizzle qualifies as
 * "gifts_and_payments"."<col>" — safe only in an UN-ALIASED
 * .from(giftsAndPayments). Callers that alias the table must supply raw SQL
 * strings instead.
 */
export function deriveGiftTypeExpr(): SQL<string> {
  return sql<string>`CASE
    WHEN ${giftsAndPayments.loanOrGrant} = 'loan' THEN 'loan_fund_investment'
    WHEN ${giftsAndPayments.giftBeingMatchedId} IS NOT NULL THEN 'matching_gift'
    WHEN ${giftsAndPayments.advisorPersonId} IS NOT NULL THEN 'directed_gift'
    WHEN ${giftsAndPayments.opportunityId} IS NOT NULL AND EXISTS (
      SELECT 1 FROM pledge_allocations pall
      WHERE pall.pledge_or_opportunity_id = ${giftsAndPayments.opportunityId}
        AND pall.conditional = 'reimbursable'
    ) THEN 'reimbursement'
    WHEN ${giftsAndPayments.opportunityId} IS NOT NULL THEN 'pledge_payment'
    ELSE 'standard_gift'
  END`;
}
