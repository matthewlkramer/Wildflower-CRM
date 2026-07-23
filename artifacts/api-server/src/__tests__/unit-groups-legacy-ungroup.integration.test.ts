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
 * End-to-end coverage for the retired `unit_groups` endpoints
 * (docs/adr-linear-money-model.md §7 step 3).
 *
 * ALL group lifecycle endpoints are now 410 tombstones — creation
 * (`/staged-payments/group`), dismantling (`/staged-payments/ungroup`) and
 * single-member ejection (`/staged-payments/:id/eject-from-group`). Legacy
 * membership rows formed before the retirement remain in `unit_groups` +
 * `unit_group_members` as inert data until that store itself is retired
 * (step 4); NO endpoint reads or writes them any more. This suite seeds
 * legacy state directly in the DB — exactly what the retired /group endpoint
 * used to write — and proves:
 *   - POST /group   → 410 group_creation_retired, nothing written
 *   - POST /ungroup → 410 group_creation_retired, legacy membership untouched
 *   - POST /:id/eject-from-group → 410, legacy membership untouched
 *
 * Same seam as the multi-match suites: only `requireAuth` is mocked to inject
 * a seeded user; the real app boots and serves. All rows use a unique run
 * prefix and are cleaned up. Skips without a real DB.
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
    // admin — proves the tombstones answer 410 even to a fully-permitted
    // finance user (they are retired, not permission-gated).
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
  // unit_group_members cascade off unit_groups.
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
  "retired unit_groups endpoints: 410 tombstones, legacy rows inert (integration)",
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

    it("POST /ungroup answers 410 and leaves legacy membership untouched", async () => {
      const a = await seedStaged("50.00");
      const b = await seedStaged("50.00");
      const ugId = await seedLegacyGroup([a, b]);
      expect(await groupExists(ugId)).toBe(true);
      expect(await membersOf(ugId)).toEqual([a, b].sort());

      const res = await api("/api/staged-payments/ungroup", {
        stagedPaymentIds: [a],
      });
      expect(res.status).toBe(410);
      expect(res.json.error).toBe("group_creation_retired");

      // The tombstone dismantles nothing: group + full membership survive as
      // inert legacy data until the store itself is retired.
      expect(await groupExists(ugId)).toBe(true);
      expect(await membersOf(ugId)).toEqual([a, b].sort());
    }, 30_000);

    it("POST /:id/eject-from-group answers 410 and leaves legacy membership untouched", async () => {
      const a = await seedStaged("50.00");
      const b = await seedStaged("50.00");
      const c = await seedStaged("50.00");
      const ugId = await seedLegacyGroup([a, b, c]);

      const res = await api(`/api/staged-payments/${c}/eject-from-group`);
      expect(res.status).toBe(410);
      expect(res.json.error).toBe("group_creation_retired");

      expect(await groupExists(ugId)).toBe(true);
      expect(await membersOf(ugId)).toEqual([a, b, c].sort());
    }, 30_000);
  },
);
