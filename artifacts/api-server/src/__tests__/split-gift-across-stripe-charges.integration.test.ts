import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `splitstripe_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const PERSON_ID = `${RUN}_person`;
const OTHER_PERSON_ID = `${RUN}_other_person`;
const OTHER_GIFT_ID = `${RUN}_other_gift`;
const OTHER_ALLOC_ID = `${RUN}_other_alloc`;
const ORPHAN_GIFT_ID = `${RUN}_orphan_gift`;
const ENTITY_ID = `${RUN}_entity`;
const BANK_ID = `${RUN}_bank`;
const PAYOUT_ID = `${RUN}_payout`;
const GIFT_ID = `${RUN}_gift`;
const ALLOC_ID = `${RUN}_alloc`;
const FISCAL_YEAR_ID = `${RUN}_fy`;
const CHARGE_IDS = [0, 1, 2, 3].map((index) => `${RUN}_ch_${index}`);
const UNIT_IDS = CHARGE_IDS.map((id) => `pu_${id}`);

const auth = vi.hoisted(() => ({
  current: { id: "", role: "finance" } as { id: string; role: string },
}));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = auth.current;
    next();
  },
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

let db: (typeof import("@workspace/db"))["db"];
let schema: typeof import("@workspace/db");
let server: Server;
let baseUrl = "";
let createdGiftIds: string[] = [];

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  auth.current = { id: USER_ID, role: "finance" };
  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "finance",
  });
  await db.insert(schema.people).values([
    { id: PERSON_ID, firstName: "Erica", lastName: "Cantoni" },
    { id: OTHER_PERSON_ID, firstName: "Another", lastName: "Donor" },
  ]);
  await db
    .insert(schema.entities)
    .values({ id: ENTITY_ID, name: `Entity ${RUN}`, expectsPayment: true });
  await db.insert(schema.fiscalYears).values({
    id: FISCAL_YEAR_ID,
    label: `Test FY ${RUN}`,
    startDate: "2099-07-01",
    endDate: "2100-06-30",
    auditClosedAt: new Date(),
    auditClosedByUserId: USER_ID,
  });
  await db.insert(schema.bankDeposits).values({
    id: BANK_ID,
    source: "manual",
    amount: "18.00",
    depositDate: "2099-11-17",
    currency: "USD",
  });
  await db.insert(schema.stripePayouts).values({
    id: PAYOUT_ID,
    stripeAccountId: `${RUN}_acct`,
    amount: "18.00",
    grossTotal: "20.00",
    feeTotal: "2.00",
    refundTotal: "0.00",
    adjustmentTotal: "0.00",
    netTotal: "18.00",
    bankDepositId: BANK_ID,
  });
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    name: "Erica Cantoni",
    amount: "18.00",
    dateReceived: "2099-11-13",
    individualGiverPersonId: PERSON_ID,
    ownerUserId: USER_ID,
  });
  await db.insert(schema.giftAllocations).values({
    id: ALLOC_ID,
    giftId: GIFT_ID,
    subAmount: "18.00",
    entityId: ENTITY_ID,
    intendedUsage: "gen_ops",
    countsTowardGoal: true,
  });
  await db.insert(schema.giftsAndPayments).values({
    id: OTHER_GIFT_ID,
    name: "Another donor's gift",
    amount: "18.00",
    dateReceived: "2099-11-13",
    individualGiverPersonId: OTHER_PERSON_ID,
    ownerUserId: USER_ID,
  });
  await db.insert(schema.giftAllocations).values({
    id: OTHER_ALLOC_ID,
    giftId: OTHER_GIFT_ID,
    subAmount: "18.00",
    entityId: ENTITY_ID,
    intendedUsage: "gen_ops",
    countsTowardGoal: true,
  });
  // Legacy orphan (pre-dates the allocation-seeding invariant): header only,
  // deliberately NO gift_allocations row.
  await db.insert(schema.giftsAndPayments).values({
    id: ORPHAN_GIFT_ID,
    name: "Erica Cantoni (orphan)",
    amount: "18.00",
    dateReceived: "2099-11-13",
    individualGiverPersonId: PERSON_ID,
    ownerUserId: USER_ID,
  });
  await db.insert(schema.stripeStagedCharges).values(
    CHARGE_IDS.map((id, index) => ({
      id,
      stripeAccountId: `${RUN}_acct`,
      stripePayoutId: PAYOUT_ID,
      grossAmount: "5.00",
      feeAmount: "0.50",
      netAmount: "4.50",
      dateReceived: index < 3 ? "2099-11-13" : "2099-11-12",
      payerName: "Erica Cantoni",
      individualGiverPersonId: PERSON_ID,
    })),
  );
  await db.insert(schema.paymentUnits).values(
    CHARGE_IDS.map((chargeId, index) => ({
      id: UNIT_IDS[index],
      kind: "stripe_charge" as const,
      stripeChargeId: chargeId,
      grossAmount: "5.00",
      feeAmount: "0.50",
      netAmount: "4.50",
      receivedDate: index < 3 ? "2099-11-13" : "2099-11-12",
      giftId: null,
      giftMatchMethod: null,
      giftConfirmedByUserId: null,
      giftConfirmedAt: null,
    })),
  );
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(schema.paymentUnits)
    .where(inArray(schema.paymentUnits.id, UNIT_IDS));
  const splitIds = createdGiftIds.length ? createdGiftIds : [GIFT_ID];
  const allGiftIds = [...splitIds, OTHER_GIFT_ID, ORPHAN_GIFT_ID];
  await db
    .delete(schema.giftAllocations)
    .where(inArray(schema.giftAllocations.giftId, allGiftIds));
  await db
    .delete(schema.giftsAndPayments)
    .where(inArray(schema.giftsAndPayments.id, allGiftIds));
  await db
    .delete(schema.stripeStagedCharges)
    .where(inArray(schema.stripeStagedCharges.id, CHARGE_IDS));
  await db
    .delete(schema.stripePayouts)
    .where(eq(schema.stripePayouts.id, PAYOUT_ID));
  await db
    .delete(schema.bankDeposits)
    .where(eq(schema.bankDeposits.id, BANK_ID));
  await db.delete(schema.entities).where(eq(schema.entities.id, ENTITY_ID));
  await db
    .delete(schema.fiscalYears)
    .where(eq(schema.fiscalYears.id, FISCAL_YEAR_ID));
  await db
    .delete(schema.people)
    .where(inArray(schema.people.id, [PERSON_ID, OTHER_PERSON_ID]));
  await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("split gift across Stripe charges", () => {
  it("does not split a gift in an audit-closed fiscal year", async () => {
    const response = await fetch(
      `${baseUrl}/api/reconciliation/deposits/${BANK_ID}/split-gift-across-stripe-charges`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ giftId: GIFT_ID }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "fiscal_year_frozen",
    });
    await db
      .update(schema.fiscalYears)
      .set({ auditClosedAt: null, auditClosedByUserId: null })
      .where(eq(schema.fiscalYears.id, FISCAL_YEAR_ID));
  });

  it("rejects a gift whose donor disagrees with resolved Stripe donor evidence", async () => {
    const response = await fetch(
      `${baseUrl}/api/reconciliation/deposits/${BANK_ID}/split-gift-across-stripe-charges`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ giftId: OTHER_GIFT_ID }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "donor_mismatch",
    });
  });

  it("rejects a legacy orphan gift with zero allocations with a specific error", async () => {
    const response = await fetch(
      `${baseUrl}/api/reconciliation/deposits/${BANK_ID}/split-gift-across-stripe-charges`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ giftId: ORPHAN_GIFT_ID }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "no_allocations",
    });
  });

  it("converts a net payout gift into one gross gift per charge", async () => {
    await db
      .update(schema.paymentUnits)
      .set({
        giftId: GIFT_ID,
        giftMatchMethod: "human",
        giftConfirmedByUserId: USER_ID,
        giftConfirmedAt: new Date(),
      })
      .where(eq(schema.paymentUnits.id, UNIT_IDS[0]!));
    const response = await fetch(
      `${baseUrl}/api/reconciliation/deposits/${BANK_ID}/split-gift-across-stripe-charges`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ giftId: GIFT_ID }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      giftIds: string[];
      chargeIds: string[];
    };
    expect(body.giftIds).toHaveLength(4);
    createdGiftIds = body.giftIds;
    expect(new Set(body.chargeIds)).toEqual(new Set(CHARGE_IDS));

    const units = await db
      .select({
        giftId: schema.paymentUnits.giftId,
        amount: schema.paymentUnits.grossAmount,
      })
      .from(schema.paymentUnits)
      .where(inArray(schema.paymentUnits.id, UNIT_IDS));
    expect(new Set(units.map((row) => row.giftId)).size).toBe(4);
    expect(units.every((row) => row.amount === "5.00")).toBe(true);

    const gifts = await db
      .select({
        id: schema.giftsAndPayments.id,
        amount: schema.giftsAndPayments.amount,
        donor: schema.giftsAndPayments.individualGiverPersonId,
        date: schema.giftsAndPayments.dateReceived,
      })
      .from(schema.giftsAndPayments)
      .where(inArray(schema.giftsAndPayments.id, body.giftIds));
    expect(gifts).toHaveLength(4);
    expect(gifts.every((row) => row.amount === "5.00")).toBe(true);
    expect(gifts.every((row) => row.donor === PERSON_ID)).toBe(true);
    expect(gifts.every((row) => row.date === "2099-11-13")).toBe(true);

    const allocations = await db
      .select({
        giftId: schema.giftAllocations.giftId,
        amount: schema.giftAllocations.subAmount,
        entityId: schema.giftAllocations.entityId,
        usage: schema.giftAllocations.intendedUsage,
      })
      .from(schema.giftAllocations)
      .where(inArray(schema.giftAllocations.giftId, body.giftIds));
    expect(allocations).toHaveLength(4);
    expect(allocations.every((row) => row.amount === "5.00")).toBe(true);
    expect(allocations.every((row) => row.entityId === ENTITY_ID)).toBe(true);
    expect(allocations.every((row) => row.usage === "gen_ops")).toBe(true);
  });
});
