import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearPaymentApplicationsForGiftIds,
  clearPaymentApplicationsForStagedIds,
} from "./paymentApplicationsTestUtil";

/**
 * DB-backed coverage for the §4.3 settlement supersede
 * (settlementSupersede.ts): when a coarse QB deposit lump is SETTLED against a
 * Stripe payout (the `settled_stripe_payout_id` pairing fact) AND a gift's
 * money is fully re-expressed by that payout's per-charge counted Stripe rows,
 * the deposit's coarse counted QB row DEMOTES to `corroborating` (amount kept)
 * — and PROMOTES back once the coverage fact goes away (pairing cleared).
 * Exercises the real transactions against dev Postgres:
 *   - settled + covered → recompute demotes the QB row and surfaces the gift,
 *   - pairing cleared → recompute promotes it back,
 *   - settled with NO per-charge coverage → nothing demoted,
 *   - corrections-flow corroborating rows (NULL amount) are never touched,
 *   - promote drops the stale crumb when a fresh counted row raced ahead,
 *   - promote is conservatively SKIPPED when the book-once guard would be
 *     violated (row stays corroborating; safe under-count).
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `supersede_${Date.now()}`;
const ACCOUNT_ID = `${RUN}_acct`;
const REALM_ID = `${RUN}_realm`;
const ORG_ID = `${RUN}_org`;
const USER_ID = `${RUN}_user`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stripePayouts: Db["stripePayouts"];
  stagedPayments: Db["stagedPayments"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  paymentApplications: Db["paymentApplications"];
  organizations: Db["organizations"];
  users: Db["users"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let supersede: typeof import("../lib/settlementSupersede");

const payoutIds: string[] = [];
const stagedIds: string[] = [];
const giftIds: string[] = [];
const chargeIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedGift(): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: "1000.00",
    organizationId: ORG_ID,
    details: "Imported from QuickBooks (deposit).",
  });
  await db.insert(schema.giftAllocations).values({
    id: nextId("alloc"),
    giftId: id,
    subAmount: "1000.00",
  });
  giftIds.push(id);
  return id;
}

/** A QB deposit lump. amount defaults to the classic 1000.00 net. */
async function seedDeposit(over?: { amount?: string }): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: nextId("qbe"),
    amount: over?.amount ?? "1000.00",
    dateReceived: "2026-03-15",
    payerName: "Stripe",
    autoApplied: false,
  });
  stagedIds.push(id);
  return id;
}

/** A counted QB ledger row anchoring `dep`'s money onto `gift`. */
async function seedQbRow(
  dep: string,
  gift: string,
  over?: { amount?: string | null; linkRole?: "counted" | "corroborating" },
): Promise<string> {
  const id = nextId("pa");
  await db.insert(schema.paymentApplications).values({
    id,
    paymentId: dep,
    giftId: gift,
    amountApplied: over?.amount === undefined ? "1000.00" : over.amount,
    evidenceSource: "quickbooks",
    linkRole: over?.linkRole ?? "counted",
  });
  return id;
}

/** A payout, optionally SETTLED against `depositId` via the pairing fact. */
async function seedPayout(over?: { depositId?: string | null }): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: "1000.00",
    netTotal: "1000.00",
    arrivalDate: "2026-03-15",
  });
  payoutIds.push(id);
  if (over?.depositId) {
    await db
      .update(schema.stagedPayments)
      .set({ settledStripePayoutId: id })
      .where(eqFn(schema.stagedPayments.id, over.depositId));
  }
  return id;
}

async function clearPairing(dep: string): Promise<void> {
  await db
    .update(schema.stagedPayments)
    .set({ settledStripePayoutId: null })
    .where(eqFn(schema.stagedPayments.id, dep));
}

/** A settled Stripe charge on `payoutId` + its counted per-charge ledger row
 * booking the GROSS onto `gift` — the granular money trail that covers the
 * coarse QB lump. */
async function seedCountedCharge(
  payoutId: string,
  gift: string,
  over?: { gross?: string; net?: string },
): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: payoutId,
    grossAmount: over?.gross ?? "1030.00",
    netAmount: over?.net ?? "1000.00",
    dateReceived: "2026-03-14",
  });
  chargeIds.push(id);
  await db.insert(schema.paymentApplications).values({
    id: nextId("pa"),
    giftId: gift,
    amountApplied: over?.gross ?? "1030.00",
    evidenceSource: "stripe",
    stripeChargeId: id,
    createdTheGift: true,
  });
  return id;
}

async function readQbRows(dep: string) {
  return db
    .select({
      id: schema.paymentApplications.id,
      giftId: schema.paymentApplications.giftId,
      amountApplied: schema.paymentApplications.amountApplied,
      linkRole: schema.paymentApplications.linkRole,
    })
    .from(schema.paymentApplications)
    .where(
      andFn(
        eqFn(schema.paymentApplications.paymentId, dep),
        eqFn(schema.paymentApplications.evidenceSource, "quickbooks"),
      ),
    );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    stripePayouts: dbMod.stripePayouts,
    stagedPayments: dbMod.stagedPayments,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    paymentApplications: dbMod.paymentApplications,
    organizations: dbMod.organizations,
    users: dbMod.users,
  };
  eqFn = drizzle.eq;
  andFn = drizzle.and;
  inArrayFn = drizzle.inArray;
  supersede = await import("../lib/settlementSupersede");

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `${RUN}_clerk`,
    email: `${RUN}@wildflowerschools.org`,
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Supersede Org ${RUN}`,
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  // Stripe-anchored ledger rows have paymentId NULL — clear them BEFORE the
  // charges (the set-null FK would otherwise trip the stripe-evidence CHECK).
  await clearPaymentApplicationsForGiftIds(giftIds);
  await clearPaymentApplicationsForStagedIds(stagedIds);
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  if (giftIds.length) {
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
});

describe.skipIf(!HAS_DB)("settlement supersede (DB)", () => {
  it("settling demotes the covered coarse QB row; clearing the pairing promotes it back", async () => {
    const gift = await seedGift();
    const dep = await seedDeposit();
    const paId = await seedQbRow(dep, gift); // counted 1000.00 (net lump)
    const po = await seedPayout({ depositId: dep });
    await seedCountedCharge(po, gift); // counted Stripe 1030.00 (gross)

    // SETTLED: the QB row is fully re-expressed by the payout's per-charge
    // row → demote.
    const affected = await db.transaction((tx) =>
      supersede.applySettlementSupersedeMany(tx, [dep]),
    );
    expect(affected).toEqual([gift]);

    let rows = await readQbRows(dep);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(paId);
    expect(rows[0].linkRole).toBe("corroborating");
    expect(rows[0].amountApplied).toBe("1000.00"); // amount KEPT (supersede-managed)

    // Idempotent re-run on the converged deposit: no-op.
    const rerun = await db.transaction((tx) =>
      supersede.applySettlementSupersedeMany(tx, [dep]),
    );
    expect(rerun).toEqual([]);

    // Pairing cleared: coverage fact gone → promote back to counted.
    await clearPairing(dep);
    const promoted = await db.transaction((tx) =>
      supersede.applySettlementSupersedeMany(tx, [dep]),
    );
    expect(promoted).toEqual([gift]);

    rows = await readQbRows(dep);
    expect(rows).toHaveLength(1);
    expect(rows[0].linkRole).toBe("counted");
    expect(rows[0].amountApplied).toBe("1000.00");
  });

  it("settled WITHOUT per-charge coverage demotes nothing", async () => {
    const gift = await seedGift();
    const otherGift = await seedGift();
    const dep = await seedDeposit();
    await seedQbRow(dep, gift);
    const po = await seedPayout({ depositId: dep });
    // The payout's counted Stripe money belongs to a DIFFERENT gift.
    await seedCountedCharge(po, otherGift);

    const affected = await db.transaction((tx) =>
      supersede.applySettlementSupersedeMany(tx, [dep]),
    );
    expect(affected).toEqual([]);

    const rows = await readQbRows(dep);
    expect(rows).toHaveLength(1);
    expect(rows[0].linkRole).toBe("counted");
  });

  it("demote deletes a colliding corrections-flow corroborating row; unrelated NULL-amount rows survive", async () => {
    const gift = await seedGift();
    const bystanderGift = await seedGift();
    const dep = await seedDeposit();
    const countedId = await seedQbRow(dep, gift);
    // Corrections-flow annotations (amount NULL): one COLLIDING with the pair
    // about to demote (must be deleted — partial UNIQUE), one for another gift
    // (must survive untouched).
    const collidingId = await seedQbRow(dep, gift, {
      amount: null,
      linkRole: "corroborating",
    });
    const bystanderId = await seedQbRow(dep, bystanderGift, {
      amount: null,
      linkRole: "corroborating",
    });
    const po = await seedPayout({ depositId: dep });
    await seedCountedCharge(po, gift);

    const affected = await db.transaction((tx) =>
      supersede.applySettlementSupersedeMany(tx, [dep]),
    );
    expect(affected).toEqual([gift]);

    const rows = await readQbRows(dep);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(countedId)?.linkRole).toBe("corroborating");
    expect(byId.get(countedId)?.amountApplied).toBe("1000.00");
    expect(byId.has(collidingId)).toBe(false); // deleted (UNIQUE collision)
    expect(byId.get(bystanderId)?.linkRole).toBe("corroborating");
    expect(byId.get(bystanderId)?.amountApplied).toBeNull(); // never touched
  });

  it("promote drops the stale crumb when a fresh counted row raced ahead", async () => {
    const gift = await seedGift();
    const dep = await seedDeposit();
    // A demoted crumb AND a fresh counted booking for the same (payment, gift)
    // pair; no pairing → the crumb wants to promote, but the counted partial
    // UNIQUE forbids two — delete the crumb instead.
    const crumbId = await seedQbRow(dep, gift, {
      amount: "1000.00",
      linkRole: "corroborating",
    });
    const freshId = await seedQbRow(dep, gift);

    const affected = await db.transaction((tx) =>
      supersede.applySettlementSupersedeMany(tx, [dep]),
    );
    expect(affected).toEqual([gift]);

    const rows = await readQbRows(dep);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(freshId);
    expect(rows[0].linkRole).toBe("counted");
    expect(rows.find((r) => r.id === crumbId)).toBeUndefined();
  });

  it("promote is conservatively SKIPPED when it would violate the book-once cap", async () => {
    const giftA = await seedGift();
    const giftB = await seedGift();
    const dep = await seedDeposit({ amount: "1000.00" });
    // The deposit's full value is already counted against gift B; promoting
    // gift A's 1000.00 crumb would double the lump (2000 > 1000 + 10%+1 band).
    await seedQbRow(dep, giftB);
    const crumbId = await seedQbRow(dep, giftA, {
      amount: "1000.00",
      linkRole: "corroborating",
    });

    const affected = await db.transaction((tx) =>
      supersede.applySettlementSupersedeMany(tx, [dep]),
    );
    expect(affected).toEqual([]); // skip changed nothing

    const rows = await readQbRows(dep);
    const crumb = rows.find((r) => r.id === crumbId);
    expect(crumb?.linkRole).toBe("corroborating"); // safe under-count state
    expect(crumb?.amountApplied).toBe("1000.00");
  });

  it("applySupersedeForPayoutInTx resolves the payout's settled deposit through the pairing fact", async () => {
    const gift = await seedGift();
    const dep = await seedDeposit();
    await seedQbRow(dep, gift);
    const po = await seedPayout({ depositId: dep });
    await seedCountedCharge(po, gift);

    const affected = await db.transaction((tx) =>
      supersede.applySupersedeForPayoutInTx(tx, po),
    );
    expect(affected).toEqual([gift]);

    const rows = await readQbRows(dep);
    expect(rows[0].linkRole).toBe("corroborating");

    // Payout with no settled deposit at all → no-op.
    const bare = await seedPayout();
    const none = await db.transaction((tx) =>
      supersede.applySupersedeForPayoutInTx(tx, bare),
    );
    expect(none).toEqual([]);
  });
});
