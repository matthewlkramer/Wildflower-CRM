import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearPaymentApplicationsForGiftIds,
  clearPaymentApplicationsForStagedIds,
} from "./paymentApplicationsTestUtil";

/**
 * DB-backed coverage for the structural counted-uniqueness invariant: ONE
 * nullable `payment_units.gift_id` per canonical payment unit. The shared
 * booking service rejects attempts to point an already-tied unit at a second
 * gift, while same-gift refresh and explicit clear-then-repoint remain valid.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `cuq_${Date.now()}`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;
const ORG_ID = `${RUN}_org`;
const USER_ID = `${RUN}_user`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stagedPayments: Db["stagedPayments"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  donorboxDonations: Db["donorboxDonations"];
  paymentUnits: Db["paymentUnits"];
  organizations: Db["organizations"];
  users: Db["users"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let pa: typeof import("../lib/paymentApplications");

const stagedIds: string[] = [];
const giftIds: string[] = [];
const chargeIds: string[] = [];
const donationIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedGift(): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: "100.00",
    organizationId: ORG_ID,
    details: "Counted-uniqueness invariant test gift.",
  });
  await db.insert(schema.giftAllocations).values({
    id: nextId("alloc"),
    giftId: id,
    subAmount: "100.00",
  });
  giftIds.push(id);
  return id;
}

async function seedQbStagedPayment(): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "sales_receipt",
    qbEntityId: nextId("qbe"),
    amount: "100.00",
    dateReceived: "2026-04-01",
    payerName: "Uniq Donor",
    autoApplied: false,
  });
  stagedIds.push(id);
  return id;
}

async function seedCharge(): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    grossAmount: "100.00",
    netAmount: "96.80",
    dateReceived: "2026-04-01",
  });
  chargeIds.push(id);
  return id;
}

async function seedDonation(): Promise<string> {
  const id = nextId("db");
  await db.insert(schema.donorboxDonations).values({ id, amount: "100.00" });
  donationIds.push(id);
  return id;
}

type AnchorArgs =
  | { evidenceSource: "quickbooks"; paymentId: string }
  | { evidenceSource: "stripe"; stripeChargeId: string }
  | { evidenceSource: "donorbox"; donorboxDonationId: string };

async function apply(anchor: AnchorArgs, giftId: string, amount: string) {
  return db.transaction((tx) =>
    pa.applyPaymentApplication(tx, {
      ...anchor,
      giftId,
      amountApplied: amount,
      confirmedByUserId: USER_ID,
      confirmedAt: new Date("2026-04-02T00:00:00Z"),
    }),
  );
}

function anchorWhere(anchor: AnchorArgs) {
  const anchorId =
    anchor.evidenceSource === "quickbooks"
      ? anchor.paymentId
      : anchor.evidenceSource === "stripe"
        ? anchor.stripeChargeId
        : anchor.donorboxDonationId;
  return eqFn(schema.paymentUnits.id, `pu_${anchorId}`);
}

/** The unit's counted tie (payment_units.gift_id — the sole tie surface). */
async function readRows(anchor: AnchorArgs) {
  const rows = await db
    .select({ giftId: schema.paymentUnits.giftId })
    .from(schema.paymentUnits)
    .where(anchorWhere(anchor));
  return rows.filter((r) => r.giftId !== null);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    stagedPayments: dbMod.stagedPayments,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    donorboxDonations: dbMod.donorboxDonations,
    paymentUnits: dbMod.paymentUnits,
    organizations: dbMod.organizations,
    users: dbMod.users,
  };
  eqFn = drizzle.eq;
  andFn = drizzle.and;
  inArrayFn = drizzle.inArray;
  pa = await import("../lib/paymentApplications");

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `${RUN}_clerk`,
    email: `${RUN}@wildflowerschools.org`,
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Counted Uniqueness Org ${RUN}`,
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await clearPaymentApplicationsForGiftIds(giftIds);
  await clearPaymentApplicationsForStagedIds(stagedIds);
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (donationIds.length)
    await db
      .delete(schema.donorboxDonations)
      .where(inArrayFn(schema.donorboxDonations.id, donationIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
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

describe.skipIf(!HAS_DB)("counted-uniqueness invariant (DB)", () => {
  it("QB anchor: second-gift apply throws even when amounts fit the cap", async () => {
    const giftA = await seedGift();
    const giftB = await seedGift();
    const sp = await seedQbStagedPayment();
    const anchor = { evidenceSource: "quickbooks", paymentId: sp } as const;

    await apply(anchor, giftA, "60.00");
    // 60 + 30 <= 100: the old book-once cap alone would ALLOW this — the
    // counted-uniqueness guard must reject it regardless.
    const err = await apply(anchor, giftB, "30.00").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(pa.AnchorAlreadyCountedError);
    expect((err as InstanceType<typeof pa.AnchorAlreadyCountedError>).anchorId).toBe(sp);
    expect(
      (err as InstanceType<typeof pa.AnchorAlreadyCountedError>).existingGiftId,
    ).toBe(giftA);
    expect(
      (err as InstanceType<typeof pa.AnchorAlreadyCountedError>).attemptedGiftId,
    ).toBe(giftB);

    const rows = await readRows(anchor);
    expect(rows).toEqual([{ giftId: giftA }]);
  });

  it("stripe anchor: second-gift apply throws even when amounts fit the cap", async () => {
    const giftA = await seedGift();
    const giftB = await seedGift();
    const ch = await seedCharge();
    const anchor = { evidenceSource: "stripe", stripeChargeId: ch } as const;

    await apply(anchor, giftA, "50.00");
    await expect(apply(anchor, giftB, "40.00")).rejects.toBeInstanceOf(
      pa.AnchorAlreadyCountedError,
    );

    const rows = await readRows(anchor);
    expect(rows).toEqual([{ giftId: giftA }]);
  });

  it("same-gift re-apply stays idempotent: one tie, facts refreshed", async () => {
    const gift = await seedGift();
    const sp = await seedQbStagedPayment();
    const anchor = { evidenceSource: "quickbooks", paymentId: sp } as const;

    await apply(anchor, gift, "60.00");
    await apply(anchor, gift, "55.00");

    const rows = await readRows(anchor);
    expect(rows).toEqual([{ giftId: gift }]);
  });

  it("re-point inside one tx (clear old tie, then apply) passes", async () => {
    const giftA = await seedGift();
    const giftB = await seedGift();
    const sp = await seedQbStagedPayment();
    const anchor = { evidenceSource: "quickbooks", paymentId: sp } as const;

    await apply(anchor, giftA, "100.00");
    await db.transaction(async (tx) => {
      await tx
        .update(schema.paymentUnits)
        .set({ ...pa.CLEARED_TIE_FACTS })
        .where(eqFn(schema.paymentUnits.id, `pu_${sp}`));
      await pa.applyPaymentApplication(tx, {
        evidenceSource: "quickbooks",
        paymentId: sp,
        giftId: giftB,
        amountApplied: "100.00",
        confirmedByUserId: USER_ID,
        confirmedAt: new Date("2026-04-03T00:00:00Z"),
      });
    });

    const rows = await readRows(anchor);
    expect(rows).toEqual([{ giftId: giftB }]);
  });

});
