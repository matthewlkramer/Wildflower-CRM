import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Bulk-assign fundable project — gifts and pledges.
 *
 * POST /api/gifts-and-payments/bulk-update and
 * POST /api/opportunities-and-pledges/bulk-update accept the virtual patch
 * fields { intendedUsage, fundableProjectId } which reconcile the ALLOCATION
 * rows (never columns on the header — header-plus-allocations invariant):
 *   - intendedUsage is applied to EVERY existing allocation row;
 *   - a record with NO allocation rows gets exactly one new row carrying it;
 *   - fundableProjectId is written only when intendedUsage === "project",
 *     and is CLEARED (nulled) for any other usage so stale links don't linger.
 *
 * Only the Clerk auth gate is mocked. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `bulkfpspec_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const ORG_ID = `${RUN}_org`;
const FP_ID = `${RUN}_fp`;
const GIFT_WITH_ALLOC = `${RUN}_gift_a`;
const GIFT_NO_ALLOC = `${RUN}_gift_b`;
const GIFT_ALLOC_ID = `${RUN}_galloc`;
const OPP_WITH_ALLOC = `${RUN}_opp_a`;
const OPP_NO_ALLOC = `${RUN}_opp_b`;
const OPP_ALLOC_ID = `${RUN}_palloc`;

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
  fundableProjects: Db["fundableProjects"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
  bulkOperations: Db["bulkOperations"];
  auditLog: Db["auditLog"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function bulkUpdate(
  path: "gifts-and-payments" | "opportunities-and-pledges",
  body: unknown,
): Promise<{ status: number; json: { succeededIds?: string[]; failed?: unknown[] } }> {
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
    fundableProjects: dbMod.fundableProjects,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
    bulkOperations: dbMod.bulkOperations,
    auditLog: dbMod.auditLog,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "team_member",
  });
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `Bulk FP Org ${RUN}` });
  await db
    .insert(schema.fundableProjects)
    .values({ id: FP_ID, name: `Bulk FP Project ${RUN}` });

  await db.insert(schema.giftsAndPayments).values([
    { id: GIFT_WITH_ALLOC, name: `Gift A ${RUN}`, organizationId: ORG_ID },
    { id: GIFT_NO_ALLOC, name: `Gift B ${RUN}`, organizationId: ORG_ID },
  ]);
  await db
    .insert(schema.giftAllocations)
    .values({ id: GIFT_ALLOC_ID, giftId: GIFT_WITH_ALLOC });

  await db.insert(schema.opportunitiesAndPledges).values([
    { id: OPP_WITH_ALLOC, name: `Opp A ${RUN}`, organizationId: ORG_ID },
    { id: OPP_NO_ALLOC, name: `Opp B ${RUN}`, organizationId: ORG_ID },
  ]);
  await db
    .insert(schema.pledgeAllocations)
    .values({ id: OPP_ALLOC_ID, pledgeOrOpportunityId: OPP_WITH_ALLOC });

  auth.current = { id: USER_ID, role: "team_member" };
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
  await db
    .delete(schema.giftAllocations)
    .where(inArrayFn(schema.giftAllocations.giftId, [GIFT_WITH_ALLOC, GIFT_NO_ALLOC]));
  await db
    .delete(schema.pledgeAllocations)
    .where(
      inArrayFn(schema.pledgeAllocations.pledgeOrOpportunityId, [
        OPP_WITH_ALLOC,
        OPP_NO_ALLOC,
      ]),
    );
  await db
    .delete(schema.giftsAndPayments)
    .where(inArrayFn(schema.giftsAndPayments.id, [GIFT_WITH_ALLOC, GIFT_NO_ALLOC]));
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(inArrayFn(schema.opportunitiesAndPledges.id, [OPP_WITH_ALLOC, OPP_NO_ALLOC]));
  await db
    .delete(schema.bulkOperations)
    .where(eqFn(schema.bulkOperations.actorUserId, USER_ID));
  await db
    .delete(schema.auditLog)
    .where(eqFn(schema.auditLog.actorUserId, USER_ID));
  await db
    .delete(schema.fundableProjects)
    .where(eqFn(schema.fundableProjects.id, FP_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("bulk-assign fundable project", () => {
  it("gifts: sets intendedUsage=project + fundableProjectId on existing allocations and seeds one when none exist", async () => {
    const { status, json } = await bulkUpdate("gifts-and-payments", {
      ids: [GIFT_WITH_ALLOC, GIFT_NO_ALLOC],
      patch: { intendedUsage: "project", fundableProjectId: FP_ID },
    });
    expect(status).toBe(200);
    expect(json.succeededIds?.sort()).toEqual(
      [GIFT_WITH_ALLOC, GIFT_NO_ALLOC].sort(),
    );

    const allocsA = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, GIFT_WITH_ALLOC));
    expect(allocsA).toHaveLength(1);
    expect(allocsA[0].intendedUsage).toBe("project");
    expect(allocsA[0].fundableProjectId).toBe(FP_ID);

    const allocsB = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, GIFT_NO_ALLOC));
    expect(allocsB).toHaveLength(1);
    expect(allocsB[0].intendedUsage).toBe("project");
    expect(allocsB[0].fundableProjectId).toBe(FP_ID);
  }, 30_000);

  it("gifts: switching intendedUsage away from project CLEARS the fundable-project link", async () => {
    const { status } = await bulkUpdate("gifts-and-payments", {
      ids: [GIFT_WITH_ALLOC],
      patch: { intendedUsage: "gen_ops" },
    });
    expect(status).toBe(200);
    const allocs = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, GIFT_WITH_ALLOC));
    expect(allocs).toHaveLength(1);
    expect(allocs[0].intendedUsage).toBe("gen_ops");
    expect(allocs[0].fundableProjectId).toBeNull();
  }, 30_000);

  it("pledges: sets intendedUsage=project + fundableProjectId on existing allocations and seeds one when none exist", async () => {
    const { status, json } = await bulkUpdate("opportunities-and-pledges", {
      ids: [OPP_WITH_ALLOC, OPP_NO_ALLOC],
      patch: { intendedUsage: "project", fundableProjectId: FP_ID },
    });
    expect(status).toBe(200);
    expect(json.succeededIds?.sort()).toEqual(
      [OPP_WITH_ALLOC, OPP_NO_ALLOC].sort(),
    );

    const allocsA = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, OPP_WITH_ALLOC));
    expect(allocsA).toHaveLength(1);
    expect(allocsA[0].intendedUsage).toBe("project");
    expect(allocsA[0].fundableProjectId).toBe(FP_ID);

    const allocsB = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, OPP_NO_ALLOC));
    expect(allocsB).toHaveLength(1);
    expect(allocsB[0].intendedUsage).toBe("project");
    expect(allocsB[0].fundableProjectId).toBe(FP_ID);
  }, 30_000);

  it("pledges: switching intendedUsage away from project CLEARS the fundable-project link", async () => {
    const { status } = await bulkUpdate("opportunities-and-pledges", {
      ids: [OPP_WITH_ALLOC],
      patch: { intendedUsage: "gen_ops" },
    });
    expect(status).toBe(200);
    const allocs = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, OPP_WITH_ALLOC));
    expect(allocs).toHaveLength(1);
    expect(allocs[0].intendedUsage).toBe("gen_ops");
    expect(allocs[0].fundableProjectId).toBeNull();
  }, 30_000);
});
