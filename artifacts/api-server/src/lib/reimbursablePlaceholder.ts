import { db } from "@workspace/db";
import {
  giftsAndPayments,
  opportunitiesAndPledges,
  pledgeAllocations,
} from "@workspace/db/schema";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  qbLedgerExistsForGift,
  stripeLedgerExistsForGift,
  donorboxLedgerExistsForGift,
} from "./paymentApplications";

// A reimbursable grant is a PLEDGE: the funder reimburses real expenses over
// time, so each real QuickBooks / Stripe check must be booked as its own 1:1
// gift payment — never as a single placeholder gift for the full award amount
// (see .agents/memory/reimbursable-grant-payment-model.md). Migration 0101
// archives the historical placeholder award gifts; these helpers are the
// forward-looking guardrail that flags one before (or after) it is created so a
// user is nudged to book the real reimbursement checks instead.

/**
 * EXISTS a reimbursable pledge allocation for the given opportunity. `oppIdSql`
 * is a pre-qualified SQL expression for the opportunity id in the caller's
 * query (e.g. `sql`${opportunitiesAndPledges.id}`` or `sql`o.id``).
 */
export function reimbursablePledgeExistsSql(oppIdSql: SQL): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${pledgeAllocations} pa
    WHERE pa.pledge_or_opportunity_id = ${oppIdSql}
      AND pa.conditional = 'reimbursable'
  )`;
}

/**
 * True when a gift exactly matches the placeholder "award-lump" signature that
 * migration 0101 cleans up: an active gift on a reimbursable pledge whose amount
 * equals the full positive awarded_amount, that is the SOLE active gift on that
 * pledge, carries NO settlement evidence (no QB / Stripe / Donorbox ledger row,
 * no legacy final-amount pointer), and is not entangled in a match / overpay
 * relationship. The guard mirrors 0101 exactly so a legitimate 1:1 reimbursement
 * payment gift (one of several real checks, or one with linked evidence) never
 * trips the warning. Non-blocking — purely surfaced to the UI as a nudge.
 */
export async function isReimbursablePlaceholderGift(
  giftId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      warn: sql<boolean>`(
        ${giftsAndPayments.amount} IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ${opportunitiesAndPledges} o
          WHERE o.id = ${giftsAndPayments.opportunityId}
            AND o.awarded_amount IS NOT NULL
            AND o.awarded_amount > 0
            AND ${giftsAndPayments.amount} = o.awarded_amount
            AND ${reimbursablePledgeExistsSql(sql`o.id`)}
        )
        AND (
          SELECT count(*) FROM ${giftsAndPayments} g2
          WHERE g2.opportunity_id = ${giftsAndPayments.opportunityId}
            AND g2.archived_at IS NULL
        ) = 1
        AND ${giftsAndPayments.giftBeingMatchedId} IS NULL
        AND ${giftsAndPayments.overpayOfGiftId} IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${giftsAndPayments} g3
          WHERE g3.gift_being_matched_id = ${giftsAndPayments.id}
             OR g3.overpay_of_gift_id = ${giftsAndPayments.id}
        )
        AND NOT ${qbLedgerExistsForGift()}
        AND NOT ${stripeLedgerExistsForGift()}
        AND NOT ${donorboxLedgerExistsForGift()}
      )`,
    })
    .from(giftsAndPayments)
    .where(
      and(eq(giftsAndPayments.id, giftId), isNull(giftsAndPayments.archivedAt)),
    );
  return row?.warn ?? false;
}
