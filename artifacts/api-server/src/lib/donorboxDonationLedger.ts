import type { db } from "@workspace/db";
import { donorboxDonations, paymentApplications } from "@workspace/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

export interface DonorboxDonationGiftRelationship {
  donationId: string;
  giftId: string;
  lifecycle: "proposed" | "confirmed" | "exempt";
  createdTheGift: boolean;
  amountApplied: string | null;
}

/**
 * Active unit-to-gift relationship for a non-Stripe Donorbox donation.
 * Confirmed rows sort ahead of proposed rows during the migration window.
 */
export function donorboxDonationActiveGiftIdSql(
  donationIdSql: SQL = sql.raw('"donorbox_donations"."id"'),
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.gift_id
    FROM payment_applications pa
    WHERE pa.donorbox_donation_id = ${donationIdSql}
      AND pa.evidence_source = 'donorbox'
      AND pa.link_role = 'counted'
      AND pa.lifecycle IN ('proposed', 'confirmed')
    ORDER BY CASE WHEN pa.lifecycle = 'confirmed' THEN 0 ELSE 1 END,
             pa.updated_at DESC,
             pa.id
    LIMIT 1
  )`;
}

/** Confirmed owner only; use for money, permanent displays, and reversals. */
export function donorboxDonationConfirmedGiftIdSql(
  donationIdSql: SQL = sql.raw('"donorbox_donations"."id"'),
): SQL<string | null> {
  return sql<string | null>`(
    SELECT pa.gift_id
    FROM payment_applications pa
    WHERE pa.donorbox_donation_id = ${donationIdSql}
      AND pa.evidence_source = 'donorbox'
      AND pa.link_role = 'counted'
      AND pa.lifecycle = 'confirmed'
    ORDER BY pa.updated_at DESC, pa.id
    LIMIT 1
  )`;
}

export async function getDonorboxDonationGiftRelationship(
  dbi: DbLike,
  donationId: string,
  options: { includeProposed?: boolean; lockDonation?: boolean } = {},
): Promise<DonorboxDonationGiftRelationship | null> {
  if (options.lockDonation) {
    await dbi
      .select({ id: donorboxDonations.id })
      .from(donorboxDonations)
      .where(eq(donorboxDonations.id, donationId))
      .for("update");
  }

  const lifecycleCondition = options.includeProposed
    ? sql`${paymentApplications.lifecycle} IN ('proposed', 'confirmed')`
    : eq(paymentApplications.lifecycle, "confirmed");

  const row = await dbi
    .select({
      donationId: paymentApplications.donorboxDonationId,
      giftId: paymentApplications.giftId,
      lifecycle: paymentApplications.lifecycle,
      createdTheGift: paymentApplications.createdTheGift,
      amountApplied: paymentApplications.amountApplied,
    })
    .from(paymentApplications)
    .where(
      and(
        eq(paymentApplications.donorboxDonationId, donationId),
        eq(paymentApplications.evidenceSource, "donorbox"),
        eq(paymentApplications.linkRole, "counted"),
        lifecycleCondition,
      ),
    )
    .orderBy(
      sql`CASE WHEN ${paymentApplications.lifecycle} = 'confirmed' THEN 0 ELSE 1 END`,
      sql`${paymentApplications.updatedAt} DESC`,
      paymentApplications.id,
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (!row?.donationId) return null;
  return {
    donationId: row.donationId,
    giftId: row.giftId,
    lifecycle: row.lifecycle,
    createdTheGift: row.createdTheGift,
    amountApplied: row.amountApplied,
  };
}
