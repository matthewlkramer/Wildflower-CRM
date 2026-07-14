import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Regression coverage for the reported bug: every Stripe settlement bundle was
 * proposing to MINT a new gift even though the very same gift was sitting in the
 * system waiting to be matched — because it had already been booked from the
 * QuickBooks side.
 *
 * Root cause: the matcher's existing-gift window excluded ANY gift already claimed
 * by a staged_payments OR a stripe_staged_charges row, regardless of which channel
 * was doing the scoring. Stripe and QuickBooks are PARALLEL evidence for one gift,
 * so a Stripe charge landing on a gift a QuickBooks payment already booked is
 * expected, not a duplicate. The window is now anchor-kind-aware:
 *   - a Stripe CHARGE ("charge") excludes only gifts owned by another charge — a
 *     QB-linked gift stays a valid reconcile target.
 *   - a QuickBooks staged payment ("staged", the default) still excludes both, so
 *     the sync worker never double-links a gift its own channel already owns.
 *
 * Calls the real `scoreStagedPayment` / `scoreStripeCharge` against a live DB
 * (they read gifts / organizations / staged rows via SQL). Skips automatically
 * when no real DATABASE_URL is set.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `qbpe_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
// A distinctive, unlikely-to-collide name so the trigram name matcher resolves
// it unambiguously when we feed it as the payer name.
const ORG_NAME = `Zzyzx Parallel Evidence Trust ${RUN}`;
const GIFT_DATE = "2025-04-15";
// Two distinct amounts keep the QB-owned and charge-owned scenarios isolated.
const QB_GIFT_AMOUNT = "22222.00";
const CHARGE_GIFT_AMOUNT = "33333.00";

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  paymentApplications: Db["paymentApplications"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let scoreStagedPayment: (typeof import("../lib/quickbooksMatch"))["scoreStagedPayment"];
let scoreStripeCharge: (typeof import("../lib/stripeMatch"))["scoreStripeCharge"];

const seededGiftIds: string[] = [];
const seededStagedIds: string[] = [];
const seededChargeIds: string[] = [];
const qbGiftId = `${RUN}_gift_qb`;
const chargeGiftId = `${RUN}_gift_charge`;

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
    stagedPayments: dbMod.stagedPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    paymentApplications: dbMod.paymentApplications,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  scoreStagedPayment = (await import("../lib/quickbooksMatch")).scoreStagedPayment;
  scoreStripeCharge = (await import("../lib/stripeMatch")).scoreStripeCharge;

  await db.insert(schema.organizations).values({ id: ORG_ID, name: ORG_NAME });

  // A gift already BOOKED from QuickBooks (owned by a staged_payments row).
  await db.insert(schema.giftsAndPayments).values({
    id: qbGiftId,
    amount: QB_GIFT_AMOUNT,
    dateReceived: GIFT_DATE,
    organizationId: ORG_ID,
  });
  const stagedId = `${RUN}_staged`;
  await db.insert(schema.stagedPayments).values({
    id: stagedId,
    realmId: RUN,
    qbEntityType: "payment",
    qbEntityId: stagedId,
  });
  // QB ownership lives in the counted ledger row (the sole gift-link source).
  await db.insert(schema.paymentApplications).values({
    id: `${stagedId}_pa`,
    paymentId: stagedId,
    giftId: qbGiftId,
    amountApplied: QB_GIFT_AMOUNT,
    evidenceSource: "quickbooks",
  });
  seededGiftIds.push(qbGiftId);
  seededStagedIds.push(stagedId);

  // A gift already booked from Stripe (owned by a stripe_staged_charges row
  // via its counted ledger row — the sole gift-link source).
  await db.insert(schema.giftsAndPayments).values({
    id: chargeGiftId,
    amount: CHARGE_GIFT_AMOUNT,
    dateReceived: GIFT_DATE,
    organizationId: ORG_ID,
  });
  const chargeId = `${RUN}_charge`;
  await db.insert(schema.stripeStagedCharges).values({
    id: chargeId,
    stripeAccountId: RUN,
    grossAmount: CHARGE_GIFT_AMOUNT,
  });
  await db.insert(schema.paymentApplications).values({
    id: `${chargeId}_pa`,
    stripeChargeId: chargeId,
    giftId: chargeGiftId,
    amountApplied: CHARGE_GIFT_AMOUNT,
    evidenceSource: "stripe",
  });
  seededGiftIds.push(chargeGiftId);
  seededChargeIds.push(chargeId);
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (seededStagedIds.length) {
    await db
      .delete(schema.paymentApplications)
      .where(inArrayFn(schema.paymentApplications.paymentId, seededStagedIds));
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, seededStagedIds));
  }
  if (seededChargeIds.length) {
    await db
      .delete(schema.paymentApplications)
      .where(
        inArrayFn(schema.paymentApplications.stripeChargeId, seededChargeIds),
      );
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, seededChargeIds));
  }
  if (seededGiftIds.length) {
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, seededGiftIds));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[quickbooks-parallel-evidence] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)(
  "matcher — Stripe/QuickBooks are parallel evidence for one gift (integration)",
  () => {
    it("a Stripe charge RECONCILES to a gift QuickBooks already booked (was: wrongly minting a duplicate)", async () => {
      const result = await scoreStripeCharge({
        payerName: ORG_NAME,
        payerEmail: null,
        description: null,
        statementDescriptor: null,
        grossAmount: QB_GIFT_AMOUNT,
        dateReceived: GIFT_DATE,
      });

      expect(result.donor.organizationId).toBe(ORG_ID);
      expect(result.giftCandidateCount).toBeGreaterThanOrEqual(1);
      // The QB-owned gift is a valid target for the parallel Stripe evidence.
      expect(result.matchedGiftId).toBe(qbGiftId);
    });

    it("a QuickBooks staged payment does NOT re-link a gift its own channel already owns (worker safety)", async () => {
      const result = await scoreStagedPayment({
        payerName: ORG_NAME,
        payerEmail: null,
        rawReference: null,
        lineDescription: null,
        amount: QB_GIFT_AMOUNT,
        dateReceived: GIFT_DATE,
      });

      // Donor still resolves by name, but the gift is off-limits to another QB row.
      expect(result.donor.organizationId).toBe(ORG_ID);
      expect(result.giftCandidateCount).toBe(0);
      expect(result.matchedGiftId).toBeNull();
    });

    it("a Stripe charge does NOT re-link a gift another Stripe charge already owns", async () => {
      const result = await scoreStripeCharge({
        payerName: ORG_NAME,
        payerEmail: null,
        description: null,
        statementDescriptor: null,
        grossAmount: CHARGE_GIFT_AMOUNT,
        dateReceived: GIFT_DATE,
      });

      expect(result.donor.organizationId).toBe(ORG_ID);
      expect(result.giftCandidateCount).toBe(0);
      expect(result.matchedGiftId).toBeNull();
    });
  },
);
