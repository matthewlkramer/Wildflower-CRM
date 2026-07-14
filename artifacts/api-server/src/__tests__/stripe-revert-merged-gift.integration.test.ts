import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `stripe_revert_merged_${Date.now()}`;
const GIFT_ID = `${RUN}_gift`;
const ALLOCATION_ID = `${RUN}_allocation`;
const MINTING_CHARGE_ID = `${RUN}_minting_charge`;
const OTHER_CHARGE_ID = `${RUN}_other_charge`;
const MINTING_APPLICATION_ID = `${RUN}_minting_application`;
const OTHER_APPLICATION_ID = `${RUN}_other_application`;

let schema: typeof import("@workspace/db");
let db: typeof import("@workspace/db").db;
let eqFn: typeof import("drizzle-orm").eq;
let inArrayFn: typeof import("drizzle-orm").inArray;

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = schema.db;
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    amount: "160.00",
    details: "Co-funded gift that outlives its minting charge",
  });
  await db.insert(schema.giftAllocations).values({
    id: ALLOCATION_ID,
    giftId: GIFT_ID,
    subAmount: "160.00",
  });
  await db.insert(schema.stripeStagedCharges).values([
    {
      id: MINTING_CHARGE_ID,
      stripeAccountId: `${RUN}_acct`,
      grossAmount: "100.00",
      payerName: "Minting charge",
      matchStatus: "matched",
    },
    {
      id: OTHER_CHARGE_ID,
      stripeAccountId: `${RUN}_acct`,
      grossAmount: "60.00",
      payerName: "Other charge",
      matchStatus: "matched",
    },
  ]);
  await db.insert(schema.paymentApplications).values([
    {
      id: MINTING_APPLICATION_ID,
      giftId: GIFT_ID,
      stripeChargeId: MINTING_CHARGE_ID,
      evidenceSource: "stripe",
      amountApplied: "100.00",
      linkRole: "counted",
      lifecycle: "confirmed",
      matchMethod: "human",
      createdTheGift: true,
    },
    {
      id: OTHER_APPLICATION_ID,
      giftId: GIFT_ID,
      stripeChargeId: OTHER_CHARGE_ID,
      evidenceSource: "stripe",
      amountApplied: "60.00",
      linkRole: "counted",
      lifecycle: "confirmed",
      matchMethod: "human",
      createdTheGift: false,
    },
  ]);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await db
    .delete(schema.paymentApplications)
    .where(
      inArrayFn(schema.paymentApplications.id, [
        MINTING_APPLICATION_ID,
        OTHER_APPLICATION_ID,
      ]),
    );
  await db
    .delete(schema.stripeStagedCharges)
    .where(
      inArrayFn(schema.stripeStagedCharges.id, [
        MINTING_CHARGE_ID,
        OTHER_CHARGE_ID,
      ]),
    );
  await db
    .delete(schema.giftAllocations)
    .where(eqFn(schema.giftAllocations.id, ALLOCATION_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
});

describe.skipIf(!HAS_DB)("Stripe revert for a co-funded minted gift", () => {
  it("removes only the minting charge and preserves the funded gift", async () => {
    const { revertStripeChargeInTx } = await import("../lib/stripeChargeRevert");

    const result = await db.transaction((tx) =>
      revertStripeChargeInTx(tx, MINTING_CHARGE_ID),
    );

    expect(result.deletedGiftId).toBeNull();
    expect(result.survivingGiftId).toBe(GIFT_ID);

    const gift = await db
      .select({ id: schema.giftsAndPayments.id })
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, GIFT_ID))
      .then((rows) => rows[0]);
    expect(gift?.id).toBe(GIFT_ID);

    const applications = await db
      .select({
        id: schema.paymentApplications.id,
        stripeChargeId: schema.paymentApplications.stripeChargeId,
      })
      .from(schema.paymentApplications)
      .where(eqFn(schema.paymentApplications.giftId, GIFT_ID));
    expect(applications).toEqual([
      expect.objectContaining({
        id: OTHER_APPLICATION_ID,
        stripeChargeId: OTHER_CHARGE_ID,
      }),
    ]);
  });
});
