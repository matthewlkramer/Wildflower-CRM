import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { clearPaymentApplicationsForGiftIds } from "./paymentApplicationsTestUtil";

/**
 * Regression for the Jamie/Dionne failure shape: two Stripe charges have the
 * exact same gross amount, but belong to different donors and different gifts.
 * The link endpoint must persist the immutable charge id selected in the URL;
 * it must never rediscover a charge by amount, date, payer name, or candidate
 * ordering.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `same_amount_user_${Date.now()}`,
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

const RUN = `same_amount_${Date.now()}`;
const ACCOUNT_ID = `${RUN}_acct`;
const ORG_JAMIE = `${RUN}_org_jamie`;
const ORG_DIONNE = `${RUN}_org_dionne`;
const GIFT_JAMIE = `${RUN}_gift_jamie`;
const GIFT_DIONNE = `${RUN}_gift_dionne`;
const ALLOC_JAMIE = `${RUN}_alloc_jamie`;
const ALLOC_DIONNE = `${RUN}_alloc_dionne`;
const CHARGE_JAMIE = `${RUN}_charge_jamie`;
const CHARGE_DIONNE = `${RUN}_charge_dionne`;
const SAME_AMOUNT = "156.48";

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  paymentApplications: Db["paymentApplications"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let andFn: (typeof import("drizzle-orm"))["and"];
let server: Server;
let baseUrl = "";

async function apiPost(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

beforeAll(async () => {
  if (!HAS_DB) return;

  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    paymentApplications: dbMod.paymentApplications,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  andFn = drizzle.and;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });

  await db.insert(schema.organizations).values([
    { id: ORG_JAMIE, name: `Jamie Rue ${RUN}` },
    { id: ORG_DIONNE, name: `Dionne Kirby ${RUN}` },
  ]);

  await db.insert(schema.giftsAndPayments).values([
    {
      id: GIFT_JAMIE,
      amount: SAME_AMOUNT,
      organizationId: ORG_JAMIE,
      details: "same-amount exact-id Jamie fixture",
      dateReceived: "2026-07-01",
    },
    {
      id: GIFT_DIONNE,
      amount: SAME_AMOUNT,
      organizationId: ORG_DIONNE,
      details: "same-amount exact-id Dionne fixture",
      dateReceived: "2026-07-01",
    },
  ]);

  await db.insert(schema.giftAllocations).values([
    { id: ALLOC_JAMIE, giftId: GIFT_JAMIE, subAmount: SAME_AMOUNT },
    { id: ALLOC_DIONNE, giftId: GIFT_DIONNE, subAmount: SAME_AMOUNT },
  ]);

  await db.insert(schema.stripeStagedCharges).values([
    {
      id: CHARGE_JAMIE,
      stripeAccountId: ACCOUNT_ID,
      grossAmount: SAME_AMOUNT,
      feeAmount: "7.58",
      netAmount: "148.90",
      dateReceived: "2026-07-01",
      payerName: "Jamie Rue",
      payerEmail: `jamie.${RUN}@example.test`,
      matchStatus: "unmatched",
    },
    {
      id: CHARGE_DIONNE,
      stripeAccountId: ACCOUNT_ID,
      grossAmount: SAME_AMOUNT,
      feeAmount: "7.58",
      netAmount: "148.90",
      dateReceived: "2026-07-01",
      payerName: "Dionne Kirby",
      payerEmail: `dionne.${RUN}@example.test`,
      matchStatus: "unmatched",
    },
  ]);

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

  await clearPaymentApplicationsForGiftIds([GIFT_JAMIE, GIFT_DIONNE]);
  await db
    .delete(schema.giftAllocations)
    .where(inArrayFn(schema.giftAllocations.id, [ALLOC_JAMIE, ALLOC_DIONNE]));
  await db
    .delete(schema.giftsAndPayments)
    .where(inArrayFn(schema.giftsAndPayments.id, [GIFT_JAMIE, GIFT_DIONNE]));
  await db
    .delete(schema.stripeStagedCharges)
    .where(inArrayFn(schema.stripeStagedCharges.id, [CHARGE_JAMIE, CHARGE_DIONNE]));
  await db
    .delete(schema.organizations)
    .where(inArrayFn(schema.organizations.id, [ORG_JAMIE, ORG_DIONNE]));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("same-amount Stripe charge exact-ID routing", () => {
  it("persists each selected charge to its selected gift without cross-linking", async () => {
    const jamie = await apiPost(
      `/api/stripe-staged-charges/${CHARGE_JAMIE}/link-gift`,
      { giftId: GIFT_JAMIE },
    );
    expect(jamie.status).toBe(200);

    const dionne = await apiPost(
      `/api/stripe-staged-charges/${CHARGE_DIONNE}/link-gift`,
      { giftId: GIFT_DIONNE },
    );
    expect(dionne.status).toBe(200);

    const applications = await db
      .select({
        stripeChargeId: schema.paymentApplications.stripeChargeId,
        giftId: schema.paymentApplications.giftId,
        amountApplied: schema.paymentApplications.amountApplied,
        lifecycle: schema.paymentApplications.lifecycle,
        linkRole: schema.paymentApplications.linkRole,
      })
      .from(schema.paymentApplications)
      .where(
        andFn(
          inArrayFn(schema.paymentApplications.stripeChargeId, [
            CHARGE_JAMIE,
            CHARGE_DIONNE,
          ]),
          inArrayFn(schema.paymentApplications.giftId, [GIFT_JAMIE, GIFT_DIONNE]),
        ),
      );

    expect(applications).toHaveLength(2);
    expect(applications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stripeChargeId: CHARGE_JAMIE,
          giftId: GIFT_JAMIE,
          amountApplied: SAME_AMOUNT,
          lifecycle: "confirmed",
          linkRole: "counted",
        }),
        expect.objectContaining({
          stripeChargeId: CHARGE_DIONNE,
          giftId: GIFT_DIONNE,
          amountApplied: SAME_AMOUNT,
          lifecycle: "confirmed",
          linkRole: "counted",
        }),
      ]),
    );

    expect(
      applications.some(
        (row) =>
          row.stripeChargeId === CHARGE_JAMIE && row.giftId === GIFT_DIONNE,
      ),
    ).toBe(false);
    expect(
      applications.some(
        (row) =>
          row.stripeChargeId === CHARGE_DIONNE && row.giftId === GIFT_JAMIE,
      ),
    ).toBe(false);
  });

  it("does not replace an incumbent same-amount charge without an explicit switch", async () => {
    const response = await apiPost(
      `/api/stripe-staged-charges/${CHARGE_DIONNE}/link-gift`,
      { giftId: GIFT_JAMIE },
    );

    expect(response.status).toBe(409);
    expect(response.json?.error).toBe("not_pending");

    const [jamieOwner] = await db
      .select({
        stripeChargeId: schema.paymentApplications.stripeChargeId,
        giftId: schema.paymentApplications.giftId,
      })
      .from(schema.paymentApplications)
      .where(
        andFn(
          eqFn(schema.paymentApplications.stripeChargeId, CHARGE_JAMIE),
          eqFn(schema.paymentApplications.giftId, GIFT_JAMIE),
        ),
      );

    expect(jamieOwner).toEqual({
      stripeChargeId: CHARGE_JAMIE,
      giftId: GIFT_JAMIE,
    });
  });
});
