import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the reimbursable direct/indirect share exclusion
 * (Task #364). DIRECT-tagged allocation lines are recorded in full but EXCLUDED
 * from goal analytics (received, open ask, weighted ask); untagged (null) and
 * `indirect` both still count. The tag must NEVER change opportunity-status or
 * pledge paid-amount derivation.
 *
 * Asserts against the real route handlers + the real `applyDerivedOppFields`
 * derivation, hitting the dev Postgres so the SQL exclusion predicate
 * (`reimbursement_type IS DISTINCT FROM 'direct'`) is actually exercised.
 *
 * The only seam mocked is the Clerk auth gate. All seeded rows use a unique run
 * prefix and are cleaned up. Skips automatically when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `rsh_test_user_${Date.now()}`,
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

const RUN = `rsh_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ENTITY_ID = `${RUN}_entity`;
const FY_ID = `${RUN}_fy`;

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  entities: Db["entities"];
  fiscalYears: Db["fiscalYears"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let applyDerivedOppFields: (typeof import("../lib/pledgeStage"))["applyDerivedOppFields"];
let server: Server;
let baseUrl = "";

let gen = 0;
function nextId(label: string): string {
  gen += 1;
  return `${RUN}_${label}_${String(gen).padStart(3, "0")}`;
}

const seededGiftIds: string[] = [];
const seededOppIds: string[] = [];

type Share = "direct" | "indirect" | null;

/** Seed a goal-counting gift + a single allocation in the test FY. */
async function seedGift(subAmount: string, share: Share): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: subAmount,
    organizationId: ORG_ID,
    type: "standard_gift",
  });
  await db.insert(schema.giftAllocations).values({
    id: nextId("galloc"),
    giftId: id,
    subAmount,
    entityId: ENTITY_ID,
    grantYear: FY_ID,
    reimbursementType: share,
  });
  seededGiftIds.push(id);
  return id;
}

/** Seed an OPEN opp + a single pledge allocation in the test FY. */
async function seedOpenPledgeAlloc(subAmount: string, share: Share): Promise<string> {
  const oppId = nextId("opp");
  await db.insert(schema.opportunitiesAndPledges).values({
    id: oppId,
    name: `RSH open ${oppId}`,
    organizationId: ORG_ID,
    status: "open",
    stage: "in_conversation",
  });
  await db.insert(schema.pledgeAllocations).values({
    id: nextId("palloc"),
    pledgeOrOpportunityId: oppId,
    subAmount,
    entityId: ENTITY_ID,
    grantYear: FY_ID,
    reimbursementType: share,
  });
  seededOppIds.push(oppId);
  return oppId;
}

async function getBreakdown(): Promise<any> {
  const res = await fetch(`${baseUrl}/api/fiscal-year-breakdown/${FY_ID}`);
  const body = await res.json();
  if (res.status !== 200) {
    throw new Error(`breakdown ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  const pledgeStage = await import("../lib/pledgeStage");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    entities: dbMod.entities,
    fiscalYears: dbMod.fiscalYears,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  applyDerivedOppFields = pledgeStage.applyDerivedOppFields;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({ id: ORG_ID, name: `RSH Org ${RUN}` });
  await db.insert(schema.entities).values({ id: ENTITY_ID, name: `RSH Entity ${RUN}` });
  await db.insert(schema.fiscalYears).values({ id: FY_ID, label: `FY ${RUN}` });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (seededGiftIds.length) {
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, seededGiftIds));
  }
  if (seededOppIds.length) {
    await db
      .delete(schema.pledgeAllocations)
      .where(inArrayFn(schema.pledgeAllocations.pledgeOrOpportunityId, seededOppIds));
  }
  if (seededGiftIds.length) {
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, seededGiftIds));
  }
  if (seededOppIds.length) {
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, seededOppIds));
  }
  await db.delete(schema.fiscalYears).where(eqFn(schema.fiscalYears.id, FY_ID));
  await db.delete(schema.entities).where(eqFn(schema.entities.id, ENTITY_ID));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) console.warn("[reimbursable-share-analytics] skipped: no live DATABASE_URL");
});

describe.skipIf(!HAS_DB)("reimbursable share — goal analytics exclusion", () => {
  it("excludes DIRECT gift allocations from received; null + indirect still count", async () => {
    await seedGift("1000.00", null); // untagged → counts
    await seedGift("500.00", "indirect"); // indirect → counts
    const directGift = await seedGift("700.00", "direct"); // direct → excluded

    const body = await getBreakdown();
    expect(body.revenue.received.total).toBe("1500.00");

    const rowGiftIds = body.revenue.received.rows.map((r: { giftId: string }) => r.giftId);
    expect(rowGiftIds).not.toContain(directGift);
  });

  it("excludes DIRECT pledge allocations from open ask + weighted; null + indirect count", async () => {
    await seedOpenPledgeAlloc("2000.00", null); // untagged → counts
    await seedOpenPledgeAlloc("1000.00", "indirect"); // indirect → counts
    const directOpp = await seedOpenPledgeAlloc("800.00", "direct"); // direct → excluded

    const body = await getBreakdown();
    expect(body.revenue.openPipeline.totalAsk).toBe("3000.00");
    // winProbability null ⇒ weight 1, so weighted matches ask.
    expect(body.revenue.openPipeline.totalWeighted).toBe("3000.00");

    const rowOppIds = body.revenue.openPipeline.rows.map(
      (r: { opportunityId: string }) => r.opportunityId,
    );
    expect(rowOppIds).not.toContain(directOpp);
  });

  it("does NOT change pledge paid-amount / cash_in derivation for a reimbursable pledge", async () => {
    // A reimbursable pledge whose FULL award (direct + indirect) is paid must
    // still derive to cash_in — the share tag is irrelevant to derivation.
    const oppId = nextId("opp");
    await db.insert(schema.opportunitiesAndPledges).values({
      id: oppId,
      name: `RSH paid ${oppId}`,
      organizationId: ORG_ID,
      stage: "written_commitment",
      conditional: "reimbursable",
      awardedAmount: "1500.00",
      writtenPledge: true,
    });
    seededOppIds.push(oppId);
    await db.insert(schema.pledgeAllocations).values([
      {
        id: nextId("palloc"),
        pledgeOrOpportunityId: oppId,
        subAmount: "1000.00",
        entityId: ENTITY_ID,
        grantYear: FY_ID,
        reimbursementType: "direct",
      },
      {
        id: nextId("palloc"),
        pledgeOrOpportunityId: oppId,
        subAmount: "500.00",
        entityId: ENTITY_ID,
        grantYear: FY_ID,
        reimbursementType: "indirect",
      },
    ]);

    // Full payment (covers the whole award) linked to the pledge.
    const payId = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: payId,
      amount: "1500.00",
      organizationId: ORG_ID,
      type: "standard_gift",
      opportunityId: oppId,
    });
    seededGiftIds.push(payId);

    await applyDerivedOppFields(oppId);

    const [row] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, oppId));
    expect(row?.status).toBe("cash_in");
    // A won row's funnel stage always reads 'complete' (deriveOppFields);
    // 'cash_in' is the derived STATUS, not a funnel stage.
    expect(row?.stage).toBe("complete");
  });
});
