import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-backed smoke + behavior coverage for the forward bank-spine recompute
 * (docs/adr-bank-spine-money-model.md): every step's SQL must execute against
 * the real schema, and the QBO accounting comparer (step 7) must pair a
 * Stripe-lump QBO row to its payout and record consistent /
 * correction_needed.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `bsr_${Date.now()}`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stagedPayments: Db["stagedPayments"];
  stripePayouts: Db["stripePayouts"];
  bankDeposits: Db["bankDeposits"];
  paymentUnits: Db["paymentUnits"];
  bankDepositComponents: Db["bankDepositComponents"];
  qboAccountingChecks: Db["qboAccountingChecks"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let recompute: typeof import("../lib/bankSpineRecompute");

const stagedIds: string[] = [];
const payoutIds: string[] = [];
const depositIds: string[] = [];
const paymentUnitIds: string[] = [];
const componentIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedLump(amount: string, date: string): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: nextId("qbe"),
    amount,
    dateReceived: date,
    payerName: "Stripe",
    fundingSource: "stripe",
    autoApplied: false,
  });
  stagedIds.push(id);
  return id;
}

async function seedPayout(amount: string, arrivalDate: string): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount,
    arrivalDate,
    status: "paid",
  });
  payoutIds.push(id);
  return id;
}

async function seedDeposit(amount: string, depositDate: string): Promise<string> {
  const id = nextId("bd");
  await db.insert(schema.bankDeposits).values({
    id,
    source: "bank_csv_export",
    depositDate,
    amount,
    currency: "USD",
    account: ACCOUNT_ID,
  });
  depositIds.push(id);
  return id;
}

async function readCheck(stagedId: string) {
  const rows = await db
    .select({
      disposition: schema.qboAccountingChecks.disposition,
      expected: schema.qboAccountingChecks.expected,
      note: schema.qboAccountingChecks.note,
    })
    .from(schema.qboAccountingChecks)
    .where(eqFn(schema.qboAccountingChecks.stagedPaymentId, stagedId));
  return rows[0] ?? null;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    stagedPayments: dbMod.stagedPayments,
    stripePayouts: dbMod.stripePayouts,
    bankDeposits: dbMod.bankDeposits,
    paymentUnits: dbMod.paymentUnits,
    bankDepositComponents: dbMod.bankDepositComponents,
    qboAccountingChecks: dbMod.qboAccountingChecks,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  recompute = await import("../lib/bankSpineRecompute");
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (componentIds.length) {
    await db
      .delete(schema.bankDepositComponents)
      .where(inArrayFn(schema.bankDepositComponents.id, componentIds));
  }
  if (paymentUnitIds.length) {
    await db
      .delete(schema.paymentUnits)
      .where(inArrayFn(schema.paymentUnits.id, paymentUnitIds));
  }
  if (stagedIds.length) {
    await db
      .delete(schema.qboAccountingChecks)
      .where(inArrayFn(schema.qboAccountingChecks.stagedPaymentId, stagedIds));
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  }
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  if (depositIds.length)
    await db
      .delete(schema.bankDeposits)
      .where(inArrayFn(schema.bankDeposits.id, depositIds));
});

describe.skipIf(!HAS_DB)("bank-spine recompute (DB)", () => {
  it("runs every step end-to-end and is re-runnable", async () => {
    await recompute.recomputeBankSpine();
    await recompute.recomputeBankSpine();
  });

  it("comparer: exact-amount lump in the bank window checks consistent", async () => {
    const po = await seedPayout("512.34", "2026-06-01");
    const sp = await seedLump("512.34", "2026-06-03");

    await recompute.recomputeBankSpine();

    const check = await readCheck(sp);
    expect(check).not.toBeNull();
    expect(check!.disposition).toBe("consistent");
    const expected = check!.expected as { payout_id: string; kind: string };
    expect(expected.payout_id).toBe(po);
    expect(expected.kind).toBe("stripe_payout_lump");
  });

  it("comparer: no unambiguous pairing → no check row", async () => {
    // Two same-amount payouts in the window: pairing is ambiguous, so the
    // comparer must stay silent rather than guess.
    await seedPayout("77.77", "2026-06-10");
    await seedPayout("77.77", "2026-06-11");
    const sp = await seedLump("77.77", "2026-06-12");

    await recompute.recomputeBankSpine();

    expect(await readCheck(sp)).toBeNull();
  });

  it("pairs a payout cluster to the nearest deposit after arrival", async () => {
    const firstPayout = await seedPayout("601.00", "2026-03-01");
    const secondPayout = await seedPayout("601.00", "2026-03-05");
    const firstDeposit = await seedDeposit("601.00", "2026-03-02");
    const secondDeposit = await seedDeposit("601.00", "2026-03-06");

    await recompute.recomputeBankSpine();

    const rows = await db
      .select({
        id: schema.stripePayouts.id,
        bankDepositId: schema.stripePayouts.bankDepositId,
        ambiguousBankMatch: schema.stripePayouts.ambiguousBankMatch,
      })
      .from(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, [firstPayout, secondPayout]));
    expect(rows).toEqual(expect.arrayContaining([
      { id: firstPayout, bankDepositId: firstDeposit, ambiguousBankMatch: false },
      { id: secondPayout, bankDepositId: secondDeposit, ambiguousBankMatch: false },
    ]));
  });

  it("flags a genuine nearest-date tie as ambiguous", async () => {
    const payout = await seedPayout("602.00", "2026-04-01");
    const firstDeposit = await seedDeposit("602.00", "2026-04-02");
    await seedDeposit("602.00", "2026-04-02");

    await recompute.recomputeBankSpine();

    const row = (await db
      .select({
        bankDepositId: schema.stripePayouts.bankDepositId,
        ambiguousBankMatch: schema.stripePayouts.ambiguousBankMatch,
      })
      .from(schema.stripePayouts)
      .where(eqFn(schema.stripePayouts.id, payout)))[0];
    expect(row).toEqual({ bankDepositId: firstDeposit, ambiguousBankMatch: true });
  });

  it("preserves a pre-existing human payout tie", async () => {
    const humanDeposit = await seedDeposit("603.00", "2026-05-06");
    await seedDeposit("603.00", "2026-05-02");
    const payout = nextId("po");
    await db.insert(schema.stripePayouts).values({
      id: payout,
      stripeAccountId: ACCOUNT_ID,
      amount: "603.00",
      arrivalDate: "2026-05-01",
      status: "paid",
      bankDepositId: humanDeposit,
      ambiguousBankMatch: true,
    });
    payoutIds.push(payout);

    await recompute.recomputeBankSpine();

    const row = (await db
      .select({
        bankDepositId: schema.stripePayouts.bankDepositId,
        ambiguousBankMatch: schema.stripePayouts.ambiguousBankMatch,
      })
      .from(schema.stripePayouts)
      .where(eqFn(schema.stripePayouts.id, payout)))[0];
    expect(row).toEqual({ bankDepositId: humanDeposit, ambiguousBankMatch: true });
  });

  it("preserves an existing differently keyed deposit component", async () => {
    const stagedId = nextId("component_sp");
    const paymentUnitId = `pu_${stagedId}`;
    const existingDeposit = await seedDeposit("604.00", "2026-06-20");
    await seedDeposit("604.00", "2026-06-20");
    const qbDepositId = nextId("qbd");
    await db.insert(schema.stagedPayments).values({
      id: stagedId,
      realmId: REALM_ID,
      qbEntityType: "deposit",
      qbEntityId: qbDepositId,
      qbDepositId,
      amount: "604.00",
      dateReceived: "2026-06-20",
      qbRaw: { TotalAmt: "604.00", TxnDate: "2026-06-20" },
    });
    stagedIds.push(stagedId);
    await db.insert(schema.paymentUnits).values({
      id: paymentUnitId,
      kind: "check",
      sourceStagedPaymentId: stagedId,
      grossAmount: "604.00",
      netAmount: "604.00",
      currency: "USD",
      receivedDate: "2026-06-20",
    });
    paymentUnitIds.push(paymentUnitId);
    const componentId = `bdc_0172_${nextId("component")}`;
    await db.insert(schema.bankDepositComponents).values({
      id: componentId,
      bankDepositId: existingDeposit,
      paymentUnitId,
      amount: "604.00",
      source: "qbo_inferred",
      sourceStagedPaymentId: stagedId,
    });
    componentIds.push(componentId);

    await expect(recompute.recomputeBankSpine()).resolves.toBeUndefined();

    const rows = await db
      .select({
        id: schema.bankDepositComponents.id,
        bankDepositId: schema.bankDepositComponents.bankDepositId,
      })
      .from(schema.bankDepositComponents)
      .where(eqFn(schema.bankDepositComponents.paymentUnitId, paymentUnitId));
    expect(rows).toEqual([{ id: componentId, bankDepositId: existingDeposit }]);
  });
});
