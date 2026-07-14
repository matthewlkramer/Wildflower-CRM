import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `gift_combine_ledger_${Date.now()}`;
const SURVIVOR_ID = `${RUN}_survivor`;
const LOSER_ID = `${RUN}_loser`;
const CHARGE_A = `${RUN}_charge_a`;
const CHARGE_B = `${RUN}_charge_b`;
const APP_A = `${RUN}_app_a`;
const APP_B = `${RUN}_app_b`;

let db: typeof import("@workspace/db").db;
let schema: typeof import("@workspace/db");
let eqFn: typeof import("drizzle-orm").eq;
let inArrayFn: typeof import("drizzle-orm").inArray;

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = schema.db;
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.giftsAndPayments).values([
    { id: SURVIVOR_ID, amount: "100.00" },
    { id: LOSER_ID, amount: "60.00" },
  ]);
  await db.insert(schema.stripeStagedCharges).values([
    {
      id: CHARGE_A,
      stripeAccountId: `${RUN}_acct`,
      grossAmount: "100.00",
      payerName: "Survivor Donor",
      matchStatus: "matched",
    },
    {
      id: CHARGE_B,
      stripeAccountId: `${RUN}_acct`,
      grossAmount: "60.00",
      payerName: "Loser Donor",
      matchStatus: "matched",
    },
  ]);
  await db.insert(schema.paymentApplications).values([
    {
      id: APP_A,
      giftId: SURVIVOR_ID,
      stripeChargeId: CHARGE_A,
      evidenceSource: "stripe",
      amountApplied: "100.00",
      linkRole: "counted",
      lifecycle: "confirmed",
      matchMethod: "human",
    },
    {
      id: APP_B,
      giftId: LOSER_ID,
      stripeChargeId: CHARGE_B,
      evidenceSource: "stripe",
      amountApplied: "60.00",
      linkRole: "counted",
      lifecycle: "confirmed",
      matchMethod: "human",
    },
  ]);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await db
    .delete(schema.paymentApplications)
    .where(inArrayFn(schema.paymentApplications.id, [APP_A, APP_B]));
  await db
    .delete(schema.stripeStagedCharges)
    .where(inArrayFn(schema.stripeStagedCharges.id, [CHARGE_A, CHARGE_B]));
  await db
    .delete(schema.giftsAndPayments)
    .where(inArrayFn(schema.giftsAndPayments.id, [SURVIVOR_ID, LOSER_ID]));
});

describe.skipIf(!HAS_DB)("ledger-first gift evidence combine", () => {
  it("re-homes multiple independent Stripe charges onto one surviving gift", async () => {
    const { absorbGiftEvidenceIntoSurvivor } = await import("../lib/giftCombine");

    const result = await db.transaction((tx) =>
      absorbGiftEvidenceIntoSurvivor(tx, SURVIVOR_ID, [LOSER_ID]),
    );

    expect(result.collision).toBeNull();

    const applications = await db
      .select({
        id: schema.paymentApplications.id,
        giftId: schema.paymentApplications.giftId,
        stripeChargeId: schema.paymentApplications.stripeChargeId,
        amountApplied: schema.paymentApplications.amountApplied,
      })
      .from(schema.paymentApplications)
      .where(
        inArrayFn(schema.paymentApplications.stripeChargeId, [CHARGE_A, CHARGE_B]),
      );

    expect(applications).toHaveLength(2);
    expect(applications.every((row) => row.giftId === SURVIVOR_ID)).toBe(true);
    expect(applications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stripeChargeId: CHARGE_A,
          amountApplied: "100.00",
        }),
        expect.objectContaining({
          stripeChargeId: CHARGE_B,
          amountApplied: "60.00",
        }),
      ]),
    );

    const [loserApplication] = await db
      .select({ id: schema.paymentApplications.id })
      .from(schema.paymentApplications)
      .where(eqFn(schema.paymentApplications.giftId, LOSER_ID));
    expect(loserApplication).toBeUndefined();
  });
});
