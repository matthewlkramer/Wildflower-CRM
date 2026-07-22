import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Off-books derivation guard (Task #794 step 5).
 *
 * `giftIsOffBooksExpr` (lib/giftPaymentSummary.ts) is the SOLE authority for
 * whether a gift is off-books / payment-exempt. The rule is allocation-only
 * (header terms retired): a gift is off-books EXACTLY when it has >= 1
 * allocation AND every allocation sits on a no-payment entity
 * (entities.expects_payment = false). Locked in here:
 *
 *   - no allocations            → ON-books (expects payment)
 *   - all allocs on no-pay ent. → OFF-books
 *   - mixed allocations         → ON-books
 *   - allocation w/o entity     → ON-books
 *
 * Pure DB-expression test (no HTTP). Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `offbooks_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ENT_PAY = `${RUN}_ent_pay`; // expects_payment = true
const ENT_NOPAY = `${RUN}_ent_nopay`; // expects_payment = false
const GIFT_NONE = `${RUN}_g_none`; // no allocations
const GIFT_OFF = `${RUN}_g_off`; // all allocations on no-pay entity
const GIFT_MIXED = `${RUN}_g_mixed`; // one no-pay + one pay allocation
const GIFT_NOENT = `${RUN}_g_noent`; // allocation without an entity

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  organizations: Db["organizations"];
  entities: Db["entities"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let sqlTag: (typeof import("drizzle-orm"))["sql"];
let giftIsOffBooksExpr: (typeof import("../lib/giftPaymentSummary"))["giftIsOffBooksExpr"];

async function isOffBooks(giftId: string): Promise<boolean> {
  const res = await db.execute<{ off: boolean }>(
    sqlTag`SELECT ${giftIsOffBooksExpr(sqlTag`${giftId}`)} AS off`,
  );
  return Boolean(res.rows[0]?.off);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  ({ giftIsOffBooksExpr } = await import("../lib/giftPaymentSummary"));
  db = dbMod.db;
  schema = {
    organizations: dbMod.organizations,
    entities: dbMod.entities,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  sqlTag = drizzle.sql;

  await db.insert(schema.organizations).values({ id: ORG_ID, name: `Org ${RUN}` });
  await db.insert(schema.entities).values([
    { id: ENT_PAY, name: `Pay entity ${RUN}`, expectsPayment: true },
    { id: ENT_NOPAY, name: `No-pay entity ${RUN}`, expectsPayment: false },
  ]);
  await db.insert(schema.giftsAndPayments).values(
    [GIFT_NONE, GIFT_OFF, GIFT_MIXED, GIFT_NOENT].map((id) => ({
      id,
      name: `Gift ${id}`,
      organizationId: ORG_ID,
      amount: "100.00",
      dateReceived: "2099-11-15",
    })),
  );
  await db.insert(schema.giftAllocations).values([
    { id: `${RUN}_a_off1`, giftId: GIFT_OFF, entityId: ENT_NOPAY, subAmount: "60.00" },
    { id: `${RUN}_a_off2`, giftId: GIFT_OFF, entityId: ENT_NOPAY, subAmount: "40.00" },
    { id: `${RUN}_a_mix1`, giftId: GIFT_MIXED, entityId: ENT_NOPAY, subAmount: "50.00" },
    { id: `${RUN}_a_mix2`, giftId: GIFT_MIXED, entityId: ENT_PAY, subAmount: "50.00" },
    { id: `${RUN}_a_noent`, giftId: GIFT_NOENT, entityId: null, subAmount: "100.00" },
  ]);
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const giftIds = [GIFT_NONE, GIFT_OFF, GIFT_MIXED, GIFT_NOENT];
  await db
    .delete(schema.giftAllocations)
    .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
  await db
    .delete(schema.giftsAndPayments)
    .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  await db
    .delete(schema.entities)
    .where(inArrayFn(schema.entities.id, [ENT_PAY, ENT_NOPAY]));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("giftIsOffBooksExpr (allocation-only off-books rule)", () => {
  it("a gift with NO allocations is ON-books", async () => {
    expect(await isOffBooks(GIFT_NONE)).toBe(false);
  });

  it("a gift whose allocations ALL sit on no-payment entities is OFF-books", async () => {
    expect(await isOffBooks(GIFT_OFF)).toBe(true);
  });

  it("mixed allocations (any payment-bearing entity) keep the gift ON-books", async () => {
    expect(await isOffBooks(GIFT_MIXED)).toBe(false);
  });

  it("an allocation without an entity keeps the gift ON-books", async () => {
    expect(await isOffBooks(GIFT_NOENT)).toBe(false);
  });

  it("flipping the last payment-bearing allocation to a no-pay entity flips the gift OFF-books", async () => {
    await db
      .update(schema.giftAllocations)
      .set({ entityId: ENT_NOPAY })
      .where(eqFn(schema.giftAllocations.id, `${RUN}_a_mix2`));
    expect(await isOffBooks(GIFT_MIXED)).toBe(true);
    // restore
    await db
      .update(schema.giftAllocations)
      .set({ entityId: ENT_PAY })
      .where(eqFn(schema.giftAllocations.id, `${RUN}_a_mix2`));
  });
});
