import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `stripe_bridge_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const GIFT_ID = `${RUN}_gift`;
const ALLOCATION_ID = `${RUN}_allocation`;
const CHARGE_ID = `${RUN}_charge`;
const AMOUNT = "125.00";

type DbModule = typeof import("@workspace/db");
let db: DbModule["db"];
let schema: {
  organizations: DbModule["organizations"];
  giftsAndPayments: DbModule["giftsAndPayments"];
  giftAllocations: DbModule["giftAllocations"];
  stripeStagedCharges: DbModule["stripeStagedCharges"];
  paymentApplications: DbModule["paymentApplications"];
};
let eq: (typeof import("drizzle-orm"))["eq"];

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbModule.db;
  eq = drizzle.eq;
  schema = {
    organizations: dbModule.organizations,
    giftsAndPayments: dbModule.giftsAndPayments,
    giftAllocations: dbModule.giftAllocations,
    stripeStagedCharges: dbModule.stripeStagedCharges,
    paymentApplications: dbModule.paymentApplications,
  };

  await db.insert(schema.organizations).values({ id: ORG_ID, name: RUN });
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    amount: AMOUNT,
    dateReceived: "2026-07-01",
    organizationId: ORG_ID,
    details: "Stripe bridge integration fixture",
  });
  await db.insert(schema.giftAllocations).values({
    id: ALLOCATION_ID,
    giftId: GIFT_ID,
    subAmount: AMOUNT,
  });
  await db.insert(schema.stripeStagedCharges).values({
    id: CHARGE_ID,
    stripeAccountId: `${RUN}_account`,
    grossAmount: AMOUNT,
    payerName: RUN,
    dateReceived: "2026-07-01",
    matchStatus: "unmatched",
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await db
    .delete(schema.paymentApplications)
    .where(eq(schema.paymentApplications.stripeChargeId, CHARGE_ID));
  await db
    .delete(schema.giftAllocations)
    .where(eq(schema.giftAllocations.id, ALLOCATION_ID));
  await db
    .delete(schema.stripeStagedCharges)
    .where(eq(schema.stripeStagedCharges.id, CHARGE_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eq(schema.giftsAndPayments.id, GIFT_ID));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, ORG_ID));
});

describe.skipIf(!HAS_DB)("Stripe auto-apply ledger bridge", () => {
  it("normalizes an old sync write into a pointerless proposed ledger row", async () => {
    const { bookStripeChargeApplication } = await import(
      "../lib/paymentApplications"
    );

    await db.transaction(async (tx) => {
      await tx
        .update(schema.stripeStagedCharges)
        .set({
          matchedGiftId: GIFT_ID,
          createdGiftId: null,
          autoApplied: true,
          matchStatus: "matched",
          matchConfirmedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.stripeStagedCharges.id, CHARGE_ID));

      // This mirrors the pre-cutover Stripe sync call. Migration 0127 must
      // normalize it to proposed rather than confirmed money.
      await bookStripeChargeApplication(tx, {
        stripeChargeId: CHARGE_ID,
        grossAmount: AMOUNT,
        giftId: GIFT_ID,
        matchMethod: "system",
        createdTheGift: false,
      });
    });

    const charge = await db
      .select({
        matchedGiftId: schema.stripeStagedCharges.matchedGiftId,
        createdGiftId: schema.stripeStagedCharges.createdGiftId,
        autoApplied: schema.stripeStagedCharges.autoApplied,
        matchConfirmedAt: schema.stripeStagedCharges.matchConfirmedAt,
      })
      .from(schema.stripeStagedCharges)
      .where(eq(schema.stripeStagedCharges.id, CHARGE_ID))
      .then((rows) => rows[0]);

    const applications = await db
      .select({
        giftId: schema.paymentApplications.giftId,
        lifecycle: schema.paymentApplications.lifecycle,
        linkRole: schema.paymentApplications.linkRole,
        matchMethod: schema.paymentApplications.matchMethod,
        confirmedAt: schema.paymentApplications.confirmedAt,
      })
      .from(schema.paymentApplications)
      .where(eq(schema.paymentApplications.stripeChargeId, CHARGE_ID));

    expect(charge).toMatchObject({
      matchedGiftId: null,
      createdGiftId: null,
      autoApplied: true,
      matchConfirmedAt: null,
    });
    expect(applications).toEqual([
      expect.objectContaining({
        giftId: GIFT_ID,
        lifecycle: "proposed",
        linkRole: "counted",
        matchMethod: "system",
        confirmedAt: null,
      }),
    ]);
  });
});
