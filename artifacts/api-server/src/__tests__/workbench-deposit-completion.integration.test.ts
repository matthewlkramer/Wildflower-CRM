import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `deposit_complete_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

const RUN = `depositcomplete_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ACCOUNT_ID = `${RUN}_acct`;
let seq = 0;
const nextId = (prefix: string) => `${RUN}_${prefix}_${++seq}`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  bankDeposits: Db["bankDeposits"];
  bankDepositComponents: Db["bankDepositComponents"];
  paymentUnits: Db["paymentUnits"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stagedPayments: Db["stagedPayments"];
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  sourceLinks: Db["sourceLinks"];
};
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

const depositIds: string[] = [];
const componentIds: string[] = [];
const unitIds: string[] = [];
const giftIds: string[] = [];
const allocationIds: string[] = [];
const stagedIds: string[] = [];
const payoutIds: string[] = [];
const chargeIds: string[] = [];
const sourceLinkIds: string[] = [];

async function getWorkbench(lens: "all_open" | "completed", q: string) {
  const params = new URLSearchParams({ lens, q, limit: "50" });
  const response = await fetch(
    `${baseUrl}/api/reconciliation/workbench-deposits?${params}`,
  );
  return { status: response.status, json: await response.json() };
}

async function seedGift(amount: string, withAllocation = true) {
  const giftId = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id: giftId,
    amount,
    organizationId: ORG_ID,
    dateReceived: "2099-12-24",
    details: `${RUN} completion gift`,
  });
  giftIds.push(giftId);
  if (withAllocation) {
    const allocationId = nextId("allocation");
    await db.insert(schema.giftAllocations).values({
      id: allocationId,
      giftId,
      subAmount: amount,
    });
    allocationIds.push(allocationId);
  }
  return giftId;
}

async function seedDirectDeposit(opts: {
  memo: string;
  withAccounting: boolean;
  withAllocation?: boolean;
}) {
  const depositId = nextId("direct_deposit");
  const unitId = nextId("direct_unit");
  const componentId = nextId("direct_component");
  const giftId = await seedGift("1000.00", opts.withAllocation ?? true);
  const stagedId = opts.withAccounting ? nextId("direct_qbo") : null;

  await db.insert(schema.bankDeposits).values({
    id: depositId,
    source: "bank_csv_export",
    depositDate: "2099-12-24",
    amount: "1000.00",
    currency: "USD",
    account: ACCOUNT_ID,
    memo: opts.memo,
  });
  depositIds.push(depositId);

  if (stagedId) {
    await db.insert(schema.stagedPayments).values({
      id: stagedId,
      realmId: RUN,
      qbEntityType: "deposit",
      qbEntityId: nextId("direct_qb_entity"),
      dateReceived: "2099-12-24",
      amount: "1000.00",
      payerName: "Chia Ling Rodeski",
    });
    stagedIds.push(stagedId);
  }

  await db.insert(schema.paymentUnits).values({
    id: unitId,
    kind: "other",
    grossAmount: "1000.00",
    netAmount: "1000.00",
    receivedDate: "2099-12-24",
    giftId,
    sourceStagedPaymentId: stagedId,
  });
  unitIds.push(unitId);

  await db.insert(schema.bankDepositComponents).values({
    id: componentId,
    bankDepositId: depositId,
    paymentUnitId: unitId,
    amount: "1000.00",
    source: "manual",
    sourceStagedPaymentId: stagedId,
  });
  componentIds.push(componentId);

  return depositId;
}

async function seedStripeDeposit(memo: string) {
  const depositId = nextId("stripe_deposit");
  const payoutId = nextId("payout");
  const stagedId = nextId("stripe_qbo");
  const sourceLinkId = nextId("payout_qbo_link");

  await db.insert(schema.bankDeposits).values({
    id: depositId,
    source: "bank_csv_export",
    depositDate: "2099-11-17",
    amount: "18.00",
    currency: "USD",
    account: ACCOUNT_ID,
    memo,
  });
  depositIds.push(depositId);

  await db.insert(schema.stripePayouts).values({
    id: payoutId,
    stripeAccountId: ACCOUNT_ID,
    amount: "18.00",
    netTotal: "18.00",
    grossTotal: "20.00",
    feeTotal: "2.00",
    refundTotal: "0.00",
    adjustmentTotal: "0.00",
    chargeCount: 4,
    currency: "USD",
    status: "paid",
    arrivalDate: "2099-11-16",
    bankDepositId: depositId,
    ambiguousBankMatch: false,
  });
  payoutIds.push(payoutId);

  for (let index = 0; index < 4; index += 1) {
    const chargeId = nextId("charge");
    const unitId = nextId("stripe_unit");
    const giftId = await seedGift("5.00");
    await db.insert(schema.stripeStagedCharges).values({
      id: chargeId,
      stripeAccountId: ACCOUNT_ID,
      stripePayoutId: payoutId,
      grossAmount: "5.00",
      feeAmount: "0.50",
      netAmount: "4.50",
      amountRefunded: "0.00",
      currency: "USD",
      dateReceived: "2099-11-13",
      payerName: "Erica Cantoni",
      refunded: false,
      disputed: false,
      rawCharge: { status: "succeeded", captured: true },
    });
    chargeIds.push(chargeId);
    await db.insert(schema.paymentUnits).values({
      id: unitId,
      kind: "stripe_charge",
      grossAmount: "5.00",
      netAmount: "4.50",
      receivedDate: "2099-11-13",
      stripeChargeId: chargeId,
      giftId,
    });
    unitIds.push(unitId);
  }

  await db.insert(schema.stagedPayments).values({
    id: stagedId,
    realmId: RUN,
    qbEntityType: "deposit",
    qbEntityId: nextId("stripe_qb_entity"),
    dateReceived: "2099-11-17",
    amount: "18.00",
    payerName: "Erica Cantoni",
    fundingSource: "stripe",
  });
  stagedIds.push(stagedId);

  await db.insert(schema.sourceLinks).values({
    id: sourceLinkId,
    linkType: "payout_qb_settlement",
    stripePayoutId: payoutId,
    qbStagedPaymentId: stagedId,
    lifecycle: "confirmed",
    provenance: "system",
    matchBasis: "settled_pairing",
  });
  sourceLinkIds.push(sourceLinkId);

  return depositId;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    bankDeposits: dbMod.bankDeposits,
    bankDepositComponents: dbMod.bankDepositComponents,
    paymentUnits: dbMod.paymentUnits,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stagedPayments: dbMod.stagedPayments,
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    sourceLinks: dbMod.sourceLinks,
  };
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `${RUN} organization`,
  });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (sourceLinkIds.length)
    await db
      .delete(schema.sourceLinks)
      .where(inArrayFn(schema.sourceLinks.id, sourceLinkIds));
  if (componentIds.length)
    await db
      .delete(schema.bankDepositComponents)
      .where(inArrayFn(schema.bankDepositComponents.id, componentIds));
  if (unitIds.length)
    await db
      .delete(schema.paymentUnits)
      .where(inArrayFn(schema.paymentUnits.id, unitIds));
  if (allocationIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.id, allocationIds));
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (depositIds.length)
    await db
      .delete(schema.bankDeposits)
      .where(inArrayFn(schema.bankDeposits.id, depositIds));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
}, 60_000);

describe.skipIf(!HAS_DB)("deposit completion classification", () => {
  it("moves a Chia-shaped direct payment to Completed once CRM and accounting evidence are complete", async () => {
    const memo = `${RUN} chia direct completion`;
    const depositId = await seedDirectDeposit({ memo, withAccounting: true });

    const completed = await getWorkbench("completed", memo);
    expect(completed.status).toBe(200);
    expect(completed.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anchorId: depositId,
          status: "audit_ready",
          lenses: expect.arrayContaining(["completed"]),
          coverage: expect.objectContaining({ complete: true }),
        }),
      ]),
    );

    const open = await getWorkbench("all_open", memo);
    expect(open.status).toBe(200);
    expect(open.json.data).toHaveLength(0);
  });

  it("moves an Erica-shaped four-charge Stripe payout to Completed", async () => {
    const memo = `${RUN} erica stripe completion`;
    const depositId = await seedStripeDeposit(memo);

    const completed = await getWorkbench("completed", memo);
    expect(completed.status).toBe(200);
    expect(completed.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anchorId: depositId,
          status: "audit_ready",
          lenses: expect.arrayContaining(["completed"]),
          coverage: expect.objectContaining({ complete: true }),
        }),
      ]),
    );

    const open = await getWorkbench("all_open", memo);
    expect(open.status).toBe(200);
    expect(open.json.data).toHaveLength(0);
  });

  it("keeps a fully linked payment open when accounting evidence is missing", async () => {
    const memo = `${RUN} missing accounting`;
    const depositId = await seedDirectDeposit({ memo, withAccounting: false });

    const open = await getWorkbench("all_open", memo);
    expect(open.status).toBe(200);
    expect(open.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anchorId: depositId,
          status: "accounting_pending",
          coverage: expect.objectContaining({ complete: false }),
        }),
      ]),
    );

    const completed = await getWorkbench("completed", memo);
    expect(completed.status).toBe(200);
    expect(completed.json.data).toHaveLength(0);
  });

  it("keeps a linked gift open when its CRM allocation is incomplete", async () => {
    const memo = `${RUN} incomplete crm`;
    const depositId = await seedDirectDeposit({
      memo,
      withAccounting: true,
      withAllocation: false,
    });

    const open = await getWorkbench("all_open", memo);
    expect(open.status).toBe(200);
    expect(open.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anchorId: depositId,
          status: "incomplete",
          coverage: expect.objectContaining({ complete: false }),
        }),
      ]),
    );

    const completed = await getWorkbench("completed", memo);
    expect(completed.status).toBe(200);
    expect(completed.json.data).toHaveLength(0);
  });
});
