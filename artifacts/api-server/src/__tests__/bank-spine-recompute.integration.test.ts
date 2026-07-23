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
  qboAccountingChecks: Db["qboAccountingChecks"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let recompute: typeof import("../lib/bankSpineRecompute");

const stagedIds: string[] = [];
const payoutIds: string[] = [];
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
    qboAccountingChecks: dbMod.qboAccountingChecks,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  recompute = await import("../lib/bankSpineRecompute");
});

afterAll(async () => {
  if (!HAS_DB) return;
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
    const expected = check!.expected as { payout_id: string; paired_by: string };
    expect(expected.payout_id).toBe(po);
    expect(expected.paired_by).toBe("exact_amount_window");
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
});
