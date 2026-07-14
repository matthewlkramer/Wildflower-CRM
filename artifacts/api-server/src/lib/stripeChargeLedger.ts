import type { db } from "@workspace/db";
import { paymentApplications, stripeStagedCharges } from "@workspace/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";

 type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
 type DbLike = typeof db | Tx;

export interface StripeChargeGiftRelationship {
  chargeId: string;
  giftId: string;
  lifecycle: "proposed" | "confirmed" | "exempt";
  createdTheGift: boolean;
  amountApplied: string | null;
}

/**
 * Correlated expression for the one active counted gift relationship owned by a
 * Stripe charge. The database uniqueness invariant guarantees at most one row.
 * Confirmed relationships sort ahead of proposed relationships during the
 * migration window, though a charge should never carry both.
 */
export function stripeChargeActiveGiftIdSql(
  chargeIdSql: SQL = sql.raw('"stripe_staged_charges"."id"'),
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.gift_id
    FROM payment_applications pa
    WHERE pa.stripe_charge_id = ${chargeIdSql}
      AND pa.evidence_source = 'stripe'
      AND pa.link_role = 'counted'
      AND pa.lifecycle IN ('proposed', 'confirmed')
    ORDER BY CASE WHEN pa.lifecycle = 'confirmed' THEN 0 ELSE 1 END,
             pa.updated_at DESC,
             pa.id
    LIMIT 1
  )`;
}

/** Confirmed owner only; use this for money, refunds, and permanent displays. */
export function stripeChargeConfirmedGiftIdSql(
  chargeIdSql: SQL = sql.raw('"stripe_staged_charges"."id"'),
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.gift_id
    FROM payment_applications pa
    WHERE pa.stripe_charge_id = ${chargeIdSql}
      AND pa.evidence_source = 'stripe'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
    ORDER BY pa.updated_at DESC, pa.id
    LIMIT 1
  )`;
}

export async function getStripeChargeGiftRelationship(
  dbi: DbLike,
  chargeId: string,
  options: { includeProposed?: boolean; lockCharge?: boolean } = {},
): Promise<StripeChargeGiftRelationship | null> {
  if (options.lockCharge) {
    await dbi
      .select({ id: stripeStagedCharges.id })
      .from(stripeStagedCharges)
      .where(eq(stripeStagedCharges.id, chargeId))
      .for("update");
  }

  const lifecycles = options.includeProposed
    ? sql`${paymentApplications.lifecycle} IN ('proposed', 'confirmed')`
    : eq(paymentApplications.lifecycle, "confirmed");

  const row = await dbi
    .select({
      chargeId: paymentApplications.stripeChargeId,
      giftId: paymentApplications.giftId,
      lifecycle: paymentApplications.lifecycle,
      createdTheGift: paymentApplications.createdTheGift,
      amountApplied: paymentApplications.amountApplied,
    })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.stripeChargeId, chargeId),
        eq(paymentApplications.evidenceSource, "stripe"),
        eq(paymentApplications.linkRole, "counted"),
        lifecycles,
      ),
    )
    .orderBy(
      sql`CASE WHEN ${paymentApplications.lifecycle} = 'confirmed' THEN 0 ELSE 1 END`,
      sql`${paymentApplications.updatedAt} DESC`,
      paymentApplications.id,
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (!row?.chargeId) return null;
  return {
    chargeId: row.chargeId,
    giftId: row.giftId,
    lifecycle: row.lifecycle,
    createdTheGift: row.createdTheGift,
    amountApplied: row.amountApplied,
  };
}
