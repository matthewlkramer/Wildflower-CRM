import { alias } from "drizzle-orm/pg-core";
import { and, eq, isNull, notExists, type SQL, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  giftsAndPayments,
  opportunitiesAndPledges,
  pledgeAllocations,
} from "@workspace/db/schema";
import { getGiftPaymentSummary } from "./giftPaymentSummary";
import type { Tx } from "./reconciliationCommit";

/**
 * AUDIT-CLOSE RESOLUTION HELPERS.
 *
 * Once a fiscal year's audit closes, the audited ledger rows are frozen, so a
 * post-close amount mismatch can NEVER be corrected in place. Instead it is
 * booked as a NEW linked record in the current open FY (see the gift-booking-
 * lifecycle / audit-close model):
 *   - under-paid pledge → a new offsetting WRITE-OFF pledge with negative
 *     allocations summing to the uncollected remainder, linked back via
 *     `write_off_of_pledge_id`;
 *   - over-paid gift → a new gift for the surplus, linked back via
 *     `overpay_of_gift_id`.
 *
 * The original row is NEVER mutated. It reads as "resolved" purely because an
 * active linked child exists — which is exactly what the exclusion conditions
 * below express (so the pre-close checklist stops flagging it forever).
 */

/**
 * Split a positive `remainder` (a 2-decimal dollar amount) across `weights`
 * proportionally, returning one NEGATIVE 2-decimal string per weight whose sum
 * is EXACTLY `-remainder`. All arithmetic is done in integer cents; any rounding
 * drift is absorbed by the LAST bucket so the pieces always reconcile to the
 * whole (no lost or created cents). Pure — safe to unit-test.
 *
 * Callers must pass only positive-weight buckets (weight = the original
 * allocation's sub_amount); a non-positive total weight throws, because a
 * remainder > 0 always implies at least one positive-weight bucket.
 */
export function proRataNegativeShares(
  weights: number[],
  remainder: number,
): string[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) {
    throw new Error("proRataNegativeShares: total weight must be > 0");
  }
  const remainderCents = Math.round(remainder * 100);
  const out: string[] = [];
  let allocated = 0;
  for (let i = 0; i < weights.length; i++) {
    const isLast = i === weights.length - 1;
    const cents = isLast
      ? remainderCents - allocated
      : Math.round((remainderCents * weights[i]) / totalWeight);
    if (!isLast) allocated += cents;
    out.push((-cents / 100).toFixed(2));
  }
  return out;
}

/**
 * A gift's over-payment surplus, DERIVED server-side (never trusted from the
 * client): the settled evidence gross (per-source precedence, via
 * `getGiftPaymentSummary`) minus the recorded gift amount, rounded to whole
 * cents. Positive = the donor paid MORE than the recorded gift → that surplus
 * is booked as a new gift. Zero or negative means there is nothing to resolve
 * via the overpay path (an under-payment is a pledge write-off instead).
 */
export async function computeGiftSurplus(
  tx: Tx,
  gift: { id: string; amount: string | null },
): Promise<number> {
  const { settledGross } = await getGiftPaymentSummary(tx, gift.id);
  const amount = Number(gift.amount ?? 0);
  return Math.round((settledGross - amount) * 100) / 100;
}

/**
 * Drizzle condition: the gift (correlated to the outer `gifts_and_payments`
 * row) has NO active over-payment child. Used to drop already-resolved gifts
 * from the unresolved-amount checklist so a post-close overpay is not flagged
 * forever. Uses an aliased self-join so the correlated column stays qualified
 * (avoids the bare-column sql-template footgun).
 */
export function giftHasNoActiveOverpayChild(): SQL {
  const child = alias(giftsAndPayments, "overpay_child");
  return notExists(
    db
      .select({ one: sql`1` })
      .from(child)
      .where(
        and(
          eq(child.overpayOfGiftId, giftsAndPayments.id),
          isNull(child.archivedAt),
        ),
      ),
  );
}

/**
 * A pledge's uncollected remainder, DERIVED server-side: committed (sum of the
 * pledge's allocation sub-amounts) minus paid (sum of non-archived linked gift
 * amounts), rounded to whole cents. This is the exact figure a post-close
 * write-off books as a negative offsetting pledge. It is NOT clamped — the
 * write-off route treats `<= 0` as "nothing to write off"; the detail view
 * clamps at 0 for display. Single source of truth for both callers so the
 * "write off remainder" action and its confirmed amount can never diverge.
 */
export async function computePledgeUncollectedRemainder(
  pledgeId: string,
): Promise<number> {
  const [{ committed } = { committed: "0" }] = await db
    .select({
      committed: sql<string>`COALESCE(SUM(${pledgeAllocations.subAmount}), 0)::text`,
    })
    .from(pledgeAllocations)
    .where(eq(pledgeAllocations.pledgeOrOpportunityId, pledgeId));
  const [{ paid } = { paid: "0" }] = await db
    .select({
      paid: sql<string>`COALESCE(SUM(${giftsAndPayments.amount}), 0)::text`,
    })
    .from(giftsAndPayments)
    .where(
      and(
        eq(giftsAndPayments.opportunityId, pledgeId),
        isNull(giftsAndPayments.archivedAt),
      ),
    );
  return Math.round((Number(committed) - Number(paid)) * 100) / 100;
}

/**
 * The active (non-archived) surplus gift that resolves an over-paid audited
 * gift, or null. Its mere existence is what makes the original read as
 * "resolved" post-close (the original stays amount_mismatch forever).
 */
export async function findActiveOverpayChildGiftId(
  giftId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: giftsAndPayments.id })
    .from(giftsAndPayments)
    .where(
      and(
        eq(giftsAndPayments.overpayOfGiftId, giftId),
        isNull(giftsAndPayments.archivedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * The active (non-archived) write-off pledge that resolves an under-paid
 * audited pledge, or null. Its existence is what makes the original read as
 * "resolved" in the underpaid checklist (the original is never mutated).
 */
export async function findActiveWriteOffChildPledgeId(
  pledgeId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: opportunitiesAndPledges.id })
    .from(opportunitiesAndPledges)
    .where(
      and(
        eq(opportunitiesAndPledges.writeOffOfPledgeId, pledgeId),
        isNull(opportunitiesAndPledges.archivedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}
