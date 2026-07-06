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
 * End-to-end coverage for `unit_groups` as the SOLE grouping store (WS2 — Plane 2
 * cleanup, docs/reconciliation-design.md §4.6b, Decision 7). The legacy
 * `staged_payments.source_group_id` column has been retired (migration 0104); the
 * `/staged-payments/group` and `/staged-payments/ungroup` endpoints now write
 * membership entirely to a first-class `unit_groups` + `unit_group_members`
 * association, and the group's identity IS the `unit_groups.id` (returned as
 * `sourceGroupId`). This suite proves:
 *   - group 2 units        → the unit group exists with exactly those 2 quickbooks members
 *   - idempotent re-group  → no duplicate members, same group id
 *   - add a 3rd unit       → membership grows to 3 (delete-then-insert stays exact)
 *   - ungroup below 2      → group auto-dissolves: unit_groups row + all membership gone
 *   - ungroup one of three → group survives with the remaining 2 members
 *
 * Same seam as the group-reconcile suites: only `requireAuth` is mocked to inject
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
    req: { appUser?: { id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID };
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
async function seedStaged(
  amount: string,
  opts: { payerName?: string; dateReceived?: string } = {},
): Promise<string> {
  gen += 1;
  const id = `${RUN}_sp_${String(gen).padStart(3, "0")}`;
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    qbLineId: String(gen),
    amount,
    status: "pending",
    payerName: opts.payerName ?? "Group Test Donor",
    dateReceived: opts.dateReceived ?? "2025-01-01",
    organizationId: ORG_ID,
  });
  return id;
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
  // unit_group_members cascade off unit_groups; delete groups whose members are
  // our staged rows, then the staged rows, then org + user.
  const staged = await db
    .select({ id: schema.stagedPayments.id })
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.realmId, REALM_ID));
  const stagedIds = staged.map((s) => s.id);
  if (stagedIds.length) {
    const memberRows = await db
      .select({ groupId: schema.unitGroupMembers.groupId })
      .from(schema.unitGroupMembers)
      .where(inArrayFn(schema.unitGroupMembers.sourceId, stagedIds));
    const groupIds = Array.from(new Set(memberRows.map((m) => m.groupId)));
    if (groupIds.length) {
      await db
        .delete(schema.unitGroups)
        .where(inArrayFn(schema.unitGroups.id, groupIds));
    }
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
      "[unit-groups-dualwrite] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("unit_groups grouping store (integration)", () => {
  it("grouping two units creates a unit group with exactly those members", async () => {
    const a = await seedStaged("50.00");
    const b = await seedStaged("50.00");

    const res = await api("/api/staged-payments/group", {
      stagedPaymentIds: [a, b],
    });
    expect(res.status).toBe(200);
    const sgid = res.json.sourceGroupId as string;
    expect(sgid).toBeTruthy();

    const ugId = sgid;
    expect(await groupExists(ugId)).toBe(true);
    expect(await membersOf(ugId)).toEqual([a, b].sort());

    // The audit column captured the seeded user.
    const [ug] = await db
      .select({ createdByUserId: schema.unitGroups.createdByUserId })
      .from(schema.unitGroups)
      .where(eqFn(schema.unitGroups.id, ugId));
    expect(ug.createdByUserId).toBe(TEST_USER_ID);
  }, 30_000);

  it("re-grouping the same set is idempotent (no duplicate members)", async () => {
    const a = await seedStaged("50.00");
    const b = await seedStaged("50.00");

    const first = await api("/api/staged-payments/group", {
      stagedPaymentIds: [a, b],
    });
    const sgid = first.json.sourceGroupId as string;
    const ugId = sgid;

    const second = await api("/api/staged-payments/group", {
      stagedPaymentIds: [a, b],
    });
    expect(second.status).toBe(200);
    // Same members → same unit group id, still exactly two members.
    expect(second.json.sourceGroupId).toBe(sgid);
    expect(await membersOf(ugId)).toEqual([a, b].sort());
  }, 30_000);

  it("grouping three units at once mirrors all three members", async () => {
    const a = await seedStaged("50.00");
    const b = await seedStaged("50.00");
    const c = await seedStaged("50.00");

    const res = await api("/api/staged-payments/group", {
      stagedPaymentIds: [a, b, c],
    });
    expect(res.status).toBe(200);
    const ugId = res.json.sourceGroupId as string;
    expect(await membersOf(ugId)).toEqual([a, b, c].sort());
  }, 30_000);

  it("re-grouping a SUBSET recomputes full membership (beyond the passed ids)", async () => {
    const a = await seedStaged("50.00");
    const b = await seedStaged("50.00");
    const c = await seedStaged("50.00");

    const first = await api("/api/staged-payments/group", {
      stagedPaymentIds: [a, b, c],
    });
    const sgid = first.json.sourceGroupId as string;
    const ugId = sgid;
    expect(await membersOf(ugId)).toEqual([a, b, c].sort());

    // Pass only a subset of an existing group: the handler recomputes membership
    // from the existing unit_group_members, so it still reflects ALL three
    // members (never dropping the un-passed one).
    const again = await api("/api/staged-payments/group", {
      stagedPaymentIds: [a, b],
    });
    expect(again.status).toBe(200);
    expect(again.json.sourceGroupId).toBe(sgid);
    expect(await membersOf(ugId)).toEqual([a, b, c].sort());
  }, 30_000);

  it("ungrouping below two auto-dissolves: unit_groups row + all membership gone", async () => {
    const a = await seedStaged("50.00");
    const b = await seedStaged("50.00");

    const grouped = await api("/api/staged-payments/group", {
      stagedPaymentIds: [a, b],
    });
    const sgid = grouped.json.sourceGroupId as string;
    const ugId = sgid;
    expect(await groupExists(ugId)).toBe(true);

    // Ungroup one member; the lone remaining orphan is auto-cleared, the group
    // dissolves (< 2 members) and the unit_groups row + membership vanish.
    const res = await api("/api/staged-payments/ungroup", {
      stagedPaymentIds: [a],
    });
    expect(res.status).toBe(200);
    expect(res.json.dissolvedGroupIds).toContain(sgid);

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

    const grouped = await api("/api/staged-payments/group", {
      stagedPaymentIds: [a, b, c],
    });
    const sgid = grouped.json.sourceGroupId as string;
    const ugId = sgid;
    expect(await membersOf(ugId)).toEqual([a, b, c].sort());

    const res = await api("/api/staged-payments/ungroup", {
      stagedPaymentIds: [c],
    });
    expect(res.status).toBe(200);
    expect(res.json.dissolvedGroupIds).not.toContain(sgid);

    // Group survives (>= 2), membership drops c only.
    expect(await groupExists(ugId)).toBe(true);
    expect(await membersOf(ugId)).toEqual([a, b].sort());
  }, 30_000);
});
