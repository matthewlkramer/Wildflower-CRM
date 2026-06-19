import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for server-side anonymous-name masking on the
 * opportunities donor join (routes/opportunitiesAndPledges.ts ->
 * maskOppDonorRow). Seeds an anonymous organization owned by one team member
 * and an opportunity for it, then exercises both the list and detail endpoints
 * as three different viewers:
 *   - the record owner  -> sees the real org name
 *   - an admin          -> sees the real org name
 *   - another viewer    -> sees "Anonymous"
 * Also asserts the anonymous/owner helper alias columns never leak into the
 * JSON response.
 *
 * Like the gift-merge suite, the only seam mocked is the Clerk auth gate
 * (`requireAuth`); here it injects a *mutable* app user so each test can switch
 * viewers. All seeded rows use a unique run prefix and are cleaned up. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `anonmask_${Date.now()}`;
const OWNER_ID = `${RUN}_owner`;
const OTHER_ID = `${RUN}_other`;
const ADMIN_ID = `${RUN}_admin`;
const ORG_ID = `${RUN}_org`;
const OPP_ID = `${RUN}_opp`;
const REAL_ORG_NAME = `Secret Foundation ${RUN}`;

// Mutable injected viewer so individual tests can change who is "logged in".
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
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values([
    {
      id: OWNER_ID,
      clerkId: `clerk_${OWNER_ID}`,
      email: `${OWNER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
    {
      id: OTHER_ID,
      clerkId: `clerk_${OTHER_ID}`,
      email: `${OTHER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
  ]);
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: REAL_ORG_NAME,
    anonymous: true,
    ownerUserId: OWNER_ID,
  });
  await db.insert(schema.opportunitiesAndPledges).values({
    id: OPP_ID,
    name: `Opp ${RUN}`,
    organizationId: ORG_ID,
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
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, OPP_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [OWNER_ID, OTHER_ID, ADMIN_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("anonymous donor masking on opportunities", () => {
  function assertNoHelperLeak(row: Record<string, unknown>) {
    expect(row).not.toHaveProperty("organizationAnonymous");
    expect(row).not.toHaveProperty("organizationOwnerUserId");
    expect(row).not.toHaveProperty("individualGiverAnonymous");
    expect(row).not.toHaveProperty("individualGiverOwnerUserId");
    expect(row).not.toHaveProperty("primaryContactAnonymous");
    expect(row).not.toHaveProperty("primaryContactOwnerUserId");
  }

  async function listRow() {
    const { status, json } = await getJson(
      `/api/opportunities-and-pledges?organizationId=${ORG_ID}`,
    );
    expect(status).toBe(200);
    const row = (json.data as Array<Record<string, unknown>>).find(
      (r) => r.id === OPP_ID,
    );
    expect(row, "seeded opportunity present in list").toBeDefined();
    return row!;
  }

  it("reveals the real org name to the owner (list + detail)", async () => {
    auth.current = { id: OWNER_ID, role: "team_member" };

    const row = await listRow();
    expect(row.organizationName).toBe(REAL_ORG_NAME);
    assertNoHelperLeak(row);

    const detail = await getJson(`/api/opportunities-and-pledges/${OPP_ID}`);
    expect(detail.status).toBe(200);
    expect(detail.json.organizationName).toBe(REAL_ORG_NAME);
    assertNoHelperLeak(detail.json);
  }, 30_000);

  it("reveals the real org name to an admin", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };

    const row = await listRow();
    expect(row.organizationName).toBe(REAL_ORG_NAME);
    assertNoHelperLeak(row);

    const detail = await getJson(`/api/opportunities-and-pledges/${OPP_ID}`);
    expect(detail.status).toBe(200);
    expect(detail.json.organizationName).toBe(REAL_ORG_NAME);
  }, 30_000);

  it("masks the org name to a non-owner non-admin (list + detail)", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };

    const row = await listRow();
    expect(row.organizationName).toBe("Anonymous");
    assertNoHelperLeak(row);

    const detail = await getJson(`/api/opportunities-and-pledges/${OPP_ID}`);
    expect(detail.status).toBe(200);
    expect(detail.json.organizationName).toBe("Anonymous");
    assertNoHelperLeak(detail.json);
  }, 30_000);
});
