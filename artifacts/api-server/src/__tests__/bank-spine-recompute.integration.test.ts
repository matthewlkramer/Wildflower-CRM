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
  bankTransactions: Db["bankTransactions"];
  qboAccountingChecks: Db["qboAccountingChecks"];
  sourceLinks: Db["sourceLinks"];
  giftsAndPayments: Db["giftsAndPayments"];
  paymentApplications: Db["paymentApplications"];
  organizations: Db["organizations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let recompute: typeof import("../lib/bankSpineRecompute");

const stagedIds: string[] = [];
const payoutIds: string[] = [];
const depositIds: string[] = [];
const paymentUnitIds: string[] = [];
const componentIds: string[] = [];
const bankTransactionIds: string[] = [];
const giftIds: string[] = [];
const applicationIds: string[] = [];
const orgIds: string[] = [];
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

async function seedQboRegister(
  amount: string,
  txnDate: string,
  payee?: string,
): Promise<string> {
  const id = nextId("register");
  await db.insert(schema.bankTransactions).values({
    id,
    source: "qbo_register_export",
    sourceFile: "bank-spine-recompute-test.csv",
    txnDate,
    deposit: amount,
    payee,
    dedupKey: nextId("dedup"),
    occurrence: 0,
  });
  bankTransactionIds.push(id);
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
    bankTransactions: dbMod.bankTransactions,
    qboAccountingChecks: dbMod.qboAccountingChecks,
    sourceLinks: dbMod.sourceLinks,
    giftsAndPayments: dbMod.giftsAndPayments,
    paymentApplications: dbMod.paymentApplications,
    organizations: dbMod.organizations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  recompute = await import("../lib/bankSpineRecompute");
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (applicationIds.length) {
    await db
      .delete(schema.paymentApplications)
      .where(inArrayFn(schema.paymentApplications.id, applicationIds));
  }
  if (giftIds.length) {
    // Clear the pointer first (gift_id is RESTRICT).
    await db
      .update(schema.paymentUnits)
      .set({ giftId: null })
      .where(inArrayFn(schema.paymentUnits.giftId, giftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  if (orgIds.length) {
    await db
      .delete(schema.organizations)
      .where(inArrayFn(schema.organizations.id, orgIds));
  }
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
  if (bankTransactionIds.length) {
    await db
      .delete(schema.sourceLinks)
      .where(inArrayFn(schema.sourceLinks.bankTransactionId, bankTransactionIds));
  }
  if (bankTransactionIds.length) {
    await db
      .delete(schema.bankTransactions)
      .where(inArrayFn(schema.bankTransactions.id, bankTransactionIds));
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

  it("does not insert a QBO-inferred component past the deposit amount", async () => {
    const stagedId = nextId("overfill_sp");
    const deposit = await seedDeposit("605.00", "2026-06-25");
    const qbDepositId = nextId("qbd");
    await db.insert(schema.stagedPayments).values({
      id: stagedId,
      realmId: REALM_ID,
      qbEntityType: "deposit",
      qbEntityId: qbDepositId,
      qbDepositId,
      amount: "605.00",
      dateReceived: "2026-06-25",
      qbRaw: { TotalAmt: "605.00", TxnDate: "2026-06-25" },
    });
    stagedIds.push(stagedId);
    // The deposit is already fully explained by a differently sourced unit.
    const fullUnitId = `pu_manual_${nextId("overfill_unit")}`;
    await db.insert(schema.paymentUnits).values({
      id: fullUnitId,
      kind: "wire",
      grossAmount: "605.00",
      netAmount: "605.00",
      currency: "USD",
      receivedDate: "2026-06-25",
    });
    paymentUnitIds.push(fullUnitId);
    const fullComponentId = `bdc_${nextId("overfill_component")}`;
    await db.insert(schema.bankDepositComponents).values({
      id: fullComponentId,
      bankDepositId: deposit,
      paymentUnitId: fullUnitId,
      amount: "605.00",
      source: "manual",
    });
    componentIds.push(fullComponentId);
    paymentUnitIds.push(`pu_${stagedId}`);

    await expect(recompute.recomputeBankSpine()).resolves.toBeUndefined();
    // Re-run to prove the guard holds across recomputes.
    await expect(recompute.recomputeBankSpine()).resolves.toBeUndefined();

    const rows = await db
      .select({
        id: schema.bankDepositComponents.id,
        amount: schema.bankDepositComponents.amount,
      })
      .from(schema.bankDepositComponents)
      .where(eqFn(schema.bankDepositComponents.bankDepositId, deposit));
    expect(rows).toEqual([{ id: fullComponentId, amount: "605.00" }]);
  });

  it("links a unique exact-amount register row within the +/- 3-day window and is idempotent", async () => {
    const depositId = await seedDeposit("701.00", "2026-07-10");
    const registerId = await seedQboRegister("701.00", "2026-07-12");

    await recompute.recomputeBankSpine();
    const first = await db
      .select({
        bankDepositId: schema.sourceLinks.bankDepositId,
        bankTransactionId: schema.sourceLinks.bankTransactionId,
        matchBasis: schema.sourceLinks.matchBasis,
      })
      .from(schema.sourceLinks)
      .where(eqFn(schema.sourceLinks.bankDepositId, depositId));
    expect(first).toEqual([{
      bankDepositId: depositId,
      bankTransactionId: registerId,
      matchBasis: "two_day_unique_amount",
    }]);

    await recompute.recomputeBankSpine();
    const second = await db
      .select({ id: schema.sourceLinks.id })
      .from(schema.sourceLinks)
      .where(eqFn(schema.sourceLinks.bankDepositId, depositId));
    expect(second).toEqual([{ id: `srcl_qrd_${registerId}` }]);
  });

  it("does not link when two register rows are candidates for one deposit", async () => {
    const depositId = await seedDeposit("702.00", "2026-07-20");
    await seedQboRegister("702.00", "2026-07-19");
    await seedQboRegister("702.00", "2026-07-22");

    await recompute.recomputeBankSpine();

    const rows = await db
      .select({ id: schema.sourceLinks.id })
      .from(schema.sourceLinks)
      .where(eqFn(schema.sourceLinks.bankDepositId, depositId));
    expect(rows).toEqual([]);
  });

  it("requires an exact amount even when the register date is within the window", async () => {
    const depositId = await seedDeposit("703.00", "2026-07-30");
    await seedQboRegister("703.01", "2026-07-31");

    await recompute.recomputeBankSpine();

    const rows = await db
      .select({ id: schema.sourceLinks.id })
      .from(schema.sourceLinks)
      .where(eqFn(schema.sourceLinks.bankDepositId, depositId));
    expect(rows).toEqual([]);
  });

  it("writes a same-day match as a qbo_register_deposit source_link", async () => {
    const depositId = await seedDeposit("711.00", "2026-08-10");
    const registerId = await seedQboRegister("711.00", "2026-08-10");

    await recompute.recomputeBankSpine();

    const rows = await db
      .select({
        id: schema.sourceLinks.id,
        bankDepositId: schema.sourceLinks.bankDepositId,
        lifecycle: schema.sourceLinks.lifecycle,
        matchBasis: schema.sourceLinks.matchBasis,
      })
      .from(schema.sourceLinks)
      .where(eqFn(schema.sourceLinks.bankTransactionId, registerId));
    expect(rows).toEqual([
      {
        id: `srcl_qrd_${registerId}`,
        bankDepositId: depositId,
        lifecycle: "confirmed",
        matchBasis: "same_day_unique_amount",
      },
    ]);
  });

  it("links same-day/same-payee register rows whose sum equals a deposit", async () => {
    const depositId = await seedDeposit("750.00", "2026-09-10");
    const firstRow = await seedQboRegister("500.00", "2026-09-10", "Wend  Ventures");
    const secondRow = await seedQboRegister("250.00", "2026-09-10", "Wend Ventures");

    await recompute.recomputeBankSpine();

    for (const registerId of [firstRow, secondRow]) {
      const rows = await db
        .select({
          bankDepositId: schema.sourceLinks.bankDepositId,
          matchBasis: schema.sourceLinks.matchBasis,
        })
        .from(schema.sourceLinks)
        .where(eqFn(schema.sourceLinks.bankTransactionId, registerId));
      expect(rows).toEqual([
        { bankDepositId: depositId, matchBasis: "same_donor_multi_row_sum" },
      ]);
    }
  });

  it("pairs equal counts of identical-amount register rows and deposits one-to-one", async () => {
    const depositA = await seedDeposit("479.20", "2026-10-05");
    const depositB = await seedDeposit("479.20", "2026-10-05");
    const rowA = await seedQboRegister("479.20", "2026-10-05");
    const rowB = await seedQboRegister("479.20", "2026-10-05");

    await recompute.recomputeBankSpine();

    const rows = await db
      .select({
        bankDepositId: schema.sourceLinks.bankDepositId,
        matchBasis: schema.sourceLinks.matchBasis,
      })
      .from(schema.sourceLinks)
      .where(inArrayFn(schema.sourceLinks.bankTransactionId, [rowA, rowB]));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.matchBasis)).toEqual([
      "same_day_equal_count_amount",
      "same_day_equal_count_amount",
    ]);
    expect(new Set(rows.map((r) => r.bankDepositId))).toEqual(
      new Set([depositA, depositB]),
    );
  });

  it("skips equal-count pairing when counts differ", async () => {
    await seedDeposit("481.30", "2026-10-12");
    await seedDeposit("481.30", "2026-10-12");
    const rowA = await seedQboRegister("481.30", "2026-10-12");
    const rowB = await seedQboRegister("481.30", "2026-10-12");
    const rowC = await seedQboRegister("481.30", "2026-10-12");

    await recompute.recomputeBankSpine();

    const rows = await db
      .select({ id: schema.sourceLinks.id })
      .from(schema.sourceLinks)
      .where(
        inArrayFn(schema.sourceLinks.bankTransactionId, [rowA, rowB, rowC]),
      );
    expect(rows).toEqual([]);
  });

  it("recompute leaves the counted unit→gift pointer untouched (it IS the authority)", async () => {
    const orgId = nextId("org");
    await db
      .insert(schema.organizations)
      .values({ id: orgId, name: `pointer sync org ${RUN}` });
    orgIds.push(orgId);

    const giftId = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: giftId,
      name: "pointer sync test gift",
      organizationId: orgId,
      amount: "55.00",
    });
    giftIds.push(giftId);

    const unitId = nextId("pu");
    await db.insert(schema.paymentUnits).values({
      id: unitId,
      kind: "check",
      grossAmount: "55.00",
      giftId,
      giftMatchMethod: "human",
    });
    paymentUnitIds.push(unitId);

    await recompute.recomputeBankSpine();
    const unit = await db
      .select({ giftId: schema.paymentUnits.giftId })
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, unitId));
    expect(unit[0]?.giftId).toBe(giftId);
  });

  it("multi-row sum does not link when two deposits are candidates", async () => {
    await seedDeposit("760.00", "2026-10-10");
    await seedDeposit("760.00", "2026-10-11");
    const firstRow = await seedQboRegister("700.00", "2026-10-10", "Acme Fund");
    const secondRow = await seedQboRegister("60.00", "2026-10-10", "Acme Fund");

    await recompute.recomputeBankSpine();

    for (const registerId of [firstRow, secondRow]) {
      const rows = await db
        .select({ id: schema.sourceLinks.id })
        .from(schema.sourceLinks)
        .where(eqFn(schema.sourceLinks.bankTransactionId, registerId));
      expect(rows).toEqual([]);
    }
  });
});
