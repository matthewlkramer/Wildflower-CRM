import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Bulk-update field coverage — POST /gifts-and-payments/bulk-update and
 * POST /opportunities-and-pledges/bulk-update (Task #794 step 7).
 *
 * Money-correctness invariants locked in here:
 *
 *   - GIFTS: the scalar whitelist (ownerUserId / loanOrGrant / paymentMethod /
 *     dateReceived) persists on every row, and the allocation virtuals
 *     (entityIds replace, grantYears append, intendedUsage + fundableProjectId)
 *     reconcile gift_allocations rows correctly;
 *   - fundableProjectId is only honored when intendedUsage='project'; any
 *     other usage clears it;
 *   - OPPS: scalar whitelist (ownerUserId / type / writtenPledge /
 *     projectedCloseDate / applicationDeadline) persists, derived fields are
 *     recomputed after (writtenPledge=true ⇒ derived status='pledge');
 *   - the close-transition rule is enforced PER ROW: lossType without an
 *     actualCompletionDate fails that row (row-level failure, not a 400),
 *     while supplying the date lets it close;
 *   - non-whitelisted junk in the patch is ignored, unknown ids fail per-row.
 *
 * Only the Clerk auth gate is mocked. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `bulkupd_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const OWNER_ID = `${RUN}_owner`;
const ORG_ID = `${RUN}_org`;
const ENT_A = `${RUN}_ent_a`;
const ENT_B = `${RUN}_ent_b`;
const FY_ID = `${RUN}_fy`;
const PROJ_ID = `${RUN}_proj`;
const GIFT_1 = `${RUN}_g1`;
const GIFT_2 = `${RUN}_g2`;
const OPP_1 = `${RUN}_o1`;
const OPP_2 = `${RUN}_o2`;
const OPP_CLOSE = `${RUN}_o_close`;

const auth = vi.hoisted(() => ({
  current: { id: "", role: "" } as { id: string; role: string },
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

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  entities: Db["entities"];
  fiscalYears: Db["fiscalYears"];
  fundableProjects: Db["fundableProjects"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  bulkOperations: Db["bulkOperations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let arrayContainsFn: (typeof import("drizzle-orm"))["arrayContains"];
let server: Server;
let baseUrl = "";

async function bulk(
  path: "gifts-and-payments" | "opportunities-and-pledges",
  body: Record<string, unknown>,
): Promise<{
  status: number;
  json: {
    requested?: number;
    succeededIds?: string[];
    failed?: { id: string; message: string }[];
    error?: string;
  };
}> {
  const res = await fetch(`${baseUrl}/api/${path}/bulk-update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as never };
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
    fiscalYears: dbMod.fiscalYears,
    fundableProjects: dbMod.fundableProjects,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    bulkOperations: dbMod.bulkOperations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  arrayContainsFn = drizzle.arrayContains;

  await db.insert(schema.users).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
    {
      id: OWNER_ID,
      clerkId: `clerk_${OWNER_ID}`,
      email: `${OWNER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `BulkUpd Org ${RUN}` });
  await db.insert(schema.entities).values([
    { id: ENT_A, name: `BulkUpd Entity A ${RUN}` },
    { id: ENT_B, name: `BulkUpd Entity B ${RUN}` },
  ]);
  await db
    .insert(schema.fiscalYears)
    .values({ id: FY_ID, label: `BulkUpd FY ${RUN}` })
    .onConflictDoNothing();
  await db
    .insert(schema.fundableProjects)
    .values({ id: PROJ_ID, name: `BulkUpd Project ${RUN}` });

  await db.insert(schema.giftsAndPayments).values([
    {
      id: GIFT_1,
      name: `BulkUpd gift 1 ${RUN}`,
      organizationId: ORG_ID,
      amount: "100.00",
      dateReceived: "2099-01-10",
    },
    {
      id: GIFT_2,
      name: `BulkUpd gift 2 ${RUN}`,
      organizationId: ORG_ID,
      amount: "200.00",
      dateReceived: "2099-01-11",
    },
  ]);
  // Gift 1 starts with an ENT_A allocation (to be REPLACED by ENT_B).
  await db.insert(schema.giftAllocations).values({
    id: `${RUN}_ga_pre`,
    giftId: GIFT_1,
    entityId: ENT_A,
    subAmount: "100.00",
  });

  await db.insert(schema.opportunitiesAndPledges).values([
    {
      id: OPP_1,
      name: `BulkUpd opp 1 ${RUN}`,
      organizationId: ORG_ID,
      stage: "warm_lead",
      askAmount: "1000.00",
    },
    {
      id: OPP_2,
      name: `BulkUpd opp 2 ${RUN}`,
      organizationId: ORG_ID,
      stage: "in_conversation",
      askAmount: "2000.00",
    },
    {
      id: OPP_CLOSE,
      name: `BulkUpd opp close ${RUN}`,
      organizationId: ORG_ID,
      stage: "warm_lead",
      askAmount: "500.00",
    },
  ]);

  auth.current = { id: ADMIN_ID, role: "admin" };
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of [GIFT_1, GIFT_2, OPP_1, OPP_2, OPP_CLOSE]) {
    await db
      .delete(schema.bulkOperations)
      .where(arrayContainsFn(schema.bulkOperations.targetIds, [id]));
  }
  await db
    .delete(schema.giftAllocations)
    .where(inArrayFn(schema.giftAllocations.giftId, [GIFT_1, GIFT_2]));
  await db
    .delete(schema.giftsAndPayments)
    .where(inArrayFn(schema.giftsAndPayments.id, [GIFT_1, GIFT_2]));
  await db
    .delete(schema.pledgeAllocations)
    .where(
      inArrayFn(schema.pledgeAllocations.pledgeOrOpportunityId, [
        OPP_1,
        OPP_2,
        OPP_CLOSE,
      ]),
    );
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(
      inArrayFn(schema.opportunitiesAndPledges.id, [OPP_1, OPP_2, OPP_CLOSE]),
    );
  await db
    .delete(schema.fundableProjects)
    .where(eqFn(schema.fundableProjects.id, PROJ_ID));
  await db.delete(schema.fiscalYears).where(eqFn(schema.fiscalYears.id, FY_ID));
  await db
    .delete(schema.entities)
    .where(inArrayFn(schema.entities.id, [ENT_A, ENT_B]));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [ADMIN_ID, OWNER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("bulk-update field coverage", () => {
  it("gifts: all four scalar whitelist fields persist on every row", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await bulk("gifts-and-payments", {
      ids: [GIFT_1, GIFT_2],
      patch: {
        ownerUserId: OWNER_ID,
        loanOrGrant: "loan",
        paymentMethod: "wire",
        dateReceived: "2099-02-01",
      },
    });
    expect(status).toBe(200);
    expect(json.succeededIds?.sort()).toEqual([GIFT_1, GIFT_2].sort());

    const rows = await db
      .select()
      .from(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, [GIFT_1, GIFT_2]));
    for (const g of rows) {
      expect(g.ownerUserId).toBe(OWNER_ID);
      expect(g.loanOrGrant).toBe("loan");
      expect(g.paymentMethod).toBe("wire");
      expect(String(g.dateReceived)).toBe("2099-02-01");
    }
  });

  it("gifts: entityIds replace + grantYears append reconcile the allocation rows", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status } = await bulk("gifts-and-payments", {
      ids: [GIFT_1],
      patch: {
        entityIds: [ENT_B],
        entityIdsMode: "replace",
        grantYears: [FY_ID],
        grantYearsMode: "append",
      },
    });
    expect(status).toBe(200);

    const allocs = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, GIFT_1));
    // Replace wiped the ENT_A row; ENT_B row exists; FY append added a row.
    expect(allocs.some((a) => a.entityId === ENT_A)).toBe(false);
    expect(allocs.some((a) => a.entityId === ENT_B)).toBe(true);
    expect(allocs.some((a) => a.grantYear === FY_ID)).toBe(true);
  });

  it("gifts: intendedUsage='project' carries fundableProjectId onto every allocation; other usage clears it", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const r1 = await bulk("gifts-and-payments", {
      ids: [GIFT_1],
      patch: { intendedUsage: "project", fundableProjectId: PROJ_ID },
    });
    expect(r1.status).toBe(200);
    let allocs = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, GIFT_1));
    expect(allocs.length).toBeGreaterThan(0);
    for (const a of allocs) {
      expect(a.intendedUsage).toBe("project");
      expect(a.fundableProjectId).toBe(PROJ_ID);
    }

    // Non-project usage clears the project link (never a dangling pairing).
    const r2 = await bulk("gifts-and-payments", {
      ids: [GIFT_1],
      patch: { intendedUsage: "gen_ops", fundableProjectId: PROJ_ID },
    });
    expect(r2.status).toBe(200);
    allocs = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, GIFT_1));
    for (const a of allocs) {
      expect(a.intendedUsage).toBe("gen_ops");
      expect(a.fundableProjectId).toBeNull();
    }
  });

  it("opps: scalar whitelist persists and derived status recomputes (writtenPledge ⇒ 'pledge')", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await bulk("opportunities-and-pledges", {
      ids: [OPP_1, OPP_2],
      patch: {
        ownerUserId: OWNER_ID,
        type: "renewal",
        writtenPledge: true,
        projectedCloseDate: "2099-06-30",
        applicationDeadline: "2099-05-15",
      },
    });
    expect(status).toBe(200);
    expect(json.succeededIds?.sort()).toEqual([OPP_1, OPP_2].sort());

    const rows = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, [OPP_1, OPP_2]));
    for (const o of rows) {
      expect(o.ownerUserId).toBe(OWNER_ID);
      expect(o.type).toBe("renewal");
      expect(o.writtenPledge).toBe(true);
      expect(String(o.projectedCloseDate)).toBe("2099-06-30");
      expect(String(o.applicationDeadline)).toBe("2099-05-15");
      // afterApply re-derived the lifecycle: a written pledge is status='pledge'.
      expect(o.status).toBe("pledge");
    }
  });

  it("opps: NEWLY closing via lossType requires actualCompletionDate — per-row failure, then success with the date", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const fail = await bulk("opportunities-and-pledges", {
      ids: [OPP_CLOSE],
      patch: { lossType: "lost" },
    });
    expect(fail.status).toBe(200); // batch OK, row failed
    expect(fail.json.succeededIds).toEqual([]);
    expect(fail.json.failed?.[0]?.id).toBe(OPP_CLOSE);

    const [before] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, OPP_CLOSE));
    expect(before.lossType).toBeNull(); // untouched by the failed row

    const ok = await bulk("opportunities-and-pledges", {
      ids: [OPP_CLOSE],
      patch: { lossType: "lost", actualCompletionDate: "2099-03-01" },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.succeededIds).toEqual([OPP_CLOSE]);
    const [after] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, OPP_CLOSE));
    expect(after.lossType).toBe("lost");
    expect(after.status).toBe("lost"); // derived mirrors the loss
  });

  it("unknown ids fail per-row without aborting the batch", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await bulk("gifts-and-payments", {
      ids: [GIFT_2, `${RUN}_missing`],
      patch: { paymentMethod: "check" },
    });
    expect(status).toBe(200);
    expect(json.succeededIds).toEqual([GIFT_2]);
    expect(json.failed?.[0]?.id).toBe(`${RUN}_missing`);
  });
});
