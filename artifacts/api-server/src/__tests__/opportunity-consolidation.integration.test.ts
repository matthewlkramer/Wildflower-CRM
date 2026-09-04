import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `opp_consolidation_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const ORG_ID = `${RUN}_org`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: USER_ID, role: "admin" };
    next();
  },
}));

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: Db;
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";
const opportunityIds: string[] = [];

async function api(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function seedOpportunity(
  suffix: string,
  amount: string,
  closeDate: string,
) {
  const id = `${RUN}_${suffix}`;
  opportunityIds.push(id);
  await db.insert(schema.opportunitiesAndPledges).values({
    id,
    name: `Bainum ${suffix}`,
    organizationId: ORG_ID,
    askAmount: amount,
    status: "open",
    stage: "in_conversation",
    projectedCloseDate: closeDate,
  });
  await db.insert(schema.pledgeAllocations).values({
    id: `${id}_allocation`,
    pledgeOrOpportunityId: id,
    subAmount: amount,
    status: "working",
  });
  return id;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  const drizzle = await import("drizzle-orm");
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@example.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Opportunity Consolidation ${RUN}`,
  });
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (opportunityIds.length) {
    await db
      .delete(schema.pledgeExpectedPayments)
      .where(
        inArrayFn(
          schema.pledgeExpectedPayments.pledgeOrOpportunityId,
          opportunityIds,
        ),
      );
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
    .delete(schema.bulkOperations)
    .where(eqFn(schema.bulkOperations.actorUserId, USER_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("opportunity consolidation", () => {
  it("deduplicates equal opportunities without summing allocations", async () => {
    const survivor = await seedOpportunity(
      "duplicate_a",
      "100.00",
      "2027-06-30",
    );
    const duplicate = await seedOpportunity(
      "duplicate_b",
      "100.00",
      "2027-06-30",
    );

    const result = await api("/api/opportunities-and-pledges/deduplicate", {
      primaryId: survivor,
      mergeIds: [duplicate],
    });

    expect(result.status).toBe(200);
    const [archived] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, duplicate));
    expect(archived.archivedAt).not.toBeNull();
    const survivorAllocations = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, survivor));
    expect(survivorAllocations).toHaveLength(1);
  }, 30_000);

  it("combines two fiscal-year opportunities into one pledge schedule", async () => {
    const fy27 = await seedOpportunity("fy27", "125000.00", "2027-06-30");
    const fy28 = await seedOpportunity("fy28", "175000.00", "2028-06-30");

    const result = await api(
      "/api/opportunities-and-pledges/combine-as-pledge",
      {
        primaryId: fy27,
        mergeIds: [fy28],
        name: "Bainum FY27–FY28 pledge",
        commitmentDate: "2026-09-04",
        expectedPayments: [
          {
            sourceOpportunityId: fy27,
            amount: "125000.00",
            expectedDate: "2027-06-30",
          },
          {
            sourceOpportunityId: fy28,
            amount: "175000.00",
            expectedDate: "2028-06-30",
          },
        ],
      },
    );

    expect(result.status).toBe(200);
    const [pledge] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, fy27));
    expect(pledge.pledgeCommittedAt).toBe("2026-09-04");
    expect(Number(pledge.awardedAmount)).toBe(300000);
    expect(pledge.status).toBe("pledge");
    const schedule = await db
      .select()
      .from(schema.pledgeExpectedPayments)
      .where(eqFn(schema.pledgeExpectedPayments.pledgeOrOpportunityId, fy27));
    expect(schedule).toHaveLength(2);
    const allocations = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, fy27));
    expect(allocations).toHaveLength(2);
    expect(allocations.every((row) => row.status === "committed")).toBe(true);
  }, 30_000);
});
