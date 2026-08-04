import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const { TEST_USER_ID, currentRole } = vi.hoisted(() => ({
  TEST_USER_ID: `wb_deposits_user_${Date.now()}`,
  currentRole: { value: "admin" as string },
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: currentRole.value };
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

const RUN = `wbdeposit_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ACCOUNT_ID = `${RUN}_acct`;
const depositIds: string[] = [];
const payoutIds: string[] = [];
const chargeIds: string[] = [];
const unitIds: string[] = [];
const componentIds: string[] = [];
const stagedIds: string[] = [];
const bankTransactionIds: string[] = [];
const depositQboComponentIds: string[] = [];
const accountingCheckIds: string[] = [];
const giftIds: string[] = [];
const oppIds: string[] = [];
const pledgeAllocIds: string[] = [];
let db: (typeof import("@workspace/db"))["db"];
let schema: typeof import("@workspace/db");
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let likeFn: (typeof import("drizzle-orm"))["like"];
let server: Server;
let baseUrl = "";
let seq = 0;
const nextId = (prefix: string) => `${RUN}_${prefix}_${++seq}`;

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: await response.json() };
}

async function seedDeposit(
  memo: string,
  amount = "100.00",
  sourceBankTransactionId: string | null = null,
): Promise<string> {
  const id = nextId("deposit");
  await db.insert(schema.bankDeposits).values({
    id,
    source: "bank_csv_export",
    depositDate: "2099-12-31",
    amount,
    currency: "USD",
    account: ACCOUNT_ID,
    memo,
    sourceBankTransactionId,
  });
  depositIds.push(id);
  return id;
}

async function seedPayout(
  amount = "100.00",
  bankDepositId: string | null = null,
  ambiguousBankMatch = false,
): Promise<string> {
  const id = nextId("payout");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount,
    grossTotal: amount,
    netTotal: amount,
    feeTotal: "0.00",
    refundTotal: "0.00",
    currency: "USD",
    status: "paid",
    arrivalDate: "2099-12-30",
    bankDepositId,
    ambiguousBankMatch,
  });
  payoutIds.push(id);
  return id;
}

async function seedCharge(
  payoutId: string,
  {
    grossAmount,
    refunded = false,
    amountRefunded = "0.00",
  }: { grossAmount: string; refunded?: boolean; amountRefunded?: string },
): Promise<string> {
  const id = nextId("charge");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: payoutId,
    grossAmount,
    feeAmount: "0.00",
    netAmount: grossAmount,
    amountRefunded,
    currency: "USD",
    dateReceived: "2099-12-31",
    refunded,
    rawCharge: { status: "succeeded" },
  });
  chargeIds.push(id);
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

/**
 * Seed an opportunity/pledge (org donor) with ONE pledge-allocation plan line,
 * for the payment-on-pledge mint tests. Defaults to a live written pledge.
 */
async function seedPledge(opts?: {
  writtenPledge?: boolean;
  lossType?: "dormant" | "lost" | null;
  archivedAt?: Date | null;
}): Promise<{ oppId: string; allocationId: string }> {
  const oppId = nextId("opp");
  await db.insert(schema.opportunitiesAndPledges).values({
    id: oppId,
    name: `Pledge ${oppId}`,
    organizationId: ORG_ID,
    stage: "written_commitment",
    awardedAmount: "1000.00",
    writtenPledge: opts?.writtenPledge ?? true,
    lossType: opts?.lossType ?? null,
    archivedAt: opts?.archivedAt ?? null,
  });
  oppIds.push(oppId);
  const allocationId = nextId("palloc");
  await db.insert(schema.pledgeAllocations).values({
    id: allocationId,
    pledgeOrOpportunityId: oppId,
    subAmount: "1000.00",
  });
  pledgeAllocIds.push(allocationId);
  return { oppId, allocationId };
}

async function seedDepositQboComponent(
  depositId: string,
  amount: string,
  {
    fundingSource,
    exclusionReason,
  }: {
    fundingSource?: "stripe";
    exclusionReason?: "earned_income" | "membership";
  } = {},
): Promise<void> {
  const stagedPaymentId = nextId("qbo_staged");
  const qbDepositId = nextId("qbo_deposit");
  const componentId = nextId("qbo_component");
  await db.insert(schema.stagedPayments).values({
    id: stagedPaymentId,
    realmId: RUN,
    qbEntityType: "deposit",
    qbEntityId: qbDepositId,
    qbDepositId,
    dateReceived: "2099-12-31",
    amount,
    fundingSource,
    exclusionReason,
  });
  stagedIds.push(stagedPaymentId);
  await db.insert(schema.sourceLinks).values({
    id: componentId,
    linkType: "qbo_line_deposit",
    bankDepositId: depositId,
    qbStagedPaymentId: stagedPaymentId,
    lifecycle: "confirmed",
    provenance: "system",
    matchBasis: "deposit_header_exact",
  });
  depositQboComponentIds.push(componentId);
}

async function listDeposits(lens: string, q?: string, limit = "100") {
  const params = new URLSearchParams({ lens, limit });
  if (q) params.set("q", q);
  const result = await getJson(
    `/api/reconciliation/workbench-deposits?${params}`,
  );
  expect(result.status).toBe(200);
  return result.json;
}

async function requestJson(method: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, { method });
  return {
    status: response.status,
    json: response.status === 204 ? null : await response.json(),
  };
}

async function postJson(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = schema.db;
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;
  likeFn = drizzle.like;
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
    await db
      .delete(schema.bankDepositComponents)
      .where(inArrayFn(schema.bankDepositComponents.id, componentIds));
  }
  if (unitIds.length) {
    await db
      .delete(schema.paymentUnits)
      .where(inArrayFn(schema.paymentUnits.id, unitIds));
  }
  if (giftIds.length) {
    // Minted gifts carry a seeded starter allocation (gift_id is
    // onDelete: restrict) — clear allocations before the gift headers.
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  // Pledge fixtures: allocations before their opps (RESTRICT), opps after the
  // gifts that reference them (gift.opportunityId).
  if (pledgeAllocIds.length) {
    await db
      .delete(schema.pledgeAllocations)
      .where(inArrayFn(schema.pledgeAllocations.id, pledgeAllocIds));
  }
  if (oppIds.length) {
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, oppIds));
  }
  if (accountingCheckIds.length) {
    await db
      .delete(schema.qboAccountingChecks)
      .where(inArrayFn(schema.qboAccountingChecks.id, accountingCheckIds));
  }
  if (depositQboComponentIds.length) {
    await db
      .delete(schema.sourceLinks)
      .where(inArrayFn(schema.sourceLinks.id, depositQboComponentIds));
  }
  if (stagedIds.length) {
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  }
  if (payoutIds.length) {
    if (chargeIds.length) {
      await db
        .delete(schema.stripeStagedCharges)
        .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
    }
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  }
  if (depositIds.length) {
    await db
      .delete(schema.bankDeposits)
      .where(inArrayFn(schema.bankDeposits.id, depositIds));
  }
  if (bankTransactionIds.length) {
    await db
      .delete(schema.bankTransactions)
      .where(inArrayFn(schema.bankTransactions.id, bankTransactionIds));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB)
    console.warn(
      "[workbench-deposits] skipped: no live DATABASE_URL configured",
    );
});

describe.skipIf(!HAS_DB)("Workbench deposit list (integration)", () => {
  it("writes only the bank-deposit exclusion row and supports update, validation, auth, and removal", async () => {
    const deposit = await seedDeposit("Deposit exclusion API test", "321.00");
    // Scope the no-mint snapshot to rows derived from THIS suite's anchors
    // (unit ids embed the anchor id, which embeds RUN). Parallel vitest
    // workers legitimately mint units for their own suites mid-test, so a
    // whole-table snapshot is inherently racy.
    const beforeUnits = await db
      .select({ id: schema.paymentUnits.id })
      .from(schema.paymentUnits)
      .where(likeFn(schema.paymentUnits.id, `%${RUN}%`));
    const beforeApplications = await db
      .select({ id: schema.paymentApplications.id })
      .from(schema.paymentApplications)
      .where(likeFn(schema.paymentApplications.id, `%${RUN}%`));

    const first = await fetch(
      `${baseUrl}/api/reconciliation/deposits/${deposit}/exclusion`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "membership", note: "initial review" }),
      },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      reason: "membership",
      note: "initial review",
    });

    const second = await fetch(
      `${baseUrl}/api/reconciliation/deposits/${deposit}/exclusion`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "intercompany_transfer",
          note: "updated review",
        }),
      },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      reason: "intercompany_transfer",
      note: "updated review",
    });
    const exclusions = await db
      .select({
        reason: schema.bankDepositExclusions.reason,
        note: schema.bankDepositExclusions.note,
      })
      .from(schema.bankDepositExclusions)
      .where(eqFn(schema.bankDepositExclusions.bankDepositId, deposit));
    expect(exclusions).toEqual([
      { reason: "intercompany_transfer", note: "updated review" },
    ]);
    const listed = await getJson(
      `/api/reconciliation/workbench-deposits?lens=not_fundraising&q=Deposit%20exclusion%20API%20test`,
    );
    expect(listed.status).toBe(200);
    expect(
      listed.json.data.find((item: any) => item.anchorId === deposit)
        ?.bankExclusion,
    ).toEqual({
      reason: "intercompany_transfer",
      note: "updated review",
    });

    const invalid = await fetch(
      `${baseUrl}/api/reconciliation/deposits/${deposit}/exclusion`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "failed_charge" }),
      },
    );
    expect(invalid.status).toBe(400);

    currentRole.value = "team_member";
    const forbidden = await fetch(
      `${baseUrl}/api/reconciliation/deposits/${deposit}/exclusion`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "other" }),
      },
    );
    expect(forbidden.status).toBe(403);
    currentRole.value = "admin";

    const removed = await fetch(
      `${baseUrl}/api/reconciliation/deposits/${deposit}/exclusion`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(204);
    const remaining = await db
      .select({ id: schema.bankDepositExclusions.id })
      .from(schema.bankDepositExclusions)
      .where(eqFn(schema.bankDepositExclusions.bankDepositId, deposit));
    expect(remaining).toHaveLength(0);

    const afterUnits = await db
      .select({ id: schema.paymentUnits.id })
      .from(schema.paymentUnits)
      .where(likeFn(schema.paymentUnits.id, `%${RUN}%`));
    const afterApplications = await db
      .select({ id: schema.paymentApplications.id })
      .from(schema.paymentApplications)
      .where(likeFn(schema.paymentApplications.id, `%${RUN}%`));
    expect(afterUnits).toEqual(beforeUnits);
    expect(afterApplications).toEqual(beforeApplications);
  });

  it("keeps a paired payout open when a live charge still needs a gift", async () => {
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
    await seedCharge(payoutId, { grossAmount: "100.00" });

    const completed = await listDeposits("completed", "Stripe payout");
    expect(
      completed.data.some((item: any) => item.anchorId === depositId),
    ).toBe(false);
    const open = await listDeposits("all_open", "Stripe payout");
    const row = open.data.find((item: any) => item.anchorId === depositId);
    expect(row?.composition.kind).toBe("stripe_payout");
    expect(row?.lenses).toContain("all_open");
    expect(row?.lenses).toContain("needs_gift");
    expect(row?.coverage.state.linkage.state).toBe("partial");
    expect(row?.coverage.complete).toBe(false);
  });

  it("returns source bank transaction classification fields", async () => {
    const bankTransactionId = nextId("bank_transaction");
    await db.insert(schema.bankTransactions).values({
      id: bankTransactionId,
      source: "bank_csv_export",
      sourceFile: "workbench-test.csv",
      txnDate: "2099-12-31",
      txnType: "Deposit",
      refNo: "REF-123",
      payee: "Example Payee",
      memo: "Source bank memo",
      account: ACCOUNT_ID,
      deposit: "100.00",
      dedupKey: nextId("dedup"),
      occurrence: 0,
    });
    bankTransactionIds.push(bankTransactionId);
    const deposit = await seedDeposit(
      "Source bank memo",
      "100.00",
      bankTransactionId,
    );

    const result = await listDeposits("all_open", "Source bank memo");
    const row = result.data.find((item: any) => item.anchorId === deposit);
    expect(row?.bank).toMatchObject({
      payee: "Example Payee",
      refNo: "REF-123",
      txnType: "Deposit",
    });
    expect(row?.bank).not.toHaveProperty("qbPosting");
    expect(row?.bank).not.toHaveProperty("donor");
    expect(row?.bank).not.toHaveProperty("qbClass");
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
    const bundledRow = bundledResult.data.find(
      (item: any) => item.anchorId === bundled,
    );
    expect(bundledRow?.composition.kind).toBe("components");
    expect(bundledRow?.composition.units).toHaveLength(2);
    const searchResult = await listDeposits(
      "unresolved_composition",
      "Unresolved donor",
    );
    expect(
      searchResult.data.some((item: any) => item.anchorId === unresolved),
    ).toBe(true);
  });

  it("does not demand a gift for a fully refunded later charge", async () => {
    const deposit = await seedDeposit("Later refunded Stripe charge", "100.00");
    const payout = await seedPayout("100.00", deposit);
    await seedCharge(payout, {
      grossAmount: "100.00",
      refunded: true,
      amountRefunded: "100.00",
    });

    const needsGift = await listDeposits(
      "needs_gift",
      "Later refunded Stripe charge",
    );
    expect(needsGift.data.some((item: any) => item.anchorId === deposit)).toBe(
      false,
    );

    const completed = await listDeposits(
      "completed",
      "Later refunded Stripe charge",
    );
    const row = completed.data.find((item: any) => item.anchorId === deposit);
    expect(row?.lenses).toContain("completed");

    const open = await listDeposits("all_open", "Later refunded Stripe charge");
    expect(open.data.some((item: any) => item.anchorId === deposit)).toBe(
      false,
    );
    expect(row?.charges[0]).toMatchObject({
      refunded: true,
      amountRefunded: "100.00",
      amount: "100.00",
    });
    expect(row?.coverage.state.transactions[0]).toMatchObject({
      state: "refunded",
      livePayment: false,
    });
    expect(row?.coverage.state.linkage.state).toBe("partial");
  });

  it("still demands gifts for active gross charges in a bundled payout", async () => {
    const deposit = await seedDeposit(
      "Bundled later refund and active charge",
      "200.00",
    );
    const payout = await seedPayout("200.00", deposit);
    await seedCharge(payout, {
      grossAmount: "100.00",
      refunded: true,
      amountRefunded: "100.00",
    });
    await seedCharge(payout, { grossAmount: "100.00" });

    const needsGift = await listDeposits(
      "needs_gift",
      "Bundled later refund and active charge",
    );
    expect(needsGift.data.some((item: any) => item.anchorId === deposit)).toBe(
      true,
    );
    const completed = await listDeposits(
      "completed",
      "Bundled later refund and active charge",
    );
    expect(completed.data.some((item: any) => item.anchorId === deposit)).toBe(
      false,
    );
    const open = await listDeposits(
      "all_open",
      "Bundled later refund and active charge",
    );
    const row = open.data.find((item: any) => item.anchorId === deposit);
    expect(row?.coverage.state.linkage.state).toBe("partial");
    expect(row?.coverage.state.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "refunded", livePayment: false }),
        expect.objectContaining({ state: "unmatched", livePayment: true }),
      ]),
    );
  });

  it("reports a fully gift-linked payout as link-complete but not audit-ready", async () => {
    const deposit = await seedDeposit(
      "Fully gift-linked Stripe payout",
      "100.00",
    );
    const payout = await seedPayout("100.00", deposit);
    const charge = await seedCharge(payout, { grossAmount: "100.00" });
    const giftId = nextId("linked_gift");
    const unitId = nextId("linked_charge_unit");
    await db.insert(schema.giftsAndPayments).values({
      id: giftId,
      name: "Fully linked test gift",
      amount: "100.00",
      dateReceived: "2099-12-31",
      organizationId: ORG_ID,
    });
    giftIds.push(giftId);
    await db.insert(schema.paymentUnits).values({
      id: unitId,
      kind: "stripe_charge",
      stripeChargeId: charge,
      grossAmount: "100.00",
      feeAmount: "0.00",
      netAmount: "100.00",
      receivedDate: "2099-12-31",
      giftId,
      giftMatchMethod: "human",
    });
    unitIds.push(unitId);

    const completed = await listDeposits(
      "completed",
      "Fully gift-linked Stripe payout",
    );
    const row = completed.data.find((item: any) => item.anchorId === deposit);
    expect(row?.lenses).toContain("completed");
    expect(row?.coverage.state.linkage.state).toBe("complete");
    expect(row?.coverage.state.information.qbComplete).toBe(false);
    expect(row?.coverage.complete).toBe(false);

    const open = await listDeposits(
      "all_open",
      "Fully gift-linked Stripe payout",
    );
    expect(open.data.some((item: any) => item.anchorId === deposit)).toBe(
      false,
    );
  });

  it("does not keep a fully linked Stripe payout open because of a gift-less accounting component", async () => {
    const deposit = await seedDeposit(
      "Stripe fee-net payout with QBO evidence",
      "142.00",
    );
    const payout = await seedPayout("142.00", deposit);
    await db
      .update(schema.stripePayouts)
      .set({ grossTotal: "150.00", feeTotal: "8.00", netTotal: "142.00" })
      .where(eqFn(schema.stripePayouts.id, payout));
    const charge = await seedCharge(payout, { grossAmount: "150.00" });
    const giftId = nextId("fee_net_gift");
    const chargeUnitId = nextId("fee_net_charge_unit");
    await db.insert(schema.giftsAndPayments).values({
      id: giftId,
      name: "Fee-net Stripe gift",
      amount: "150.00",
      dateReceived: "2099-12-31",
      organizationId: ORG_ID,
    });
    giftIds.push(giftId);
    await db.insert(schema.paymentUnits).values({
      id: chargeUnitId,
      kind: "stripe_charge",
      stripeChargeId: charge,
      grossAmount: "150.00",
      feeAmount: "8.00",
      netAmount: "142.00",
      receivedDate: "2099-12-31",
      giftId,
      giftMatchMethod: "human",
    });
    unitIds.push(chargeUnitId);

    // This is downstream accounting evidence, not a second donor payment.
    await seedUnit(deposit, "142.00");

    const completed = await listDeposits(
      "completed",
      "Stripe fee-net payout with QBO evidence",
    );
    const row = completed.data.find((item: any) => item.anchorId === deposit);
    expect(row?.lenses).toContain("completed");
    expect(row?.lenses).not.toContain("needs_gift");
    expect(row?.charges).toHaveLength(1);
    expect(row?.gifts.map((item: any) => item.giftId)).toEqual([giftId]);

    const open = await listDeposits(
      "all_open",
      "Stripe fee-net payout with QBO evidence",
    );
    expect(open.data.some((item: any) => item.anchorId === deposit)).toBe(
      false,
    );
  });

  it("prefers charge-grain gifts when a Stripe payout also carries a legacy component gift", async () => {
    const deposit = await seedDeposit("Stripe charge gift authority", "20.00");
    const payout = await seedPayout("20.00", deposit);
    const chargeGiftIds: string[] = [];

    for (let index = 0; index < 4; index += 1) {
      const charge = await seedCharge(payout, { grossAmount: "5.00" });
      const giftId = nextId(`charge_gift_${index}`);
      const unitId = nextId(`charge_unit_${index}`);
      await db.insert(schema.giftsAndPayments).values({
        id: giftId,
        name: `Charge gift ${index + 1}`,
        amount: "5.00",
        dateReceived: "2099-12-31",
        organizationId: ORG_ID,
      });
      giftIds.push(giftId);
      chargeGiftIds.push(giftId);
      await db.insert(schema.paymentUnits).values({
        id: unitId,
        kind: "stripe_charge",
        stripeChargeId: charge,
        grossAmount: "5.00",
        feeAmount: "0.00",
        netAmount: "5.00",
        receivedDate: "2099-12-31",
        giftId,
        giftMatchMethod: "human",
      });
      unitIds.push(unitId);
    }

    const legacyGiftId = nextId("legacy_component_gift");
    const legacyUnitId = nextId("legacy_component_unit");
    const legacyComponentId = nextId("legacy_component");
    await db.insert(schema.giftsAndPayments).values({
      id: legacyGiftId,
      name: "Legacy payout-level gift",
      amount: "20.00",
      dateReceived: "2099-12-31",
      organizationId: ORG_ID,
    });
    giftIds.push(legacyGiftId);
    await db.insert(schema.paymentUnits).values({
      id: legacyUnitId,
      kind: "other",
      grossAmount: "20.00",
      netAmount: "20.00",
      receivedDate: "2099-12-31",
      giftId: legacyGiftId,
      giftMatchMethod: "human",
    });
    unitIds.push(legacyUnitId);
    await db.insert(schema.bankDepositComponents).values({
      id: legacyComponentId,
      bankDepositId: deposit,
      paymentUnitId: legacyUnitId,
      amount: "20.00",
      source: "manual",
    });
    componentIds.push(legacyComponentId);

    const result = await listDeposits(
      "completed",
      "Stripe charge gift authority",
    );
    const row = result.data.find((item: any) => item.anchorId === deposit);
    expect(row?.charges).toHaveLength(4);
    expect(row?.gifts.map((item: any) => item.giftId).sort()).toEqual(
      [...chargeGiftIds].sort(),
    );
    expect(row?.gifts.some((item: any) => item.giftId === legacyGiftId)).toBe(
      false,
    );
  });

  it("surfaces correction_needed accounting checks for component units", async () => {
    const deposit = await seedDeposit("QBO correction deposit", "50.00");
    await seedUnit(deposit, "50.00", true);
    const result = await listDeposits(
      "accounting_corrections",
      "QBO correction",
    );
    const row = result.data.find((item: any) => item.anchorId === deposit);
    expect(row?.accountingChecks).toHaveLength(1);
    expect(row.accountingChecks[0].disposition).toBe("correction_needed");
    expect(row.lenses).toContain("accounting_corrections");
  });


  it("completes a deposit when its matched gift plus an excluded payment explain the full amount", async () => {
    const deposit = await seedDeposit(
      "Matched gift plus excluded payment",
      "100.00",
    );
    const includedUnit = await seedUnit(deposit, "60.00");
    const giftId = nextId("included_gift");
    await db.insert(schema.giftsAndPayments).values({
      id: giftId,
      name: "Included gift",
      amount: "60.00",
      dateReceived: "2099-12-31",
      organizationId: ORG_ID,
    });
    giftIds.push(giftId);
    await db.insert(schema.giftAllocations).values({
      id: nextId("included_gift_allocation"),
      giftId,
      subAmount: "60.00",
    });
    await db
      .update(schema.paymentUnits)
      .set({ giftId, giftMatchMethod: "human" })
      .where(eqFn(schema.paymentUnits.id, includedUnit));

    const excludedUnit = await seedUnit(deposit, "40.00", true);
    const excludedComponent = await db
      .select({ id: schema.bankDepositComponents.id })
      .from(schema.bankDepositComponents)
      .where(
        eqFn(schema.bankDepositComponents.paymentUnitId, excludedUnit),
      )
      .then((rows) => rows[0]);
    await db
      .update(schema.bankDepositComponents)
      .set({
        exclusionReason: "membership",
        needsReview: true,
        ambiguousDepositMatch: true,
      })
      .where(eqFn(schema.bankDepositComponents.id, excludedComponent!.id));

    const completed = await listDeposits(
      "completed",
      "Matched gift plus excluded payment",
    );
    const row = completed.data.find((item: any) => item.anchorId === deposit);
    expect(row?.lenses).toContain("completed");
    expect(row?.lenses).not.toContain("ambiguous_pairing");
    expect(row?.lenses).not.toContain("accounting_corrections");
    expect(row?.coverage.state.flags.attentionRequired).toBe(false);
    expect(row?.coverage.state.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "matched", livePayment: true }),
        expect.objectContaining({ state: "excluded", livePayment: false }),
      ]),
    );

    const open = await listDeposits(
      "all_open",
      "Matched gift plus excluded payment",
    );
    expect(open.data.some((item: any) => item.anchorId === deposit)).toBe(false);
  });

  it("counts confirmed QBO lines toward composition but still requires a gift for live money", async () => {
    const deposit = await seedDeposit(
      "Confirmed QBO composition with excluded line",
      "100.00",
    );
    await seedDepositQboComponent(deposit, "60.00");
    await seedDepositQboComponent(deposit, "40.00", {
      exclusionReason: "membership",
    });

    const unresolved = await listDeposits(
      "unresolved_composition",
      "Confirmed QBO composition with excluded line",
    );
    expect(
      unresolved.data.some((item: any) => item.anchorId === deposit),
    ).toBe(false);

    const needsGift = await listDeposits(
      "needs_gift",
      "Confirmed QBO composition with excluded line",
    );
    const row = needsGift.data.find((item: any) => item.anchorId === deposit);
    expect(row?.composition.kind).toBe("qbo_provisional");
    expect(Number(row?.composition.unexplainedAmount ?? 0)).toBeCloseTo(0);
    expect(row?.lenses).toContain("needs_gift");
  });

  it("derives not_fundraising for loan/interest but keeps brokerage transfers visible", async () => {
    const loan = await seedDeposit("WILDFLOWER LOAN FUND");
    const interest = await seedDeposit("Interest credit");
    const brokerage = await seedDeposit("TRANSFER FROM BRK STOCK DONATION");
    const hidden = await listDeposits("all_open");
    expect(hidden.data.some((item: any) => item.anchorId === loan)).toBe(false);
    expect(hidden.data.some((item: any) => item.anchorId === interest)).toBe(
      false,
    );
    expect(hidden.data.some((item: any) => item.anchorId === brokerage)).toBe(
      true,
    );
    const visible = await listDeposits("not_fundraising");
    expect(visible.data.map((item: any) => item.anchorId)).toEqual(
      expect.arrayContaining([loan, interest]),
    );
    expect(visible.data.some((item: any) => item.anchorId === brokerage)).toBe(
      false,
    );
  });

  it("treats a bank-deposit-level exclusion as not_fundraising", async () => {
    const excluded = await seedDeposit(
      "ONLINE TRANSFER CSP MAY NONPAYROLL",
      "4321.00",
    );
    await db.insert(schema.bankDepositExclusions).values({
      id: `bdex_${excluded}`,
      bankDepositId: excluded,
      reason: "intercompany_transfer",
      note: "reviewed internal transfer",
    });

    const open = await listDeposits("all_open");
    expect(open.data.some((item: any) => item.anchorId === excluded)).toBe(
      false,
    );

    const result = await listDeposits("not_fundraising", "ONLINE TRANSFER CSP");
    const row = result.data.find((item: any) => item.anchorId === excluded);
    expect(row).toBeTruthy();
    expect(row?.lenses).toContain("not_fundraising");
    expect(row?.notFundraisingReason).toBe("intercompany_transfer");
  });

  it("returns lenses from the same canonical coverage state", async () => {
    const id = await seedDeposit("Parity unresolved");
    const result = await listDeposits(
      "unresolved_composition",
      "Parity unresolved",
    );
    const row = result.data.find((item: any) => item.anchorId === id);
    expect(row?.lenses).toContain("unresolved_composition");
    expect(row?.coverage.state).toBeTruthy();
    expect(row?.coverage.state.flags).toBeTruthy();
  });

  it("surfaces provisional QBO composition and exclusion-driven classification", async () => {
    const deposit = await seedDeposit("Membership deposit", "125.00");
    const stagedPaymentId = nextId("provisional_staged");
    const componentId = nextId("provisional_component");
    await db.insert(schema.stagedPayments).values({
      id: stagedPaymentId,
      realmId: RUN,
      qbEntityType: "deposit",
      qbEntityId: nextId("provisional_qb"),
      qbDepositId: nextId("provisional_deposit"),
      dateReceived: "2099-12-31",
      amount: "125.00",
      payerName: "Example Membership",
      exclusionReason: "membership",
    });
    stagedIds.push(stagedPaymentId);
    await db.insert(schema.sourceLinks).values({
      id: componentId,
      linkType: "qbo_line_deposit",
      bankDepositId: deposit,
      qbStagedPaymentId: stagedPaymentId,
      lifecycle: "confirmed",
      provenance: "system",
      matchBasis: "deposit_header_exact",
    });
    depositQboComponentIds.push(componentId);

    const result = await listDeposits("not_fundraising", "Membership deposit");
    const row = result.data.find((item: any) => item.anchorId === deposit);
    expect(row?.notFundraisingReason).toBe("membership");
    expect(row?.composition.kind).toBe("qbo_provisional");
    expect(row?.composition.components[0]).toMatchObject({
      unconfirmed: true,
      source: "qbo_provisional",
      exclusionReason: "membership",
      amount: "125.00",
    });
  });

  it("suppresses the provisional QBO card when a component already composes the same staged payment", async () => {
    const deposit = await seedDeposit(
      "Redundant provisional deposit",
      "1000.00",
    );
    const stagedPaymentId = nextId("redundant_staged");
    const unitId = nextId("redundant_unit");
    const componentId = nextId("redundant_component");
    const linkId = nextId("redundant_link");
    await db.insert(schema.stagedPayments).values({
      id: stagedPaymentId,
      realmId: RUN,
      qbEntityType: "deposit",
      qbEntityId: nextId("redundant_qb"),
      qbDepositId: nextId("redundant_deposit"),
      dateReceived: "2099-12-31",
      amount: "1000.00",
      payerName: "Redundant Payer",
    });
    stagedIds.push(stagedPaymentId);
    await db.insert(schema.paymentUnits).values({
      id: unitId,
      kind: "other",
      grossAmount: "1000.00",
      netAmount: "1000.00",
      receivedDate: "2099-12-31",
      sourceStagedPaymentId: stagedPaymentId,
    });
    unitIds.push(unitId);
    await db.insert(schema.bankDepositComponents).values({
      id: componentId,
      bankDepositId: deposit,
      paymentUnitId: unitId,
      amount: "1000.00",
      source: "manual",
    });
    componentIds.push(componentId);
    await db.insert(schema.sourceLinks).values({
      id: linkId,
      linkType: "qbo_line_deposit",
      bankDepositId: deposit,
      qbStagedPaymentId: stagedPaymentId,
      lifecycle: "confirmed",
      provenance: "system",
      matchBasis: "deposit_header_exact",
    });
    depositQboComponentIds.push(linkId);

    const result = await listDeposits("all_open", "Redundant provisional");
    const row = result.data.find((item: any) => item.anchorId === deposit);
    expect(row?.composition.kind).toBe("components");
    expect(row?.composition.components).toHaveLength(1);
    expect(row?.composition.components[0]).toMatchObject({
      source: "bank_spine",
      stagedPaymentId,
      amount: "1000.00",
    });
    expect(row?.composition.unexplainedAmount).toBe("0.00");
    const qbForStaged = row?.qbRecords.filter(
      (r: any) => r.stagedPaymentId === stagedPaymentId,
    );
    expect(qbForStaged).toHaveLength(1);
  });

  it("carries excluded Stripe transfer deposits into not fundraising without open-work lenses", async () => {
    const deposit = await seedDeposit(
      "STRIPE   TRANSFER earned income",
      "125.00",
    );
    await seedDepositQboComponent(deposit, "125.00", {
      fundingSource: "stripe",
      exclusionReason: "earned_income",
    });

    const notFundraising = await listDeposits(
      "not_fundraising",
      "STRIPE   TRANSFER earned",
    );
    expect(
      notFundraising.data.some((item: any) => item.anchorId === deposit),
    ).toBe(true);

    const ambiguous = await listDeposits(
      "ambiguous_pairing",
      "STRIPE   TRANSFER earned",
    );
    expect(ambiguous.data.some((item: any) => item.anchorId === deposit)).toBe(
      false,
    );

    const allOpen = await listDeposits("all_open", "STRIPE   TRANSFER earned");
    expect(allOpen.data.some((item: any) => item.anchorId === deposit)).toBe(
      false,
    );
  });

  it("keeps non-excluded payout-less Stripe transfers unresolved, not ambiguous", async () => {
    const deposit = await seedDeposit(
      "STRIPE   TRANSFER unresolved income",
      "126.00",
    );
    await seedDepositQboComponent(deposit, "126.00", {
      fundingSource: "stripe",
    });

    const unresolved = await listDeposits(
      "unresolved_composition",
      "STRIPE   TRANSFER unresolved",
    );
    expect(unresolved.data.some((item: any) => item.anchorId === deposit)).toBe(
      true,
    );

    const ambiguous = await listDeposits(
      "ambiguous_pairing",
      "STRIPE   TRANSFER unresolved",
    );
    expect(ambiguous.data.some((item: any) => item.anchorId === deposit)).toBe(
      false,
    );
  });

  it("retains ambiguity for a genuinely ambiguous payout match", async () => {
    const deposit = await seedDeposit("Genuine payout tie");
    await seedPayout("100.00", deposit, true);

    const ambiguous = await listDeposits(
      "ambiguous_pairing",
      "Genuine payout tie",
    );
    expect(ambiguous.data.some((item: any) => item.anchorId === deposit)).toBe(
      true,
    );
  });

  it("keeps regular unresolved deposits in all open", async () => {
    const deposit = await seedDeposit("Regular unresolved deposit", "127.00");

    const allOpen = await listDeposits("all_open", "Regular unresolved");
    expect(allOpen.data.some((item: any) => item.anchorId === deposit)).toBe(
      true,
    );
  });

  it("confirms and dismisses provisional QBO components", async () => {
    const deposit = await seedDeposit("Provisional action deposit", "80.00");
    const stagedPaymentId = nextId("action_staged");
    const componentId = nextId("action_component");
    await db.insert(schema.stagedPayments).values({
      id: stagedPaymentId,
      realmId: RUN,
      qbEntityType: "deposit",
      qbEntityId: nextId("action_qb"),
      qbDepositId: nextId("action_deposit"),
      dateReceived: "2099-12-31",
      amount: "80.00",
    });
    stagedIds.push(stagedPaymentId);
    await db.insert(schema.sourceLinks).values({
      id: componentId,
      linkType: "qbo_line_deposit",
      bankDepositId: deposit,
      qbStagedPaymentId: stagedPaymentId,
      lifecycle: "confirmed",
      provenance: "system",
      matchBasis: "deposit_header_ambiguous",
    });
    depositQboComponentIds.push(componentId);

    const confirmed = await requestJson(
      "POST",
      `/api/reconciliation/deposit-qbo-components/${componentId}/confirm`,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.json).toMatchObject({ id: componentId, confirmed: true });
    const dismissed = await requestJson(
      "DELETE",
      `/api/reconciliation/deposit-qbo-components/${componentId}`,
    );
    expect(dismissed.status).toBe(204);
  });

  it("links a gift to the existing gift-less single-payment unit instead of adding a second component", async () => {
    const deposit = await seedDeposit(
      "Gift-less single payment deposit",
      "75000.00",
    );

    // Step 1: "Record without a gift" — whole-amount unit + component.
    const created = await postJson(
      `/api/reconciliation/deposits/${deposit}/components`,
      {
        mode: "create",
        kind: "other",
        amount: "75000.00",
      },
    );
    expect(created.status).toBe(201);
    componentIds.push(created.json.id);
    unitIds.push(created.json.paymentUnitId);

    // Step 2: link a CRM gift — must adopt the existing unit, not fail on the
    // zero remainder or compose a second component.
    const giftId = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: giftId,
      amount: "75000.00",
      organizationId: ORG_ID,
      details: "Gift-less single payment link test.",
    });
    giftIds.push(giftId);

    const linked = await postJson(
      `/api/reconciliation/deposits/${deposit}/components`,
      {
        mode: "gift",
        giftId,
      },
    );
    expect(linked.status).toBe(201);
    expect(linked.json.id).toBe(created.json.id);
    expect(linked.json.paymentUnitId).toBe(created.json.paymentUnitId);
    expect(linked.json.amount).toBe("75000.00");

    const unit = await db
      .select({
        giftId: schema.paymentUnits.giftId,
        method: schema.paymentUnits.giftMatchMethod,
      })
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, created.json.paymentUnitId))
      .then((r) => r[0]);
    expect(unit).toMatchObject({ giftId, method: "human" });

    const components = await db
      .select({ id: schema.bankDepositComponents.id })
      .from(schema.bankDepositComponents)
      .where(eqFn(schema.bankDepositComponents.bankDepositId, deposit));
    expect(components).toHaveLength(1);
  });

  it("mints a gift from a composed direct payment unit and books the tie in one transaction", async () => {
    const deposit = await seedDeposit("Unit mint deposit", "150.00");
    const unitId = await seedUnit(deposit, "150.00");

    const minted = await postJson(
      `/api/reconciliation/payment-units/${unitId}/create-gift`,
      { organizationId: ORG_ID },
    );
    expect(minted.status).toBe(201);
    expect(minted.json.paymentUnitId).toBe(unitId);
    const giftId = minted.json.gift.id as string;
    giftIds.push(giftId);
    // No staged source label → the kind fallback names the gift.
    expect(minted.json.gift.name).toBe("Check payment");

    const unit = await db
      .select({
        giftId: schema.paymentUnits.giftId,
        method: schema.paymentUnits.giftMatchMethod,
        createdTheGift: schema.paymentUnits.createdTheGift,
      })
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, unitId))
      .then((r) => r[0]);
    expect(unit).toMatchObject({
      giftId,
      method: "human",
      createdTheGift: true,
    });

    const allocations = await db
      .select({
        subAmount: schema.giftAllocations.subAmount,
        countsTowardGoal: schema.giftAllocations.countsTowardGoal,
      })
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, giftId));
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      subAmount: "150.00",
      countsTowardGoal: true,
    });

    // A second mint on the same unit must refuse — the unit already pays.
    const again = await postJson(
      `/api/reconciliation/payment-units/${unitId}/create-gift`,
      { organizationId: ORG_ID },
    );
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("unit_already_paying");
  });

  it("honors mint overrides for name, date, and goal counting", async () => {
    const deposit = await seedDeposit("Unit mint override deposit", "80.00");
    const unitId = await seedUnit(deposit, "80.00");

    const minted = await postJson(
      `/api/reconciliation/payment-units/${unitId}/create-gift`,
      {
        organizationId: ORG_ID,
        name: "Custom mint name",
        dateReceived: "2099-01-15",
        countsTowardGoal: false,
      },
    );
    expect(minted.status).toBe(201);
    giftIds.push(minted.json.gift.id);
    expect(minted.json.gift.name).toBe("Custom mint name");
    expect(minted.json.gift.dateReceived).toBe("2099-01-15");

    const allocations = await db
      .select({ countsTowardGoal: schema.giftAllocations.countsTowardGoal })
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, minted.json.gift.id));
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.countsTowardGoal).toBe(false);
  });

  it("refuses unit mints for uncomposed units, bad donors, and unknown units", async () => {
    // A unit not composed on any bank deposit has no money spine to book on.
    const looseUnitId = nextId("unit");
    await db.insert(schema.paymentUnits).values({
      id: looseUnitId,
      kind: "check",
      grossAmount: "10.00",
      netAmount: "10.00",
      receivedDate: "2099-12-31",
    });
    unitIds.push(looseUnitId);
    const uncomposed = await postJson(
      `/api/reconciliation/payment-units/${looseUnitId}/create-gift`,
      { organizationId: ORG_ID },
    );
    expect(uncomposed.status).toBe(409);
    expect(uncomposed.json.error).toBe("unit_not_composed");

    // Donor XOR: zero donors and two donors both fail validation.
    const deposit = await seedDeposit("Unit mint donor XOR deposit", "20.00");
    const unitId = await seedUnit(deposit, "20.00");
    const noDonor = await postJson(
      `/api/reconciliation/payment-units/${unitId}/create-gift`,
      {},
    );
    expect(noDonor.status).toBe(400);
    const twoDonors = await postJson(
      `/api/reconciliation/payment-units/${unitId}/create-gift`,
      { organizationId: ORG_ID, householdId: "some_household" },
    );
    expect(twoDonors.status).toBe(400);

    const missing = await postJson(
      `/api/reconciliation/payment-units/${nextId("missing_unit")}/create-gift`,
      { organizationId: ORG_ID },
    );
    expect(missing.status).toBe(404);
  });

  it("refuses unit mints for Stripe-backed and excluded units", async () => {
    // Stripe money mints through the charge flow, never the unit route.
    const stripeDeposit = await seedDeposit("Unit mint stripe deposit", "30.00");
    const payoutId = await seedPayout("30.00", stripeDeposit);
    const chargeId = await seedCharge(payoutId, { grossAmount: "30.00" });
    const stripeUnitId = nextId("unit");
    await db.insert(schema.paymentUnits).values({
      id: stripeUnitId,
      kind: "stripe_charge",
      stripeChargeId: chargeId,
      grossAmount: "30.00",
      netAmount: "28.50",
      receivedDate: "2099-12-31",
    });
    unitIds.push(stripeUnitId);
    const stripeMint = await postJson(
      `/api/reconciliation/payment-units/${stripeUnitId}/create-gift`,
      { organizationId: ORG_ID },
    );
    expect(stripeMint.status).toBe(409);
    expect(stripeMint.json.error).toBe("unit_not_direct");

    // Excluded money never books a counted gift.
    const deposit = await seedDeposit("Unit mint excluded deposit", "45.00");
    const unitId = await seedUnit(deposit, "45.00");
    await db
      .update(schema.bankDepositComponents)
      .set({ exclusionReason: "intercompany_transfer" })
      .where(eqFn(schema.bankDepositComponents.paymentUnitId, unitId));
    const excludedMint = await postJson(
      `/api/reconciliation/payment-units/${unitId}/create-gift`,
      { organizationId: ORG_ID },
    );
    expect(excludedMint.status).toBe(409);
    expect(excludedMint.json.error).toBe("unit_excluded");
  });

  it("lists candidate payouts, repoints an ambiguous tie, and unlinks it", async () => {
    const currentDeposit = await seedDeposit("Current payout deposit");
    const targetDeposit = await seedDeposit("Target payout deposit");
    const payoutId = await seedPayout("100.00", currentDeposit, true);

    const candidates = await getJson(
      `/api/reconciliation/deposits/${targetDeposit}/candidate-payouts`,
    );
    expect(candidates.status).toBe(200);
    expect(candidates.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payoutId,
          currentBankDepositId: currentDeposit,
          currentDepositDate: "2099-12-31",
          ambiguous: true,
        }),
      ]),
    );

    const depositCandidates = await getJson(
      `/api/reconciliation/payouts/${payoutId}/candidate-deposits`,
    );
    expect(depositCandidates.status).toBe(200);
    expect(depositCandidates.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bankDepositId: targetDeposit,
          depositDate: "2099-12-31",
          claimed: false,
          ambiguous: false,
        }),
      ]),
    );

    const validLinkResponse = await fetch(
      `${baseUrl}/api/reconciliation/payouts/${payoutId}/bank-deposit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankDepositId: targetDeposit }),
      },
    );
    expect(validLinkResponse.status).toBe(200);
    expect(await validLinkResponse.json()).toEqual({
      payoutId,
      bankDepositId: targetDeposit,
    });
    const linkedPayout = await db.query.stripePayouts.findFirst({
      where: eqFn(schema.stripePayouts.id, payoutId),
    });
    expect(linkedPayout).toMatchObject({
      bankDepositId: targetDeposit,
      ambiguousBankMatch: false,
    });

    const unlinked = await requestJson(
      "DELETE",
      `/api/reconciliation/payouts/${payoutId}/bank-deposit`,
    );
    expect(unlinked.status).toBe(204);
    const unlinkedPayout = await db.query.stripePayouts.findFirst({
      where: eqFn(schema.stripePayouts.id, payoutId),
    });
    expect(unlinkedPayout).toMatchObject({
      bankDepositId: null,
      ambiguousBankMatch: false,
    });
  });

  it("protects missing, occupied, component-backed, and mismatched deposits", async () => {
    const missing = await getJson(
      "/api/reconciliation/deposits/missing-deposit/candidate-payouts",
    );
    expect(missing.status).toBe(404);
    const missingPayoutCandidates = await getJson(
      "/api/reconciliation/payouts/missing-payout/candidate-deposits",
    );
    expect(missingPayoutCandidates.status).toBe(404);
    const missingUnlink = await requestJson(
      "DELETE",
      "/api/reconciliation/payouts/missing-payout/bank-deposit",
    );
    expect(missingUnlink.status).toBe(404);

    const occupied = await seedDeposit("Occupied payout deposit");
    await seedPayout("100.00", occupied);
    const candidate = await seedPayout("100.00");
    const occupiedLink = await fetch(
      `${baseUrl}/api/reconciliation/payouts/${candidate}/bank-deposit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankDepositId: occupied }),
      },
    );
    expect(occupiedLink.status).toBe(409);

    const componentDeposit = await seedDeposit("Occupied component deposit");
    await seedUnit(componentDeposit, "100.00");
    const componentPayout = await seedPayout("100.00");
    const componentLink = await fetch(
      `${baseUrl}/api/reconciliation/payouts/${componentPayout}/bank-deposit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankDepositId: componentDeposit }),
      },
    );
    expect(componentLink.status).toBe(409);

    const mismatchDeposit = await seedDeposit("Mismatched payout deposit");
    const mismatchPayout = await seedPayout("99.00");
    const mismatchLink = await fetch(
      `${baseUrl}/api/reconciliation/payouts/${mismatchPayout}/bank-deposit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankDepositId: mismatchDeposit }),
      },
    );
    expect(mismatchLink.status).toBe(400);
    await expect(mismatchLink.json()).resolves.toMatchObject({
      error: "amount_mismatch",
    });
  });

  it("confirms an ambiguous payout match without changing its deposit", async () => {
    const depositId = await seedDeposit("Confirm payout deposit");
    const payoutId = await seedPayout("100.00", depositId, true);

    const response = await fetch(
      `${baseUrl}/api/reconciliation/payouts/${payoutId}/confirm-bank-match`,
      {
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ payoutId });

    const confirmed = await db.query.stripePayouts.findFirst({
      where: eqFn(schema.stripePayouts.id, payoutId),
    });
    expect(confirmed).toMatchObject({
      bankDepositId: depositId,
      ambiguousBankMatch: false,
    });
  });

  it("returns 404 when confirming an untied or missing payout", async () => {
    const untiedPayout = await seedPayout();
    const untied = await fetch(
      `${baseUrl}/api/reconciliation/payouts/${untiedPayout}/confirm-bank-match`,
      {
        method: "POST",
      },
    );
    expect(untied.status).toBe(404);

    const missing = await fetch(
      `${baseUrl}/api/reconciliation/payouts/missing-payout/confirm-bank-match`,
      {
        method: "POST",
      },
    );
    expect(missing.status).toBe(404);
  });

  it("lists claimed payment units and moves the existing partial component without changing its amount", async () => {
    const sourceDeposit = await seedDeposit(
      "Claimed component source",
      "40.00",
    );
    const targetDeposit = await seedDeposit(
      "Claimed component target",
      "50.00",
    );
    const unitId = nextId("claimed_unit");
    const componentId = nextId("claimed_component");
    await db.insert(schema.paymentUnits).values({
      id: unitId,
      kind: "check",
      grossAmount: "100.00",
      netAmount: "100.00",
      receivedDate: "2099-12-30",
    });
    await db.insert(schema.bankDepositComponents).values({
      id: componentId,
      bankDepositId: sourceDeposit,
      paymentUnitId: unitId,
      amount: "40.00",
      source: "manual",
    });
    unitIds.push(unitId);
    componentIds.push(componentId);

    const candidates = await getJson(
      `/api/reconciliation/deposits/${targetDeposit}/candidate-payment-units?q=${unitId}`,
    );
    expect(candidates.status).toBe(200);
    expect(candidates.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: unitId,
          amount: "100.00",
          claimed: true,
          claimedComponentId: componentId,
          claimedBankDepositId: sourceDeposit,
          claimedComponentAmount: "40.00",
          claimedByCurrentDeposit: false,
        }),
      ]),
    );

    const moved = await postJson(
      `/api/reconciliation/deposits/${targetDeposit}/components`,
      { mode: "attach", paymentUnitId: unitId },
    );
    expect(moved.status).toBe(201);
    expect(moved.json).toMatchObject({
      id: componentId,
      paymentUnitId: unitId,
      amount: "40.00",
    });
    const component = await db.query.bankDepositComponents.findFirst({
      where: eqFn(schema.bankDepositComponents.id, componentId),
    });
    expect(component).toMatchObject({
      bankDepositId: targetDeposit,
      amount: "40.00",
    });
  });

  it("unlinks only the displayed deposit accounting relationship", async () => {
    const depositId = await seedDeposit("Scoped accounting unlink", "75.00");
    const payoutId = await seedPayout("75.00", depositId);
    const stagedPaymentId = nextId("scoped_qbo");
    const sourceLinkId = nextId("scoped_source_link");
    const unitId = nextId("shared_source_unit");
    await db.insert(schema.stagedPayments).values({
      id: stagedPaymentId,
      realmId: RUN,
      qbEntityType: "deposit",
      qbEntityId: nextId("qb_deposit"),
      dateReceived: "2099-12-31",
      amount: "75.00",
    });
    stagedIds.push(stagedPaymentId);
    await db.insert(schema.sourceLinks).values({
      id: sourceLinkId,
      linkType: "payout_qb_settlement",
      stripePayoutId: payoutId,
      qbStagedPaymentId: stagedPaymentId,
      lifecycle: "confirmed",
      provenance: "human",
      matchBasis: "settled_pairing",
    });
    depositQboComponentIds.push(sourceLinkId);
    await db.insert(schema.paymentUnits).values({
      id: unitId,
      kind: "check",
      grossAmount: "75.00",
      netAmount: "75.00",
      receivedDate: "2099-12-31",
      sourceStagedPaymentId: stagedPaymentId,
    });
    unitIds.push(unitId);

    const response = await requestJson(
      "DELETE",
      `/api/reconciliation/deposits/${depositId}/accounting-evidence/${stagedPaymentId}?role=deposit`,
    );
    expect(response.status).toBe(204);
    const remainingLink = await db.query.sourceLinks.findFirst({
      where: eqFn(schema.sourceLinks.id, sourceLinkId),
    });
    expect(remainingLink).toBeUndefined();
    const preservedUnit = await db.query.paymentUnits.findFirst({
      where: eqFn(schema.paymentUnits.id, unitId),
    });
    expect(preservedUnit?.sourceStagedPaymentId).toBe(stagedPaymentId);
  });

  it("filters known-payment candidates by exact amount and date", async () => {
    const depositId = await seedDeposit("Candidate filter target", "9999.00");
    const matchingId = nextId("filter_matching_unit");
    const wrongAmountId = nextId("filter_wrong_amount_unit");
    const wrongDateId = nextId("filter_wrong_date_unit");

    await db.insert(schema.paymentUnits).values([
      {
        id: matchingId,
        kind: "check",
        grossAmount: "9876.54",
        netAmount: "9876.54",
        receivedDate: "2098-04-03",
      },
      {
        id: wrongAmountId,
        kind: "check",
        grossAmount: "9876.55",
        netAmount: "9876.55",
        receivedDate: "2098-04-03",
      },
      {
        id: wrongDateId,
        kind: "check",
        grossAmount: "9876.54",
        netAmount: "9876.54",
        receivedDate: "2098-04-04",
      },
    ]);
    unitIds.push(matchingId, wrongAmountId, wrongDateId);

    const filtered = await getJson(
      `/api/reconciliation/deposits/${depositId}/candidate-payment-units?filterAmount=9876.54&filterDate=2098-04-03&limit=100`,
    );
    expect(filtered.status).toBe(200);
    const ids = filtered.json.data.map((item: { id: string }) => item.id);
    expect(ids).toContain(matchingId);
    expect(ids).not.toContain(wrongAmountId);
    expect(ids).not.toContain(wrongDateId);

    const badAmount = await getJson(
      `/api/reconciliation/deposits/${depositId}/candidate-payment-units?filterAmount=not-money`,
    );
    expect(badAmount.status).toBe(400);

    const badDate = await getJson(
      `/api/reconciliation/deposits/${depositId}/candidate-payment-units?filterDate=2098-99-99`,
    );
    expect(badDate.status).toBe(400);
  });
});

describe.skipIf(!HAS_DB)(
  "POST /reconciliation/payment-units/:id/create-gift with opportunityId (payment on pledge)",
  () => {
    it("mints the gift under the pledge: donor derived from the pledge, allocations copied scaled to the unit money, unit tied", async () => {
      const deposit = await seedDeposit("Pledge payment check", "400.00");
      const unitId = await seedUnit(deposit, "400.00");
      const { oppId, allocationId } = await seedPledge();

      // The body carries NO donor fields — on the pledge path the donor
      // DERIVES from the pledge.
      const res = await postJson(
        `/api/reconciliation/payment-units/${unitId}/create-gift`,
        { opportunityId: oppId },
      );
      expect(res.status).toBe(201);
      const giftId = res.json.gift.id as string;
      expect(giftId).toBeTruthy();
      giftIds.push(giftId);
      expect(res.json.gift.opportunityId).toBe(oppId);
      expect(res.json.gift.organizationId).toBe(ORG_ID);
      // The amount is never overridable — the unit's money books.
      expect(res.json.gift.amount).toBe("400.00");

      // Allocations seed from the pledge's plan scaled to the unit money —
      // stamped with the source pledge allocation, not the default line.
      const allocations = await db
        .select()
        .from(schema.giftAllocations)
        .where(eqFn(schema.giftAllocations.giftId, giftId));
      expect(allocations).toHaveLength(1);
      expect(allocations[0].subAmount).toBe("400.00");
      expect(allocations[0].sourcePledgeAllocationId).toBe(allocationId);

      // The unit's gift tie IS the resolution record: mint-owned.
      const [unit] = await db
        .select()
        .from(schema.paymentUnits)
        .where(eqFn(schema.paymentUnits.id, unitId));
      expect(unit.giftId).toBe(giftId);
      expect(unit.createdTheGift).toBe(true);
    }, 30_000);

    it("rejects non-pledges, lost, archived, and unknown opportunities without minting anything", async () => {
      const deposit = await seedDeposit("Pledge payment blocked", "50.00");
      const unitId = await seedUnit(deposit, "50.00");

      const open = await seedPledge({ writtenPledge: false });
      const lost = await seedPledge({ lossType: "lost" });
      const archived = await seedPledge({ archivedAt: new Date() });

      const cases: Array<[string, number, string]> = [
        [open.oppId, 409, "not_a_pledge"],
        [lost.oppId, 409, "pledge_lost"],
        [archived.oppId, 409, "opportunity_archived"],
        [`${RUN}_missing_opp`, 404, "not_found"],
      ];
      for (const [oppId, status, error] of cases) {
        const res = await postJson(
          `/api/reconciliation/payment-units/${unitId}/create-gift`,
          { opportunityId: oppId },
        );
        expect(res.status).toBe(status);
        expect(res.json.error).toBe(error);
      }

      // The whole mint rolled back every time: unit untied, no gift exists.
      const [unit] = await db
        .select()
        .from(schema.paymentUnits)
        .where(eqFn(schema.paymentUnits.id, unitId));
      expect(unit.giftId).toBeNull();
      const gifts = await db
        .select()
        .from(schema.giftsAndPayments)
        .where(
          inArrayFn(schema.giftsAndPayments.opportunityId, [
            open.oppId,
            lost.oppId,
            archived.oppId,
          ]),
        );
      expect(gifts).toHaveLength(0);
    }, 30_000);
  },
);
