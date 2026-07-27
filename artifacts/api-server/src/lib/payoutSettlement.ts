import { db } from "@workspace/db";
import { sourceLinks } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = Tx | typeof db;

/**
 * The payout↔QBO-lump settlement pairing fact: a `payout_qb_settlement`
 * source_link (successor of `staged_payments.settled_stripe_payout_id`,
 * 0168). The deterministic per-payout id keeps one lump per payout; writers
 * additionally guard one payout per lump. Fill-only — nothing in production
 * clears the pairing.
 */
export function payoutSettlementLinkId(payoutId: string): string {
  return `srcl_pqs_${payoutId}`;
}

/**
 * Record the pairing fact, fill-only: an already-settled deposit row is never
 * re-pointed, and a payout already claimed by another row is never re-used
 * (deterministic id + ON CONFLICT DO NOTHING). Returns whether THIS call
 * created the pairing.
 */
export async function recordPayoutQbSettlement(
  tx: DbLike,
  args: { stagedPaymentId: string; payoutId: string },
): Promise<boolean> {
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO source_links (
      id, link_type, qb_staged_payment_id, stripe_payout_id,
      lifecycle, provenance, match_basis
    )
    SELECT
      ${payoutSettlementLinkId(args.payoutId)}, 'payout_qb_settlement',
      ${args.stagedPaymentId}, ${args.payoutId},
      'confirmed', 'system', 'settled_pairing'
    WHERE NOT EXISTS (
      SELECT 1 FROM source_links
      WHERE link_type = 'payout_qb_settlement'
        AND qb_staged_payment_id = ${args.stagedPaymentId}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** The payout the deposit row settles as the QBO lump, if any. */
export async function settledPayoutIdForDeposit(
  tx: DbLike,
  stagedPaymentId: string,
): Promise<string | null> {
  const row = await tx
    .select({ payoutId: sourceLinks.stripePayoutId })
    .from(sourceLinks)
    .where(
      and(
        eq(sourceLinks.linkType, "payout_qb_settlement"),
        eq(sourceLinks.qbStagedPaymentId, stagedPaymentId),
      ),
    )
    .then((r) => r[0]);
  return row?.payoutId ?? null;
}

/** The QBO lump (staged payment) settled against the payout, if any. */
export async function settledDepositIdForPayout(
  tx: DbLike,
  payoutId: string,
): Promise<string | null> {
  const row = await tx
    .select({ stagedPaymentId: sourceLinks.qbStagedPaymentId })
    .from(sourceLinks)
    .where(
      and(
        eq(sourceLinks.linkType, "payout_qb_settlement"),
        eq(sourceLinks.stripePayoutId, payoutId),
      ),
    )
    .then((r) => r[0]);
  return row?.stagedPaymentId ?? null;
}
