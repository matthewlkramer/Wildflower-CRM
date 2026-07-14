import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `stripe_switch_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID };
    next();
  },
}));

const RUN = `stripe_switch_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const GIFT_ID = `${RUN}_gift`;
const ALLOCATION_ID = `${RUN}_allocation`;
const OLD_CHARGE_ID = `${RUN}_old_charge`;
const NEW_CHARGE_ID = `${RUN}_new_charge`;
const OLD_APPLICATION_ID = `${RUN}_old_application`;

let schema: typeof import("@workspace/db");
let db: typeof import("@workspace/db").db;
let eqFn: typeof import("drizzle-orm").eq;
let inArrayFn: typeof import("drizzle-orm").inArray;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = schema.db;
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Stripe Switch Org ${RUN}`,
  });
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    amount: "156.48",
    organizationId: ORG_ID,
    dateReceived: "2026-07-01",
    details: "Ledger source switch fixture",
  });
  await db.insert(schema.giftAllocations).values({
    id: ALLOCATION_ID,
    giftId: GIFT_ID,
    subAmount: "156.48",
  });
  await db.insert(schema.stripeStagedCharges).values([
    {
      id: OLD_CHARGE_ID,
      stripeAccountId: `${RUN}_acct`,
      grossAmount: "156.48",
      feeAmount: "7.58",
      netAmount: "148.90",
      dateReceived: "2026-07-01",
      payerName: "Incumbent Donor",
      organizationId: ORG_ID,
      matchStatus: "matched",
      matchConfirmedByUserId: TEST_USER_ID,
      matchConfirmedAt: new Date(),
      approvedByUserId: TEST_USER_ID,
      approvedAt: new Date(),
    },
    {
      id: NEW_CHARGE_ID,
      stripeAccountId: `${RUN}_acct`,
      grossAmount: "156.48",
      feeAmount: "7.58",
      netAmount: "148.90",
      dateReceived: "2026-07-01",
      payerName: "Replacement Donor",
      organizationId: ORG_ID,
      matchStatus: "matched",
    },
  ]);
  await db.insert(schema.paymentApplications).values({
    id: OLD_APPLICATION_ID,
    giftId: GIFT_ID,
    stripeChargeId: OLD_CHARGE_ID,
    evidenceSource: "stripe",
    amountApplied: "156.48",
    linkRole: "counted",
    lifecycle: "confirmed",
    matchMethod: "human",
    confirmedByUserId: TEST_USER_ID,
    confirmedAt: new Date(),
    createdTheGift: false,
  });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));

  await db
    .delete(schema.paymentApplications)
    .where(
      inArrayFn(schema.paymentApplications.stripeChargeId, [
        OLD_CHARGE_ID,
        NEW_CHARGE_ID,
      ]),
    );
  await db
    .delete(schema.stripeStagedCharges)
    .where(
      inArrayFn(schema.stripeStagedCharges.id, [OLD_CHARGE_ID, NEW_CHARGE_ID]),
    );
  await db
    .delete(schema.giftAllocations)
    .where(eqFn(schema.giftAllocations.id, ALLOCATION_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("ledger-authoritative Stripe source switching", () => {
  it("orphans the incumbent application and confirms the exact selected charge", async () => {
    const response = await fetch(
      `${baseUrl}/api/stripe-staged-charges/${NEW_CHARGE_ID}/link-gift`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ giftId: GIFT_ID, switchStripeSource: true }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.resolvedGiftId).toBe(GIFT_ID);
    expect(body.status).toBe("match_confirmed");
    expect("matchedGiftId" in body).toBe(false);
    expect("createdGiftId" in body).toBe(false);

    const applications = await db
      .select({
        stripeChargeId: schema.paymentApplications.stripeChargeId,
        giftId: schema.paymentApplications.giftId,
        lifecycle: schema.paymentApplications.lifecycle,
      })
      .from(schema.paymentApplications)
      .where(eqFn(schema.paymentApplications.giftId, GIFT_ID));

    expect(applications).toEqual([
      expect.objectContaining({
        stripeChargeId: NEW_CHARGE_ID,
        giftId: GIFT_ID,
        lifecycle: "confirmed",
      }),
    ]);

    const charges = await db
      .select({
        id: schema.stripeStagedCharges.id,
        matchedGiftId: schema.stripeStagedCharges.matchedGiftId,
        createdGiftId: schema.stripeStagedCharges.createdGiftId,
        matchConfirmedAt: schema.stripeStagedCharges.matchConfirmedAt,
      })
      .from(schema.stripeStagedCharges)
      .where(
        inArrayFn(schema.stripeStagedCharges.id, [OLD_CHARGE_ID, NEW_CHARGE_ID]),
      );
    const oldCharge = charges.find((row) => row.id === OLD_CHARGE_ID);
    const newCharge = charges.find((row) => row.id === NEW_CHARGE_ID);

    expect(oldCharge?.matchConfirmedAt).toBeNull();
    expect(newCharge?.matchConfirmedAt).not.toBeNull();
    expect(oldCharge?.matchedGiftId).toBeNull();
    expect(oldCharge?.createdGiftId).toBeNull();
    expect(newCharge?.matchedGiftId).toBeNull();
    expect(newCharge?.createdGiftId).toBeNull();
  });
});
