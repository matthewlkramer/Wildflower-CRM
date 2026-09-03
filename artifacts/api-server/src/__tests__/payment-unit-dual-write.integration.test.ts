import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  clearPaymentApplicationsForGiftIds,
  clearPaymentApplicationsForStagedIds,
  unitIdForAnchor,
} from "./paymentApplicationsTestUtil";

/**
 * DB-backed coverage for the unit→gift booking write surface
 * (docs/adr-bank-spine-money-model.md, docs/adr-unit-gift-pointer.md):
 *
 *   - applyPaymentApplication resolves (or creates) the canonical
 *     payment_units row for its source anchor and sets the counted tie
 *     facts (gift_id + 0201 columns) on it;
 *   - UNIT-level counted uniqueness: booking the SAME unit via a DIFFERENT
 *     source anchor converges (same gift) or throws
 *     AnchorAlreadyCountedError (different gift) — one gift per unit.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `pudw_${process.pid}_${Date.now()}_${randomUUID()}`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;
const ORG_ID = `${RUN}_org`;
const USER_ID = `${RUN}_user`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stagedPayments: Db["stagedPayments"];
  giftsAndPayments: Db["giftsAndPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  donorboxDonations: Db["donorboxDonations"];
  paymentUnits: Db["paymentUnits"];
  organizations: Db["organizations"];
  users: Db["users"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let pa: typeof import("../lib/paymentApplications");

const stagedIds: string[] = [];
const giftIds: string[] = [];
const chargeIds: string[] = [];
const donationIds: string[] = [];
const unitIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedGift(): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: "100.00",
    organizationId: ORG_ID,
    details: "Payment-unit dual-write test gift.",
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
    dateReceived: "2026-05-01",
    payerName: "Unit Donor",
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
    dateReceived: "2026-05-01",
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

async function seedStripeUnit(chargeId: string): Promise<string> {
  const id = `pu_${chargeId}`;
  await db.insert(schema.paymentUnits).values({
    id,
    kind: "stripe_charge",
    stripeChargeId: chargeId,
    grossAmount: "100.00",
    currency: "USD",
  });
  unitIds.push(id);
  return id;
}

/** An offline-check unit: QBO row is the source, Donorbox donation is the
 * pointer — the double-description case unit consolidation exists for. */
async function seedCheckUnit(
  stagedId: string,
  donationId: string | null,
): Promise<string> {
  const id = `pu_${stagedId}`;
  await db.insert(schema.paymentUnits).values({
    id,
    kind: "check",
    sourceStagedPaymentId: stagedId,
    donorboxDonationId: donationId,
    grossAmount: "100.00",
    currency: "USD",
  });
  unitIds.push(id);
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
      confirmedAt: new Date("2026-05-02T00:00:00Z"),
    }),
  );
}

/** The unit's counted tie (empty when untied). */
async function readUnitRows(unitId: string) {
  const rows = await db
    .select({
      id: schema.paymentUnits.id,
      giftId: schema.paymentUnits.giftId,
    })
    .from(schema.paymentUnits)
    .where(eqFn(schema.paymentUnits.id, unitId));
  return rows.flatMap((r) =>
    r.giftId ? [{ giftId: r.giftId, paymentUnitId: r.id }] : [],
  );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    stagedPayments: dbMod.stagedPayments,
    giftsAndPayments: dbMod.giftsAndPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    donorboxDonations: dbMod.donorboxDonations,
    paymentUnits: dbMod.paymentUnits,
    organizations: dbMod.organizations,
    users: dbMod.users,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  pa = await import("../lib/paymentApplications");

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `${RUN}_clerk`,
    email: `${RUN}@wildflowerschools.org`,
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Payment Unit Dual Write Org ${RUN}`,
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await clearPaymentApplicationsForGiftIds(giftIds);
  await clearPaymentApplicationsForStagedIds(stagedIds);
  if (unitIds.length)
    await db
      .delete(schema.paymentUnits)
      .where(inArrayFn(schema.paymentUnits.id, unitIds));
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
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
});

describe.skipIf(!HAS_DB)("payment-unit gift ties (DB)", () => {
  it("sets the counted tie on the anchor's existing unit", async () => {
    const gift = await seedGift();
    const ch = await seedCharge();
    const unit = await seedStripeUnit(ch);

    await apply({ evidenceSource: "stripe", stripeChargeId: ch }, gift, "100.00");

    const rows = await readUnitRows(unit);
    expect(rows).toEqual([{ giftId: gift, paymentUnitId: unit }]);
  });

  it("creates the canonical unit when the anchor has no unit yet", async () => {
    const gift = await seedGift();
    const ch = await seedCharge();

    await apply({ evidenceSource: "stripe", stripeChargeId: ch }, gift, "100.00");

    const rows = await db
      .select({
        id: schema.paymentUnits.id,
        giftId: schema.paymentUnits.giftId,
      })
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.stripeChargeId, ch));
    expect(rows).toEqual([{ id: `pu_${ch}`, giftId: gift }]);
  });

  it("same unit, same gift via another source: converges on ONE counted tie", async () => {
    const gift = await seedGift();
    const sp = await seedQbStagedPayment();
    const dn = await seedDonation();
    const unit = await seedCheckUnit(sp, dn);

    // The offline-check double description: booked from Donorbox first…
    await apply({ evidenceSource: "donorbox", donorboxDonationId: dn }, gift, "100.00");
    // …then from its QBO deposit row. Same unit + same gift = same booking:
    // the QB write must supersede the Donorbox description, not duplicate it.
    await apply({ evidenceSource: "quickbooks", paymentId: sp }, gift, "100.00");

    const rows = await readUnitRows(unit);
    expect(rows).toEqual([{ giftId: gift, paymentUnitId: unit }]);
  });

  it("same unit via another source but a DIFFERENT gift: throws", async () => {
    const giftA = await seedGift();
    const giftB = await seedGift();
    const sp = await seedQbStagedPayment();
    const dn = await seedDonation();
    const unit = await seedCheckUnit(sp, dn);

    await apply({ evidenceSource: "donorbox", donorboxDonationId: dn }, giftA, "100.00");
    const err = await apply(
      { evidenceSource: "quickbooks", paymentId: sp },
      giftB,
      "100.00",
    ).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(pa.AnchorAlreadyCountedError);

    const rows = await readUnitRows(unit);
    expect(rows).toEqual([{ giftId: giftA, paymentUnitId: unit }]);
  });

  it("writes payment_units.gift_id as the counted authority", async () => {
    const gift = await seedGift();
    const ch = await seedCharge();
    const unit = await seedStripeUnit(ch);

    await apply({ evidenceSource: "stripe", stripeChargeId: ch }, gift, "100.00");
    let [pu] = await db
      .select({ giftId: schema.paymentUnits.giftId })
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, unit));
    expect(pu?.giftId).toBe(gift);

    await db.transaction(async (tx) => {
      await pa.removePaymentApplicationsForStripeCharge(tx, ch);
    });
    [pu] = await db
      .select({ giftId: schema.paymentUnits.giftId })
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, unit));
    expect(pu?.giftId).toBeNull();
  });

  it("writes and clears the tie facts with the counted pointer", async () => {
    const gift = await seedGift();
    const ch = await seedCharge();
    const unit = await seedStripeUnit(ch);

    const readFacts = () =>
      db
        .select({
          giftId: schema.paymentUnits.giftId,
          giftMatchMethod: schema.paymentUnits.giftMatchMethod,
          giftConfirmedByUserId: schema.paymentUnits.giftConfirmedByUserId,
          giftConfirmedAt: schema.paymentUnits.giftConfirmedAt,
          createdTheGift: schema.paymentUnits.createdTheGift,
        })
        .from(schema.paymentUnits)
        .where(eqFn(schema.paymentUnits.id, unit))
        .then((r) => r[0]);

    await db.transaction((tx) =>
      pa.applyPaymentApplication(tx, {
        evidenceSource: "stripe",
        stripeChargeId: ch,
        giftId: gift,
        amountApplied: "100.00",
        matchMethod: "human",
        confirmedByUserId: USER_ID,
        confirmedAt: new Date("2026-05-02T00:00:00Z"),
        createdTheGift: true,
      }),
    );
    let facts = await readFacts();
    expect(facts).toEqual({
      giftId: gift,
      giftMatchMethod: "human",
      giftConfirmedByUserId: USER_ID,
      giftConfirmedAt: new Date("2026-05-02T00:00:00Z"),
      createdTheGift: true,
    });

    // Removing the counted tie clears the facts back to the untied shape.
    await db.transaction(async (tx) => {
      await pa.removePaymentApplicationsForStripeCharge(tx, ch);
    });
    facts = await readFacts();
    expect(facts).toEqual({
      giftId: null,
      giftMatchMethod: null,
      giftConfirmedByUserId: null,
      giftConfirmedAt: null,
      createdTheGift: false,
    });
  });

  it("confirm promotes system → system_confirmed on the unit facts too", async () => {
    const gift = await seedGift();
    const sp = await seedQbStagedPayment();

    await db.transaction((tx) =>
      pa.applyPaymentApplication(tx, {
        evidenceSource: "quickbooks",
        paymentId: sp,
        giftId: gift,
        amountApplied: "100.00",
        matchMethod: "system",
      }),
    );
    const unit = await unitIdForAnchor("quickbooks", sp);
    unitIds.push(unit!);

    await db.transaction(async (tx) => {
      await pa.confirmPaymentApplicationsForPayment(
        tx,
        sp,
        USER_ID,
        new Date("2026-05-03T00:00:00Z"),
      );
    });
    const [facts] = await db
      .select({
        giftMatchMethod: schema.paymentUnits.giftMatchMethod,
        giftConfirmedByUserId: schema.paymentUnits.giftConfirmedByUserId,
      })
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, unit!));
    expect(facts).toEqual({
      giftMatchMethod: "system_confirmed",
      giftConfirmedByUserId: USER_ID,
    });
  });
});
