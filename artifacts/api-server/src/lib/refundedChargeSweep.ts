import { db } from "@workspace/db";
import {
  stagedPayments,
  stripeStagedCharges,
  settlementLinks,
} from "@workspace/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { logger } from "./logger";
import { stagedStatusWhere } from "./derivedStatus";

/**
 * Sweep: auto-exclude pending QuickBooks staged payments whose ENTIRE Stripe
 * trace is fully-refunded, never-booked money (`refunded_charge`).
 *
 * A QB deposit/payment row is only excludable when we can tie it to specific
 * Stripe charges — the "trace" is the union of:
 *   - the charges of any payout settlement-linked to this row as the deposit
 *     lump (`settlement_links.deposit_staged_payment_id`; a CONFIRMED link
 *     already derives the row match_confirmed, so in practice this covers
 *     proposed links), and
 *   - any per-charge QB ties naming this row (source_links rows with
 *     link_type='charge_qb_tie', confirmed or proposed lifecycle; the legacy
 *     pointer columns are retired).
 *
 * The row is excluded only when:
 *   - it is derived-pending AND auto-classified (a human resolve or a manual
 *     re-include pin is never clobbered), and
 *   - at least one traced charge is excluded as `refunded_charge`, and
 *   - NO traced charge is live money — every traced charge is excluded as
 *     `refunded_charge` (or `failed_charge`, which contributes no money).
 *
 * Deposits mixing refunded and live charges therefore stay in the queue as
 * real work. Runs after ties/links are established (end of the scheduled
 * Stripe sync, the historical backfill, and the proposal/tie passes) because
 * the refund fact arrives from the Stripe side, often later than QB ingest.
 * Idempotent and cheap (one guarded UPDATE); safe to call from any of those
 * hooks without extra locking.
 */
export async function sweepRefundedQbStagedPayments(): Promise<number> {
  // Union trace: does charge `c` (the base stripe_staged_charges table inside
  // the EXISTS subqueries below) record money behind this staged_payments row?
  const tracedToRow: SQL<boolean> = sql`(
    EXISTS (
      SELECT 1 FROM source_links srcl_tr
      WHERE srcl_tr.link_type = 'charge_qb_tie'
        AND srcl_tr.stripe_charge_id = "stripe_staged_charges"."id"
        AND srcl_tr.qb_staged_payment_id = "staged_payments"."id"
    )
    OR ${stripeStagedCharges.stripePayoutId} IN (
      SELECT ${settlementLinks.payoutId} FROM ${settlementLinks}
      WHERE ${settlementLinks.depositStagedPaymentId} = ${stagedPayments.id}
    )
  )`;

  const rows = await db
    .update(stagedPayments)
    .set({
      exclusionReason: "refunded_charge",
      updatedAt: new Date(),
    })
    .where(
      and(
        stagedStatusWhere.pending,
        eq(stagedPayments.classificationSource, "auto"),
        // ≥1 traced fully-refunded never-booked charge…
        sql`EXISTS (
          SELECT 1 FROM ${stripeStagedCharges}
          WHERE ${tracedToRow}
            AND ${stripeStagedCharges.exclusionReason} = 'refunded_charge'
        )`,
        // …and no traced charge that is still live money.
        sql`NOT EXISTS (
          SELECT 1 FROM ${stripeStagedCharges}
          WHERE ${tracedToRow}
            AND (
              ${stripeStagedCharges.exclusionReason} IS NULL
              OR ${stripeStagedCharges.exclusionReason} NOT IN ('refunded_charge', 'failed_charge')
            )
        )`,
      ),
    )
    .returning({ id: stagedPayments.id });

  if (rows.length > 0) {
    logger.info(
      { count: rows.length, ids: rows.map((r) => r.id) },
      "Refunded-charge sweep: excluded QB staged payments whose Stripe trace is fully refunded",
    );
  }
  return rows.length;
}
