import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Coverage for the admin-only restriction-text review list
 * (routes/restrictionTextReview.ts):
 *   - GET /restriction-text-review[?source=gift|pledge]
 *
 * Seeds one gift allocation and one pledge allocation with purpose_verbatim
 * text, plus one gift allocation without (should never appear). Asserts:
 *   - non-admins get 403
 *   - both seeded rows appear with parent name + donor name context
 *   - the source filter narrows to gift-only / pledge-only
 *   - clearing purpose_verbatim via the existing PATCH endpoint drops the
 *     allocation off the review list (the end-to-end cleanup flow)
 *
 * Only the Clerk auth gate (`requireAuth`) is mocked, injecting a mutable app
 * user so tests can switch roles. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `rtreviewspec_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const MEMBER_ID = `${RUN}_member`;
const ORG_ID = `${RUN}_org`;
const GIFT_ID = `${RUN}_gift`;
const OPP_ID = `${RUN}_opp`;
const GIFT_ALLOC_ID = `${RUN}_galloc`;
const GIFT_ALLOC_CLEAN_ID = `${RUN}_galloc_clean`;
const PLEDGE_ALLOC_ID = `${RUN}_palloc`;

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
  giftsAndPayments: Db["giftsAndPayments"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  giftAllocations: Db["giftAllocations"];
  pledgeAllocations: Db["pledgeAllocations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

type ReviewRow = {
  allocationId: string;
  source: "gift" | "pledge";
  parentId: string;
  parentName: string | null;
  donorName: string | null;
  purposeVerbatim: string;
  restrictionDescription: string | null;
};

async function listReview(
  query = "",
): Promise<{ status: number; rows: ReviewRow[]; total: number }> {
  const res = await fetch(
    `${baseUrl}/api/restriction-text-review${query ? `?${query}` : ""}`,
  );
  let json: { data?: ReviewRow[]; pagination?: { total: number } } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    json = {};
  }
  return {
    status: res.status,
    rows: json.data ?? [],
    total: json.pagination?.total ?? 0,
  };
}

/** Rows seeded by THIS run only, so parallel data in the DB never interferes. */
function mine(rows: ReviewRow[]): ReviewRow[] {
  return rows.filter((r) => r.allocationId.startsWith(RUN));
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
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    giftAllocations: dbMod.giftAllocations,
    pledgeAllocations: dbMod.pledgeAllocations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
    {
      id: MEMBER_ID,
      clerkId: `clerk_${MEMBER_ID}`,
      email: `${MEMBER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);

  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `Review Donor Org ${RUN}` });

  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    name: `Review Gift ${RUN}`,
    organizationId: ORG_ID,
  });

  await db.insert(schema.opportunitiesAndPledges).values({
    id: OPP_ID,
    name: `Review Pledge ${RUN}`,
    organizationId: ORG_ID,
  });

  await db.insert(schema.giftAllocations).values([
    {
      id: GIFT_ALLOC_ID,
      giftId: GIFT_ID,
      purposeVerbatim: `"for teacher training only" ${RUN}`,
    },
    {
      id: GIFT_ALLOC_CLEAN_ID,
      giftId: GIFT_ID,
      restrictionDescription: "already sorted",
    },
  ]);

  await db.insert(schema.pledgeAllocations).values({
    id: PLEDGE_ALLOC_ID,
    pledgeOrOpportunityId: OPP_ID,
    purposeVerbatim: `grants to schools in MN ${RUN}`,
  });

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
    .delete(schema.pledgeAllocations)
    .where(eqFn(schema.pledgeAllocations.id, PLEDGE_ALLOC_ID));
  await db
    .delete(schema.giftAllocations)
    .where(
      inArrayFn(schema.giftAllocations.id, [GIFT_ALLOC_ID, GIFT_ALLOC_CLEAN_ID]),
    );
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, OPP_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [ADMIN_ID, MEMBER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("restriction text review", () => {
  it("rejects a non-admin with 403", async () => {
    auth.current = { id: MEMBER_ID, role: "team_member" };
    const { status } = await listReview();
    expect(status).toBe(403);
  }, 30_000);

  it("lists both seeded allocations with parent and donor context", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, rows } = await listReview("limit=10000");
    expect(status).toBe(200);
    const ours = mine(rows);
    expect(ours).toHaveLength(2);

    const gift = ours.find((r) => r.source === "gift");
    expect(gift).toMatchObject({
      allocationId: GIFT_ALLOC_ID,
      parentId: GIFT_ID,
      parentName: `Review Gift ${RUN}`,
      donorName: `Review Donor Org ${RUN}`,
    });
    expect(gift?.purposeVerbatim).toContain("teacher training");

    const pledge = ours.find((r) => r.source === "pledge");
    expect(pledge).toMatchObject({
      allocationId: PLEDGE_ALLOC_ID,
      parentId: OPP_ID,
      parentName: `Review Pledge ${RUN}`,
      donorName: `Review Donor Org ${RUN}`,
    });

    // The allocation whose verbatim was already sorted never appears.
    expect(ours.some((r) => r.allocationId === GIFT_ALLOC_CLEAN_ID)).toBe(false);
  }, 30_000);

  it("narrows by source", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const gifts = await listReview("source=gift&limit=10000");
    expect(mine(gifts.rows).map((r) => r.allocationId)).toEqual([GIFT_ALLOC_ID]);
    const pledges = await listReview("source=pledge&limit=10000");
    expect(mine(pledges.rows).map((r) => r.allocationId)).toEqual([
      PLEDGE_ALLOC_ID,
    ]);
  }, 30_000);

  it("drops an allocation off the list once its verbatim is cleared via the existing PATCH", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const res = await fetch(
      `${baseUrl}/api/gift-allocations/${GIFT_ALLOC_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purposeVerbatim: null,
          restrictionDescription: "Teacher training only",
        }),
      },
    );
    expect(res.status).toBe(200);

    const { rows } = await listReview("limit=10000");
    const ours = mine(rows);
    expect(ours.map((r) => r.allocationId)).toEqual([PLEDGE_ALLOC_ID]);
  }, 30_000);
});
