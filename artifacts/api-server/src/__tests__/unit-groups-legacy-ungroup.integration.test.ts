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

/**
 * End-to-end coverage for the LEGACY `unit_groups` lifecycle after group
 * creation was retired (docs/adr-linear-money-model.md).
 *
 * `/staged-payments/group` is a 410 tombstone — no new groups can be formed.
 * Groups formed BEFORE the retirement live on in `unit_groups` +
 * `unit_group_members` until that store itself is retired, and
 * `/staged-payments/ungroup` (finance-gated) remains the way to dismantle
 * them. Legacy state is seeded directly in the DB — exactly what the retired
 * /group endpoint used to write. This suite proves:
 *   - POST /group          → 410 group_creation_retired, nothing written
 *   - ungroup below 2      → group auto-dissolves: unit_groups row + all membership gone
 *   - ungroup one of three → group survives with the remaining 2 members
 *   - ungroup an ungrouped row → 200 no-op (nothing ungrouped, nothing dissolved)
 *
 * Same seam as the multi-match suites: only `requireAuth` is mocked to inject
 * a seeded user; the transaction, locking and the real code run. All rows use a
 * unique run prefix and are cleaned up. Skips without a real DB.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `ug_test_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    // admin passes the requireFinance gate on /ungroup.
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));

const RUN = `ug_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  stagedPayments: Db["stagedPayments"];
  unitGroups: Db["unitGroups"];
  unitGroupMembers: Db["unitGroupMembers"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function api(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

let gen = 0;
async function seedStaged(amount: string): Promise<string> {
  gen += 1;
  const id = `${RUN}_sp_${String(gen).padStart(3, "0")}`;
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    qbLineId: String(gen),
    amount,
    payerName: "Group Test Donor",
    dateReceived: "2025-01-01",
    organizationId: ORG_ID,
  });
  return id;
}

/**
 * Seed a LEGACY unit group directly (what the retired /group endpoint used to
 * write): one unit_groups row + one quickbooks member row per staged id.
 */
let groupGen = 0;
const seededGroupIds: string[] = [];
async function seedLegacyGroup(memberIds: string[]): Promise<string> {
  groupGen += 1;
  const gid = `${RUN}_ug_${String(groupGen).padStart(3, "0")}`;
  await db.insert(schema.unitGroups).values({
    id: gid,
    createdByUserId: TEST_USER_ID,
  });
  await db.insert(schema.unitGroupMembers).values(
    memberIds.map((sourceId) => ({
      id: `ugm_${sourceId}`,
      groupId: gid,
      evidenceSource: "quickbooks" as const,
      sourceId,
    })),
  );
  seededGroupIds.push(gid);
  return gid;
}

async function membersOf(unitGroupId: string): Promise<string[]> {
  const rows = await db
    .select({ sourceId: schema.unitGroupMembers.sourceId })
    .from(schema.unitGroupMembers)
    .where(eqFn(schema.unitGroupMembers.groupId, unitGroupId));
  return rows.map((r) => r.sourceId).sort();
}

async function groupExists(unitGroupId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.unitGroups.id })
    .from(schema.unitGroups)
    .where(eqFn(schema.unitGroups.id, unitGroupId));
  return rows.length > 0;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    stagedPayments: dbMod.stagedPayments,
    unitGroups: dbMod.unitGroups,
    unitGroupMembers: dbMod.unitGroupMembers,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Unit Group Test Org ${RUN}`,
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
  // unit_group_members cascade off unit_groups; ungroup may already have
  // dissolved some seeded groups — deleting those ids is a no-op.
  if (seededGroupIds.length) {
    await db
      .delete(schema.unitGroups)
      .where(inArrayFn(schema.unitGroups.id, seededGroupIds));
  }
  await db
    .delete(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.realmId, REALM_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[unit-groups-legacy-ungroup] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)(
  "legacy unit_groups: retired creation + live ungroup (integration)",
  () => {
    it("POST /group answers 410 group_creation_retired and writes nothing", async () => {
      const a = await seedStaged("50.00");
      const b = await seedStaged("50.00");

      const res = await api("/api/staged-payments/group", {
        stagedPaymentIds: [a, b],
      });
      expect(res.status).toBe(410);
      expect(res.json.error).toBe("group_creation_retired");

      // No membership rows appeared for either staged row.
      const memberRows = await db
        .select({ sourceId: schema.unitGroupMembers.sourceId })
        .from(schema.unitGroupMembers)
        .where(inArrayFn(schema.unitGroupMembers.sourceId, [a, b]));
      expect(memberRows).toEqual([]);
    }, 30_000);

    it("ungrouping below two auto-dissolves: unit_groups row + all membership gone", async () => {
      const a = await seedStaged("50.00");
      const b = await seedStaged("50.00");
      const ugId = await seedLegacyGroup([a, b]);
      expect(await groupExists(ugId)).toBe(true);
      expect(await membersOf(ugId)).toEqual([a, b].sort());

      // Ungroup one member; the lone remaining orphan is auto-cleared, the
      // group dissolves (< 2 members) and the unit_groups row + membership
      // vanish.
      const res = await api("/api/staged-payments/ungroup", {
        stagedPaymentIds: [a],
      });
      expect(res.status).toBe(200);
      expect(res.json.ungroupedIds).toContain(a);
      expect(res.json.dissolvedGroupIds).toContain(ugId);

      expect(await groupExists(ugId)).toBe(false);
      expect(await membersOf(ugId)).toEqual([]);
      // Neither staged row belongs to any unit group anymore.
      const memberRows = await db
        .select({ sourceId: schema.unitGroupMembers.sourceId })
        .from(schema.unitGroupMembers)
        .where(inArrayFn(schema.unitGroupMembers.sourceId, [a, b]));
      expect(memberRows).toEqual([]);
    }, 30_000);

    it("ungrouping one of three keeps the group with the remaining two members", async () => {
      const a = await seedStaged("50.00");
      const b = await seedStaged("50.00");
      const c = await seedStaged("50.00");
      const ugId = await seedLegacyGroup([a, b, c]);
      expect(await membersOf(ugId)).toEqual([a, b, c].sort());

      const res = await api("/api/staged-payments/ungroup", {
        stagedPaymentIds: [c],
      });
      expect(res.status).toBe(200);
      expect(res.json.dissolvedGroupIds).not.toContain(ugId);

      // Group survives (>= 2), membership drops c only.
      expect(await groupExists(ugId)).toBe(true);
      expect(await membersOf(ugId)).toEqual([a, b].sort());
    }, 30_000);

    it("ungrouping a row with no membership is a 200 no-op", async () => {
      const lone = await seedStaged("50.00");

      const res = await api("/api/staged-payments/ungroup", {
        stagedPaymentIds: [lone],
      });
      expect(res.status).toBe(200);
      expect(res.json.ungroupedIds).toEqual([]);
      expect(res.json.dissolvedGroupIds).toEqual([]);
    }, 30_000);
  },
);
