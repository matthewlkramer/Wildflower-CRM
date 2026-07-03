import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Unit coverage for the `unitGroupMembership` read helpers (WS1 mechanism
 * collapse, docs/reconciliation-design.md §4.6b, Decision 7) — the single place
 * every group READ/GUARD is flipped off `staged_payments.source_group_id` onto
 * the durable `unit_group_members` table.
 *
 * The helpers read ONLY `unit_group_members` by `(evidence_source, source_id)`
 * (source_id has no FK), so these tests seed that table + `unit_groups` directly
 * and exercise the functions inside a transaction — no app boot required.
 *
 * Proven:
 *   - isGroupMember true for a grouped unit, false for an ungrouped id
 *   - groupMemberIdsFor returns the full sorted member set (including self)
 *   - groupMemberIdsFor returns [] for an ungrouped id
 *   - evidence-source scoping: a same-string source_id under a DIFFERENT source
 *     never leaks into quickbooks reads, and mixed-source groups return only the
 *     same-source members
 *   - singleton group: isGroupMember true, groupMemberIdsFor returns [self]
 *     (documents the guard-level singleton decision surfaced by the parity gate)
 *   - the isQbGroupMemberSql fragment matches the TS helper
 *
 * Skips without a real DB.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `ugm_${Date.now()}`;

type Db = typeof import("@workspace/db");
type Helper = typeof import("../lib/unitGroupMembership");

let db: Db["db"];
let unitGroups: Db["unitGroups"];
let unitGroupMembers: Db["unitGroupMembers"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let sqlFn: (typeof import("drizzle-orm"))["sql"];
let helper: Helper;

/** Seed a group with the given members `[evidenceSource, sourceId][]`. */
async function seedGroup(
  groupId: string,
  members: [string, string][],
): Promise<void> {
  await db.insert(unitGroups).values({ id: groupId });
  await db.insert(unitGroupMembers).values(
    members.map(([evidenceSource, sourceId]) => ({
      id: `ugm_${groupId}_${evidenceSource}_${sourceId}`,
      groupId,
      evidenceSource: evidenceSource as "quickbooks" | "stripe" | "donorbox",
      sourceId,
    })),
  );
}

const GROUP_A = `ug_${RUN}_a`; // quickbooks sp1, sp2, sp3
const GROUP_MIXED = `ug_${RUN}_mixed`; // quickbooks m1,m2 + stripe m1
const GROUP_SINGLE = `ug_${RUN}_single`; // quickbooks lonely

const SP1 = `${RUN}_sp1`;
const SP2 = `${RUN}_sp2`;
const SP3 = `${RUN}_sp3`;
const M1 = `${RUN}_m1`;
const M2 = `${RUN}_m2`;
const LONELY = `${RUN}_lonely`;
const UNGROUPED = `${RUN}_ungrouped`;

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  unitGroups = dbMod.unitGroups;
  unitGroupMembers = dbMod.unitGroupMembers;
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  sqlFn = drizzle.sql;
  helper = await import("../lib/unitGroupMembership");

  await seedGroup(GROUP_A, [
    ["quickbooks", SP1],
    ["quickbooks", SP2],
    ["quickbooks", SP3],
  ]);
  // A same-string source_id (M1) exists under BOTH quickbooks and stripe: the
  // exclusivity index is per (evidence_source, source_id), so this is legal and
  // must NOT cross the source scoping in the helpers.
  await seedGroup(GROUP_MIXED, [
    ["quickbooks", M1],
    ["quickbooks", M2],
    ["stripe", M1],
  ]);
  await seedGroup(GROUP_SINGLE, [["quickbooks", LONELY]]);
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  // members cascade off groups.
  await db
    .delete(unitGroups)
    .where(inArrayFn(unitGroups.id, [GROUP_A, GROUP_MIXED, GROUP_SINGLE]));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[unit-group-membership] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("unitGroupMembership helpers (integration)", () => {
  it("isGroupMember is true for a grouped unit, false for an ungrouped id", async () => {
    const [grouped, ungrouped] = await db.transaction(async (tx) => [
      await helper.isGroupMember(tx, SP1),
      await helper.isGroupMember(tx, UNGROUPED),
    ]);
    expect(grouped).toBe(true);
    expect(ungrouped).toBe(false);
  }, 30_000);

  it("groupMemberIdsFor returns the full sorted member set including self", async () => {
    const members = await db.transaction((tx) =>
      helper.groupMemberIdsFor(tx, SP2),
    );
    expect(members).toEqual([SP1, SP2, SP3].sort());
  }, 30_000);

  it("groupMemberIdsFor returns [] for an ungrouped id", async () => {
    const members = await db.transaction((tx) =>
      helper.groupMemberIdsFor(tx, UNGROUPED),
    );
    expect(members).toEqual([]);
  }, 30_000);

  it("scopes to quickbooks: a same-string stripe source_id never leaks in", async () => {
    const qbMembers = await db.transaction((tx) =>
      helper.groupMemberIdsFor(tx, M1),
    );
    // Only the two quickbooks members of the mixed group — the stripe M1 row is
    // a different anchor and must not appear.
    expect(qbMembers).toEqual([M1, M2].sort());

    const stripeMembers = await db.transaction((tx) =>
      helper.groupMemberIdsFor(tx, M1, "stripe"),
    );
    expect(stripeMembers).toEqual([M1]);
  }, 30_000);

  it("singleton group: member is true, expansion returns [self]", async () => {
    const [member, ids] = await db.transaction(async (tx) => [
      await helper.isGroupMember(tx, LONELY),
      await helper.groupMemberIdsFor(tx, LONELY),
    ]);
    expect(member).toBe(true);
    expect(ids).toEqual([LONELY]);
  }, 30_000);

  it("isQbGroupMemberSql fragment agrees with the TS helper", async () => {
    const check = async (id: string): Promise<boolean> => {
      const rows = (
        await db.execute(
          sqlFn`SELECT ${helper.isQbGroupMemberSql(sqlFn`${id}`)} AS member`,
        )
      ).rows as unknown as { member: boolean }[];
      return rows[0].member;
    };
    expect(await check(SP1)).toBe(true);
    expect(await check(LONELY)).toBe(true);
    expect(await check(UNGROUPED)).toBe(false);
    // stripe-only anchor is not a quickbooks member.
    expect(await check(`${RUN}_definitely_absent`)).toBe(false);
  }, 30_000);
});
