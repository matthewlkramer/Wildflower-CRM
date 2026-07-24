import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `wb_deposits_user_${Date.now()}`,
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

const RUN = `wbdeposit_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ACCOUNT_ID = `${RUN}_acct`;
const depositIds: string[] = [];
const payoutIds: string[] = [];
const unitIds: string[] = [];
const componentIds: string[] = [];
const stagedIds: string[] = [];
const accountingCheckIds: string[] = [];
let db: (typeof import("@workspace/db"))["db"];
let schema: typeof import("@workspace/db");
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";
let seq = 0;
const nextId = (prefix: string) => `${RUN}_${prefix}_${++seq}`;

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: await response.json() };
}

async function seedDeposit(memo: string, amount = "100.00"): Promise<string> {
  const id = nextId("deposit");
  await db.insert(schema.bankDeposits).values({
    id,
    source: "bank_csv_export",
    depositDate: "2099-12-31",
    amount,
    currency: "USD",
    account: ACCOUNT_ID,
    memo,
  });
  depositIds.push(id);
  return id;
}

async function seedUnit(
  depositId: string,
  amount: string,
  withCorrection = false,
): Promise<string> {
  const unitId = nextId("unit");
  const componentId = nextId("component");
  let stagedPaymentId: string | null = null;
  if (withCorrection) {
    stagedPaymentId = nextId("staged");
    await db.insert(schema.stagedPayments).values({
      id: stagedPaymentId,
      realmId: RUN,
      qbEntityType: "deposit",
      qbEntityId: nextId("qb"),
      dateReceived: "2099-12-31",
      amount,
    });
    stagedIds.push(stagedPaymentId);
    const checkId = nextId("qac");
    await db.insert(schema.qboAccountingChecks).values({
      id: checkId,
      stagedPaymentId,
      disposition: "correction_needed",
      expected: { amount },
      actual: { amount: "1.00" },
    });
    accountingCheckIds.push(checkId);
  }
  await db.insert(schema.paymentUnits).values({
    id: unitId,
    kind: "check",
    grossAmount: amount,
    netAmount: amount,
    receivedDate: "2099-12-31",
    sourceStagedPaymentId: stagedPaymentId,
  });
  await db.insert(schema.bankDepositComponents).values({
    id: componentId,
    bankDepositId: depositId,
    paymentUnitId: unitId,
    amount,
    source: "manual",
    sourceStagedPaymentId: stagedPaymentId,
  });
  unitIds.push(unitId);
  componentIds.push(componentId);
  return unitId;
}

async function listDeposits(lens: string, q?: string, limit = "100") {
  const params = new URLSearchParams({ lens, limit });
  if (q) params.set("q", q);
  const result = await getJson(`/api/reconciliation/workbench-deposits?${params}`);
  expect(result.status).toBe(200);
  return result.json;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = schema.db;
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;
  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({ id: ORG_ID, name: ORG_ID });
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (componentIds.length) {
    await db.delete(schema.bankDepositComponents).where(inArrayFn(schema.bankDepositComponents.id, componentIds));
  }
  if (unitIds.length) {
    await db.delete(schema.paymentUnits).where(inArrayFn(schema.paymentUnits.id, unitIds));
  }
  if (accountingCheckIds.length) {
    await db.delete(schema.qboAccountingChecks).where(inArrayFn(schema.qboAccountingChecks.id, accountingCheckIds));
  }
  if (stagedIds.length) {
    await db.delete(schema.stagedPayments).where(inArrayFn(schema.stagedPayments.id, stagedIds));
  }
  if (payoutIds.length) {
    await db.delete(schema.stripePayouts).where(inArrayFn(schema.stripePayouts.id, payoutIds));
  }
  if (depositIds.length) {
    await db.delete(schema.bankDeposits).where(inArrayFn(schema.bankDeposits.id, depositIds));
  }
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) console.warn("[workbench-deposits] skipped: no live DATABASE_URL configured");
});

describe.skipIf(!HAS_DB)("Workbench deposit list (integration)", () => {
  it("anchors rows on deposits and resolves a payout at rung one", async () => {
    const depositId = await seedDeposit("Stripe payout");
    const payoutId = nextId("payout");
    await db.insert(schema.stripePayouts).values({
      id: payoutId,
      stripeAccountId: ACCOUNT_ID,
      amount: "100.00",
      netTotal: "100.00",
      arrivalDate: "2099-12-31",
      bankDepositId: depositId,
    });
    payoutIds.push(payoutId);
    const completed = await listDeposits("completed");
    const row = completed.data.find((item: any) => item.anchorId === depositId);
    expect(row?.composition.kind).toBe("stripe_payout");
    expect(row?.lenses).toContain("completed");
    const open = await listDeposits("all_open");
    expect(open.data.some((item: any) => item.anchorId === depositId)).toBe(false);
  });

  it("supports multi-unit composition, unresolved work, memo search, and full-universe counts", async () => {
    const bundled = await seedDeposit("Bundled donor checks", "100.00");
    await seedUnit(bundled, "60.00");
    await seedUnit(bundled, "40.00");
    const unresolved = await seedDeposit("Unresolved donor deposit", "75.00");
    const result = await listDeposits("all_open", undefined, "1");
    expect(result.pagination.total).toBeGreaterThanOrEqual(2);
    expect(result.lensCounts.unresolved_composition).toBeGreaterThanOrEqual(1);
    expect(result.data).toHaveLength(1);
    const bundledResult = await listDeposits("needs_gift", "Bundled donor");
    const bundledRow = bundledResult.data.find((item: any) => item.anchorId === bundled);
    expect(bundledRow?.composition.kind).toBe("components");
    expect(bundledRow?.composition.units).toHaveLength(2);
    const searchResult = await listDeposits("unresolved_composition", "Unresolved donor");
    expect(searchResult.data.some((item: any) => item.anchorId === unresolved)).toBe(true);
  });

  it("surfaces correction_needed accounting checks for component units", async () => {
    const deposit = await seedDeposit("QBO correction deposit", "50.00");
    await seedUnit(deposit, "50.00", true);
    const result = await listDeposits("accounting_corrections", "QBO correction");
    const row = result.data.find((item: any) => item.anchorId === deposit);
    expect(row?.accountingChecks).toHaveLength(1);
    expect(row.accountingChecks[0].disposition).toBe("correction_needed");
    expect(row.lenses).toContain("accounting_corrections");
  });

  it("derives not_fundraising for loan/interest but keeps brokerage transfers visible", async () => {
    const loan = await seedDeposit("WILDFLOWER LOAN FUND");
    const interest = await seedDeposit("Interest credit");
    const brokerage = await seedDeposit("TRANSFER FROM BRK STOCK DONATION");
    const hidden = await listDeposits("all_open");
    expect(hidden.data.some((item: any) => item.anchorId === loan)).toBe(false);
    expect(hidden.data.some((item: any) => item.anchorId === interest)).toBe(false);
    expect(hidden.data.some((item: any) => item.anchorId === brokerage)).toBe(true);
    const visible = await listDeposits("not_fundraising");
    expect(visible.data.map((item: any) => item.anchorId)).toEqual(
      expect.arrayContaining([loan, interest]),
    );
    expect(visible.data.some((item: any) => item.anchorId === brokerage)).toBe(false);
  });

  it("returns lenses from the same canonical coverage state", async () => {
    const id = await seedDeposit("Parity unresolved");
    const result = await listDeposits("unresolved_composition", "Parity unresolved");
    const row = result.data.find((item: any) => item.anchorId === id);
    expect(row?.lenses).toContain("unresolved_composition");
    expect(row?.coverage.state).toBeTruthy();
    expect(row?.coverage.state.flags).toBeTruthy();
  });
});
