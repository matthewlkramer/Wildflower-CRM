import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { derivePledgePlanning } from "../lib/pledgePlanning";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `forecast_test_user_${Date.now()}`,
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

const RUN = `forecast_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ENTITY_ID = `${RUN}_entity`;
const ENTITY_B_ID = `${RUN}_entity_b`;
const ENTITY_C_ID = `${RUN}_entity_c`;
const ENTITY_D_ID = `${RUN}_entity_d`;
const PROJECT_A_ID = `${RUN}_project_a`;
const PROJECT_B_ID = `${RUN}_project_b`;
const FY_DATE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).formatToParts(new Date());
const FY_CALENDAR_YEAR = Number(
  FY_DATE_PARTS.find((part) => part.type === "year")?.value ?? "0",
);
const FY_CALENDAR_MONTH = Number(
  FY_DATE_PARTS.find((part) => part.type === "month")?.value ?? "0",
);
const FY_ID = `fy${FY_CALENDAR_YEAR + (FY_CALENDAR_MONTH >= 7 ? 1 : 0)}`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  entities: Db["entities"];
  fundableProjects: Db["fundableProjects"];
  fiscalYears: Db["fiscalYears"];
  fiscalYearEntityGoals: Db["fiscalYearEntityGoals"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server | undefined;
let baseUrl = "";
let fiscalYearWasCreated = false;
let gen = 0;

function nextId(label: string): string {
  gen += 1;
  return `${RUN}_${label}_${String(gen).padStart(3, "0")}`;
}

const giftIds: string[] = [];
const giftAllocationIds = new Map<string, string>();
const opportunityIds: string[] = [];

async function getJson(path: string): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

function expectMoney(actual: string, expected: number): void {
  expect(Number(actual)).toBeCloseTo(expected, 2);
}

async function insertGift(
  amount: string,
  opportunityId: string | null = null,
  allocationAmount = amount,
  entityId: string | null = ENTITY_ID,
  loanOrGrant: "grant" | "loan" = "grant",
  grantYear: string | null = FY_ID,
): Promise<string> {
  const id = nextId("gift");
  giftIds.push(id);
  const allocationId = nextId("galloc");
  giftAllocationIds.set(id, allocationId);
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
    opportunityId,
    loanOrGrant,
  });
  await db.insert(schema.giftAllocations).values({
    id: allocationId,
    giftId: id,
    subAmount: allocationAmount,
    entityId,
    grantYear,
  });
  return id;
}

async function insertOpportunity(
  values: Record<string, unknown>,
): Promise<string> {
  const id = nextId("opp");
  opportunityIds.push(id);
  await db.insert(schema.opportunitiesAndPledges).values({
    id,
    name: `${RUN} ${id}`,
    organizationId: ORG_ID,
    ...values,
  });
  return id;
}

async function insertPledgeAllocation(
  opportunityId: string,
  values: Record<string, unknown>,
): Promise<string> {
  const id = nextId("palloc");
  await db.insert(schema.pledgeAllocations).values({
    id,
    pledgeOrOpportunityId: opportunityId,
    ...values,
  });
  return id;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    entities: dbMod.entities,
    fundableProjects: dbMod.fundableProjects,
    fiscalYears: dbMod.fiscalYears,
    fiscalYearEntityGoals: dbMod.fiscalYearEntityGoals,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `${RUN} Org` });
  await db
    .insert(schema.entities)
    .values({ id: ENTITY_ID, name: `${RUN} Entity` });
  await db
    .insert(schema.entities)
    .values({ id: ENTITY_B_ID, name: `${RUN} Entity B` });
  await db
    .insert(schema.entities)
    .values({ id: ENTITY_C_ID, name: `${RUN} Entity C` });
  await db
    .insert(schema.entities)
    .values({ id: ENTITY_D_ID, name: `${RUN} Entity D` });
  await db.insert(schema.fundableProjects).values([
    { id: PROJECT_A_ID, name: `${RUN} Project A` },
    { id: PROJECT_B_ID, name: `${RUN} Project B` },
  ]);
  const existingFy = await db
    .select({ id: schema.fiscalYears.id })
    .from(schema.fiscalYears)
    .where(eqFn(schema.fiscalYears.id, FY_ID));
  if (existingFy.length === 0) {
    fiscalYearWasCreated = true;
    await db.insert(schema.fiscalYears).values({
      id: FY_ID,
      label: `FY ${FY_ID.slice(2)}`,
      startDate: `${Number(FY_ID.slice(2)) - 1}-07-01`,
      endDate: `${FY_ID.slice(2)}-06-30`,
    });
  }

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (giftIds.length) {
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  if (opportunityIds.length) {
    await db
      .delete(schema.pledgeAllocations)
      .where(
        inArrayFn(
          schema.pledgeAllocations.pledgeOrOpportunityId,
          opportunityIds,
        ),
      );
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, opportunityIds));
  }
  await db
    .delete(schema.fiscalYearEntityGoals)
    .where(eqFn(schema.fiscalYearEntityGoals.fiscalYearId, FY_ID));
  if (fiscalYearWasCreated) {
    await db
      .delete(schema.fiscalYears)
      .where(eqFn(schema.fiscalYears.id, FY_ID));
  }
  await db.delete(schema.entities).where(eqFn(schema.entities.id, ENTITY_ID));
  await db.delete(schema.entities).where(eqFn(schema.entities.id, ENTITY_B_ID));
  await db.delete(schema.entities).where(eqFn(schema.entities.id, ENTITY_C_ID));
  await db.delete(schema.entities).where(eqFn(schema.entities.id, ENTITY_D_ID));
  await db.delete(schema.fundableProjects).where(inArrayFn(
    schema.fundableProjects.id,
    [PROJECT_A_ID, PROJECT_B_ID],
  ));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

describe("pledge planning pre-award state", () => {
  it("returns null and no gaps before award, but false for an incomplete won pledge", () => {
    const open = derivePledgePlanning({
      status: "open",
      disbursementModel: "fixed_commitment",
      awardedAmount: null,
      allocations: [],
      expectedPaymentCount: 0,
    });
    expect(open.planningComplete).toBeNull();
    expect(open.planningGaps).toEqual([]);

    const won = derivePledgePlanning({
      status: "pledge",
      disbursementModel: "fixed_commitment",
      awardedAmount: "1000.00",
      allocations: [],
      expectedPaymentCount: 0,
    });
    expect(won.planningComplete).toBe(false);
    expect(won.planningGaps.length).toBeGreaterThan(0);
  });
});

// prettier-ignore


describe.skipIf(!HAS_DB)("allocation-grain forecasting regression", () => {
  it("reconciles Dashboard, FY report, and Projections and reports intentional omissions", async () => {
    await db.insert(schema.fiscalYearEntityGoals).values({
      fiscalYearId: FY_ID,
      entityId: ENTITY_ID,
      loanOrGrant: "grant",
      goalAmount: "1000.00",
    });

    await insertGift("100.00");

    const pledgeId = await insertOpportunity({
      status: "pledge",
      stage: "verbal_confirmation",
      winProbability: "0.5000",
      disbursementModel: "fixed_commitment",
    });
    await insertPledgeAllocation(pledgeId, {
      subAmount: "300.00",
      grantYear: FY_ID,
      entityId: ENTITY_ID,
    });
    await insertGift("100.00", pledgeId);

    const openId = await insertOpportunity({
      status: "open",
      stage: "in_conversation",
      winProbability: "0.2500",
    });
    await insertPledgeAllocation(openId, {
      subAmount: "400.00",
      grantYear: FY_ID,
      entityId: ENTITY_ID,
    });

    const archivedId = await insertOpportunity({
      status: "open",
      stage: "in_conversation",
      winProbability: "1.0000",
      archivedAt: new Date(),
    });
    await insertPledgeAllocation(archivedId, {
      subAmount: "999.00",
      grantYear: FY_ID,
      entityId: ENTITY_ID,
    });

    const noAllocationId = await insertOpportunity({
      status: "open",
      stage: "in_conversation",
      winProbability: "0.2000",
    });
    const missingId = await insertOpportunity({
      status: "open",
      stage: "in_conversation",
      winProbability: "0.2000",
    });
    const missingAllocationId = await insertPledgeAllocation(missingId, {
      subAmount: null,
      grantYear: null,
      entityId: null,
    });
    const missingRecipientId = await insertOpportunity({
      status: "open",
      stage: "in_conversation",
      winProbability: "0.2000",
    });
    await insertPledgeAllocation(missingRecipientId, {
      subAmount: "55.00",
      grantYear: FY_ID,
      entityId: null,
    });
    const directId = await insertOpportunity({
      status: "open",
      stage: "in_conversation",
      winProbability: "0.2000",
      disbursementModel: "cost_reimbursement",
    });
    const directAllocationId = await insertPledgeAllocation(directId, {
      subAmount: "90.00",
      grantYear: FY_ID,
      entityId: ENTITY_ID,
      reimbursementType: "direct",
    });
    const unusedCapacityId = await insertOpportunity({
      status: "pledge",
      stage: "verbal_confirmation",
      winProbability: "0.9000",
      disbursementModel: "cost_reimbursement",
    });
    const untaggedId = await insertOpportunity({
      status: "open",
      stage: "in_conversation",
      winProbability: "0.2000",
      disbursementModel: "cost_reimbursement",
    });
    await insertPledgeAllocation(untaggedId, {
      subAmount: "80.00",
      grantYear: FY_ID,
      entityId: ENTITY_ID,
      reimbursementType: null,
    });
    const zeroWeightId = await insertOpportunity({
      status: "open",
      stage: "in_conversation",
      winProbability: "0.0000",
    });
    await insertPledgeAllocation(zeroWeightId, {
      subAmount: "70.00",
      grantYear: FY_ID,
      entityId: ENTITY_ID,
    });
    // Regression for cross-recipient payment netting: the authoritative
    // combined calculation caps this opportunity's $200 payment once, while
    // recipient comparison scopes calculate A and B independently.
    const crossRecipientId = await insertOpportunity({
      status: "pledge",
      stage: "verbal_confirmation",
      winProbability: "0.5000",
      disbursementModel: "fixed_commitment",
      loanOrGrant: "loan",
    });
    await insertPledgeAllocation(crossRecipientId, {
      subAmount: "100.00",
      grantYear: FY_ID,
      entityId: ENTITY_ID,
    });
    await insertPledgeAllocation(crossRecipientId, {
      subAmount: "100.00",
      grantYear: FY_ID,
      entityId: ENTITY_B_ID,
    });
    await insertGift(
      "200.00",
      crossRecipientId,
      "200.00",
      ENTITY_ID,
      "loan",
    );
    const allocationGrainOpenId = await insertOpportunity({
      status: "open",
      stage: "in_conversation",
      winProbability: "0.2000",
      loanOrGrant: "loan",
    });
    const openAAllocationId = await insertPledgeAllocation(
      allocationGrainOpenId,
      {
        subAmount: "100.00",
        grantYear: FY_ID,
        entityId: ENTITY_ID,
        intendedUsage: "project",
        fundableProjectId: PROJECT_A_ID,
      },
    );
    const openBAllocationId = await insertPledgeAllocation(
      allocationGrainOpenId,
      {
        subAmount: "200.00",
        grantYear: FY_ID,
        entityId: ENTITY_B_ID,
        intendedUsage: "project",
        fundableProjectId: PROJECT_B_ID,
      },
    );
    const precisionAllocationIds = await Promise.all(
      [1, 2, 3].map(() =>
        insertPledgeAllocation(allocationGrainOpenId, {
          subAmount: "0.01",
          grantYear: FY_ID,
          entityId: ENTITY_ID,
          intendedUsage: "gen_ops",
        }),
      ),
    );

    const dashboard = await getJson(
      `/api/dashboard-summary?entityIds=${ENTITY_ID}`,
    );
    const report = await getJson(
      `/api/fiscal-year-report/${FY_ID}?category=revenue&entityIds=${ENTITY_ID}`,
    );
    const projections = await getJson(
      `/api/projections-by-fy-entity?entityId=${ENTITY_ID}`,
    );
    const dashboardAll = await getJson("/api/dashboard-summary");
    const dashboardB = await getJson(
      `/api/dashboard-summary?entityIds=${ENTITY_B_ID}`,
    );
    const projectionsAll = await getJson("/api/projections-by-fy-entity");
    const projectionsB = await getJson(
      `/api/projections-by-fy-entity?entityId=${ENTITY_B_ID}`,
    );
    const projectionsLoan = await getJson(
      `/api/projections-by-fy-entity?entityId=${ENTITY_ID}&category=loan_capital`,
    );
    const metrics = dashboard.byFiscalYear.find(
      (row: { fiscalYear: { id: string } }) => row.fiscalYear.id === FY_ID,
    ).revenue;

    expectMoney(metrics.received, 200);
    expectMoney(metrics.committed, 200);
    expectMoney(metrics.committedWeighted, 100);
    expectMoney(metrics.openPipelineAsk, 470);
    expectMoney(metrics.openPipelineWeighted, 100);
    expectMoney(metrics.goalGap, 600);

    expectMoney(report.totals.received, 200);
    expectMoney(report.totals.committed, 200);
    expectMoney(report.totals.committedWeighted, 100);
    expectMoney(report.totals.openAsk, 470);
    expectMoney(report.totals.openWeighted, 100);
    expectMoney(report.totals.weightedProjection, 400);
    expectMoney(report.totals.goalGap, 600);

    const projection = projections.rows.find(
      (row: { grantYear: string; entityId: string; category: string }) =>
        row.grantYear === FY_ID &&
        row.entityId === ENTITY_ID &&
        row.category === "revenue",
    );
    expectMoney(projection.receivedGoalCredit, 200);
    expectMoney(projection.unpaidCommitment, 200);
    expectMoney(projection.unpaidCommitmentWeighted, 100);
    expectMoney(projection.openAsk, 470);
    expectMoney(projection.openAskWeighted, 100);
    expectMoney(projection.goal, 1000);
    expectMoney(projection.goalGap, 600);

    const dashboardAllMetrics = dashboardAll.byFiscalYear.find(
      (row: { fiscalYear: { id: string } }) => row.fiscalYear.id === FY_ID,
    ).loanCapital;
    const dashboardAMetrics = dashboard.byFiscalYear.find(
      (row: { fiscalYear: { id: string } }) => row.fiscalYear.id === FY_ID,
    ).loanCapital;
    const dashboardBMetrics = dashboardB.byFiscalYear.find(
      (row: { fiscalYear: { id: string } }) => row.fiscalYear.id === FY_ID,
    ).loanCapital;
    expectMoney(dashboardAllMetrics.committed, 0);
    expectMoney(dashboardAMetrics.committed, 0);
    expectMoney(dashboardBMetrics.committed, 100);

    // The cross-recipient opportunity is the only loan-capital commitment in
    // this fixture, so these are exact combined-vs-recipient assertions.
    const reportAllLoan = await getJson(
      `/api/fiscal-year-report/${FY_ID}?category=loan_capital`,
    );
    const reportBLoan = await getJson(
      `/api/fiscal-year-report/${FY_ID}?category=loan_capital&entityIds=${ENTITY_B_ID}`,
    );
    const reportALoan = await getJson(
      `/api/fiscal-year-report/${FY_ID}?category=loan_capital&entityIds=${ENTITY_ID}`,
    );
    expectMoney(reportAllLoan.totals.committed, 0);
    expectMoney(reportALoan.totals.committed, 0);
    expectMoney(reportBLoan.totals.committed, 100);
    expectMoney(reportAllLoan.totals.openAsk, 300.03);
    expect(Number(reportAllLoan.totals.openWeighted)).toBeCloseTo(60.006, 6);
    const loanOpenRows = reportAllLoan.rows.filter(
      (row: { bucket: string; opportunityId: string }) =>
        row.bucket === "open" && row.opportunityId === allocationGrainOpenId,
    );
    expect(loanOpenRows.map((row: any) => row.rowId)).toEqual(
      expect.arrayContaining([
        `open:${openAAllocationId}`,
        `open:${openBAllocationId}`,
        ...precisionAllocationIds.map((id) => `open:${id}`),
      ]),
    );
    expect(loanOpenRows.find((row: any) => row.rowId === `open:${openAAllocationId}`))
      .toMatchObject({
        entityId: ENTITY_ID,
        intendedUsage: "project",
        fundableProjectId: PROJECT_A_ID,
      });
    expect(loanOpenRows.find((row: any) => row.rowId === `open:${openBAllocationId}`))
      .toMatchObject({
        entityId: ENTITY_B_ID,
        intendedUsage: "project",
        fundableProjectId: PROJECT_B_ID,
      });
    const reportBCommitted = reportBLoan.rows.find(
      (row: { bucket: string; opportunityId: string }) =>
        row.bucket === "committed" && row.opportunityId === crossRecipientId,
    );
    expect(reportBCommitted).toMatchObject({
      rowId: `committed:${crossRecipientId}`,
    });
    expect(Number(reportBCommitted.amount)).toBe(100);

    const combinedAll = projectionsAll.combinedRows.find(
      (row: { grantYear: string; category: string }) =>
        row.grantYear === FY_ID && row.category === "loan_capital",
    );
    const combinedA = projections.combinedRows.find(
      (row: { grantYear: string; category: string }) =>
        row.grantYear === FY_ID && row.category === "loan_capital",
    );
    const combinedB = projectionsB.combinedRows.find(
      (row: { grantYear: string; category: string }) =>
        row.grantYear === FY_ID && row.category === "loan_capital",
    );
    expectMoney(combinedAll.unpaidCommitment, 0);
    expectMoney(combinedA.unpaidCommitment, 0);
    expectMoney(combinedB.unpaidCommitment, 100);
    expect(combinedAll.contributionIds).not.toContain(
      `committed:${crossRecipientId}`,
    );
    expect(combinedA.contributionIds).not.toContain(
      `committed:${crossRecipientId}`,
    );
    expect(combinedB.contributionIds).toContain(reportBCommitted.rowId);
    const combinedAllLoan = projectionsAll.combinedRows.find(
      (row: { grantYear: string; category: string }) =>
        row.grantYear === FY_ID && row.category === "loan_capital",
    );
    expectMoney(combinedAllLoan.openAsk, 300.03);
    expect(Number(combinedAllLoan.openAskWeighted)).toBeCloseTo(60.006, 6);
    expect(combinedAllLoan.contributionIds).toEqual(
      expect.arrayContaining(
        precisionAllocationIds.map((id) => `open:${id}`),
      ),
    );
    const combinedALoan = projections.combinedRows.find(
      (row: { grantYear: string; category: string }) =>
        row.grantYear === FY_ID && row.category === "loan_capital",
    );
    const combinedBLoan = projectionsB.combinedRows.find(
      (row: { grantYear: string; category: string }) =>
        row.grantYear === FY_ID && row.category === "loan_capital",
    );
    expectMoney(combinedALoan.openAsk, 100.03);
    expectMoney(combinedBLoan.openAsk, 200);

    // The cross-recipient opportunity is not a missing-recipient gap in a
    // selected view, and recipient-specific diagnostics do not leak B-only
    // records into the A response.
    expect(
      projections.diagnostics.map((d: any) => d.opportunityId),
    ).not.toContain(crossRecipientId);

    const openRows = report.rows.filter((row: any) => row.bucket === "open");
    expect(openRows.map((row: any) => row.opportunityId)).not.toContain(
      archivedId,
    );
    expect(openRows.map((row: any) => row.opportunityId)).toContain(
      zeroWeightId,
    );
    expect(
      Number(
        openRows.find((row: any) => row.opportunityId === zeroWeightId)
          ?.weightedAmount,
      ),
    ).toBe(0);

    const diagnostics = new Map(
      projections.diagnostics.map(
        (d: { opportunityId: string; reasons: string[] }) => [
          d.opportunityId,
          d.reasons,
        ],
      ),
    );
    expect(diagnostics.has(archivedId)).toBe(false);
    expect(diagnostics.get(noAllocationId)).toContain("no_allocations");
    expect(diagnostics.get(missingId)).toEqual(
      expect.arrayContaining([
        "missing_amount",
        "missing_fiscal_year",
        "missing_recipient",
      ]),
    );
    expect(diagnostics.get(directId)).toEqual([
      "direct_reimbursement_excluded",
    ]);
    expect(diagnostics.get(unusedCapacityId)).toEqual(["unused_capacity"]);
    expect(
      projections.diagnostics.find(
        (d: any) => d.opportunityId === unusedCapacityId,
      ),
    ).toMatchObject({
      reasons: ["unused_capacity"],
      message:
        "Cost-reimbursement award has unused capacity; no drawdown plan is recorded.",
    });
    expect(
      projectionsLoan.diagnostics.map((d: any) => d.opportunityId),
    ).not.toContain(zeroWeightId);
    expect(diagnostics.get(untaggedId)).toContain("missing_reimbursement_type");
    expect(diagnostics.get(zeroWeightId)).toEqual([
      "zero_weight_early_prospect",
    ]);
    expect(diagnostics.get(missingId)).not.toContain(
      "direct_reimbursement_excluded",
    );
    expect(
      projections.diagnostics.find(
        (d: any) => d.opportunityId === missingRecipientId,
      ),
    ).toMatchObject({
      reasons: expect.arrayContaining(["missing_recipient"]),
      message:
        "A known-year amount can be included in the all-recipients forecast but is omitted from a selected-recipient forecast until a recipient is assigned.",
    });
    expect(
      projections.diagnostics.find((d: any) => d.opportunityId === missingId),
    ).toMatchObject({
      allocationId: missingAllocationId,
      grantYear: null,
      entityId: null,
    });
    expect(
      projections.diagnostics.find((d: any) => d.opportunityId === directId),
    ).toMatchObject({
      allocationId: directAllocationId,
      grantYear: FY_ID,
      entityId: ENTITY_ID,
    });
  }, 60_000);

  it("discovers gift/goal-only recipients, empty current and next years, and isolated unknown buckets", async () => {
    const knownGiftId = await insertGift("23.00", null, "23.00", ENTITY_C_ID);
    await db.insert(schema.fiscalYearEntityGoals).values({
      fiscalYearId: FY_ID,
      entityId: ENTITY_C_ID,
      loanOrGrant: "grant",
      goalAmount: "500.00",
    });
    const unknownGiftId = await insertGift(
      "37.00",
      null,
      "37.00",
      null,
      "grant",
      null,
    );

    const projections = await getJson(
      `/api/projections-by-fy-entity?entityId=${ENTITY_C_ID}`,
    );
    const byCell = (grantYear: string | null, entityId: string | null) =>
      projections.rows.find(
        (row: {
          grantYear: string | null;
          entityId: string | null;
          category: string;
        }) =>
          row.grantYear === grantYear &&
          row.entityId === entityId &&
          row.category === "revenue",
      );
    const current = byCell(FY_ID, ENTITY_C_ID);
    expect(current).toBeDefined();
    expectMoney(current.receivedGoalCredit, 23);
    expectMoney(current.goal, 500);
    expectMoney(current.goalGap, 477);

    const selectedCombined = projections.combinedRows.find(
      (row: { grantYear: string | null; category: string }) =>
        row.grantYear === FY_ID && row.category === "revenue",
    );
    expect(selectedCombined).toBeDefined();
    expectMoney(selectedCombined.goal, 500);
    expectMoney(selectedCombined.goalGap, 477);

    const nextFy = `fy${Number(FY_ID.slice(2)) + 1}`;
    const next = byCell(nextFy, ENTITY_C_ID);
    expect(next).toBeDefined();
    expectMoney(next.receivedGoalCredit, 0);
    expectMoney(next.openAsk, 0);

    const allProjections = await getJson("/api/projections-by-fy-entity");
    const allByCell = (grantYear: string | null, entityId: string | null) =>
      allProjections.rows.find(
        (row: {
          grantYear: string | null;
          entityId: string | null;
          category: string;
        }) =>
          row.grantYear === grantYear &&
          row.entityId === entityId &&
          row.category === "revenue",
      );
    const unknown = allByCell(null, null);
    expect(unknown).toBeDefined();
    // The unfiltered unknown bucket can contain unrelated full-suite fixtures.
    // Identify this fixture's contribution directly and ensure the known
    // recipient's gift was not copied into the unknown bucket.
    expect(unknown.contributionIds).toContain(
      `received:${giftAllocationIds.get(unknownGiftId)}`,
    );
    expect(unknown.contributionIds).not.toContain(
      `received:${giftAllocationIds.get(knownGiftId)}`,
    );
    expect(unknown.goal).toBeNull();
    expect(unknown.goalGap).toBeNull();
    const unknownAllocation = await db
      .select({ subAmount: schema.giftAllocations.subAmount })
      .from(schema.giftAllocations)
      .where(
        eqFn(
          schema.giftAllocations.id,
          giftAllocationIds.get(unknownGiftId)!,
        ),
      );
    expect(unknownAllocation[0]?.subAmount).toBe("37.00");

    const unknownFyKnownRecipient = allByCell(null, ENTITY_C_ID);
    expect(unknownFyKnownRecipient).toBeDefined();
    expectMoney(unknownFyKnownRecipient.receivedGoalCredit, 0);

    const unknownCurrent = allByCell(FY_ID, null);
    expect(unknownCurrent).toBeDefined();
    expect(unknownCurrent.goal).toBeNull();
    expect(unknownCurrent.goalGap).toBeNull();
  }, 60_000);

  it("keeps mixed weighted components precise until the aggregate is displayed", async () => {
    const committedId = await insertOpportunity({
      status: "pledge",
      stage: "verbal_confirmation",
      winProbability: "0.6000",
    });
    await insertPledgeAllocation(committedId, {
      subAmount: "0.01",
      grantYear: FY_ID,
      entityId: ENTITY_D_ID,
    });
    const openId = await insertOpportunity({
      status: "open",
      stage: "in_conversation",
      winProbability: "0.6000",
    });
    await insertPledgeAllocation(openId, {
      subAmount: "0.01",
      grantYear: FY_ID,
      entityId: ENTITY_D_ID,
    });

    const dashboard = await getJson(
      `/api/dashboard-summary?entityIds=${ENTITY_D_ID}`,
    );
    const report = await getJson(
      `/api/fiscal-year-report/${FY_ID}?category=revenue&entityIds=${ENTITY_D_ID}`,
    );
    const projections = await getJson(
      `/api/projections-by-fy-entity?entityId=${ENTITY_D_ID}`,
    );
    const dashboardMetrics = dashboard.byFiscalYear.find(
      (row: { fiscalYear: { id: string } }) => row.fiscalYear.id === FY_ID,
    ).revenue;
    const projection = projections.rows.find(
      (row: { grantYear: string; entityId: string; category: string }) =>
        row.grantYear === FY_ID &&
        row.entityId === ENTITY_D_ID &&
        row.category === "revenue",
    );
    const combined = projections.combinedRows.find(
      (row: { grantYear: string; category: string }) =>
        row.grantYear === FY_ID && row.category === "revenue",
    );

    expect(dashboardMetrics.received).toBe("0");
    expect(dashboardMetrics.committedWeighted).toBe("0.006");
    expect(dashboardMetrics.openPipelineWeighted).toBe("0.006");
    expect(
      Number(dashboardMetrics.committedWeighted) +
        Number(dashboardMetrics.openPipelineWeighted),
    ).toBeCloseTo(0.012, 12);

    expect(report.totals.received).toBe("0");
    expect(report.totals.committedWeighted).toBe("0.006");
    expect(report.totals.openWeighted).toBe("0.006");
    expect(report.totals.weightedProjection).toBe("0.012");

    expect(projection.receivedGoalCredit).toBe("0");
    expect(projection.unpaidCommitmentWeighted).toBe("0.006");
    expect(projection.openAskWeighted).toBe("0.006");
    expect(
      Number(projection.unpaidCommitmentWeighted) +
        Number(projection.openAskWeighted),
    ).toBeCloseTo(0.012, 12);
    expect(combined.receivedGoalCredit).toBe("0");
    expect(combined.unpaidCommitmentWeighted).toBe("0.006");
    expect(combined.openAskWeighted).toBe("0.006");

    // The UI formats the aggregate, not each already-precise component:
    // 0.006 + 0.006 displays as $0.01, whereas independently rounding the
    // components before summing would incorrectly display $0.02.
    expect(Number(report.totals.weightedProjection).toFixed(2)).toBe("0.01");
  }, 60_000);
});