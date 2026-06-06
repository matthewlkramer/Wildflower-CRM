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
 * End-to-end coverage for the QuickBooks deposit-grouping operator path.
 *
 * Unlike the rest of this suite (pure functions / compiled SQL with no live
 * database), this exercises the real route handlers against the dev Postgres so
 * it can assert the actual DB state transitions the SQL preserve-on-conflict
 * unit tests can't see: grouping 2+ staged rows that share one bank deposit,
 * reconciling the group to ONE existing gift inside the fee band, the
 * representative/member column split (matchedGiftId vs groupReconciledGiftId),
 * fee-band rejection, and the group-aware revert that reverts the WHOLE group.
 *
 * The only seam we mock is the Clerk auth gate (`requireAuth`) — we inject a
 * seeded test user so the handlers run with a real `appUser`; everything else
 * (transactions, locking, tolerance math, partial-unique index) is the genuine
 * production code. All seeded rows use a unique run prefix and are cleaned up.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `qb_grp_test_user_${Date.now()}`,
}));

// Replace the Clerk-backed auth gate with one that injects our seeded user.
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

const RUN = `qbgrp_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;
const DEPOSIT_ID = `${RUN}_dep`;

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

// A monotonically increasing suffix so each test gets fresh, uniquely-ordered
// staged-row ids (the route picks the lexicographically smallest id as the
// "representative", so deterministic ordering lets us assert which row it is).
let gen = 0;
function nextGiftId(): string {
  gen += 1;
  return `${RUN}_gift_${String(gen).padStart(3, "0")}`;
}
function stagedId(giftId: string, label: string): string {
  return `${giftId}_sp_${label}`;
}

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

async function seedGift(amount: string): Promise<string> {
  const id = nextGiftId();
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
  });
  return id;
}

/** Seed a pending staged row sharing the run's single deposit. */
async function seedStaged(
  giftId: string,
  label: string,
  amount: string,
): Promise<string> {
  const id = stagedId(giftId, label);
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    qbLineId: label,
    amount,
    qbDepositId: DEPOSIT_ID,
    status: "pending",
    organizationId: ORG_ID,
  });
  return id;
}

async function readStaged(id: string) {
  const [row] = await db
    .select()
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, id));
  return row;
}

const seededGiftIds: string[] = [];

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
    stagedPayments: dbMod.stagedPayments,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  // Seed the user the mocked auth gate injects (FK target for
  // matchConfirmedByUserId / approvedByUserId) and the donor org.
  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `QB Group Test Org ${RUN}`,
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
  // Children first (staged rows reference gift/org/user), then gift, org, user.
  await db
    .delete(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.realmId, REALM_ID));
  if (seededGiftIds.length) {
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, seededGiftIds));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    // Surface the reason in the runner instead of silently passing.
    console.warn(
      "[quickbooks-group-reconcile] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)(
  "QuickBooks deposit group-reconcile + group-aware revert (integration)",
  () => {
    it("groups members sharing a deposit and reconciles them to one in-band gift", async () => {
      // Gift 100.00; two deposit members 50 + 50 = 100 → inside the fee band.
      const giftId = await seedGift("100.00");
      seededGiftIds.push(giftId);
      const repId = await seedStaged(giftId, "a", "50.00");
      const memberId = await seedStaged(giftId, "b", "50.00");

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        // Pass out of order to prove the route picks the smallest id as rep.
        stagedPaymentIds: [memberId, repId],
      });

      expect(res.status).toBe(200);
      expect(res.json.representativeStagedPaymentId).toBe(repId);

      const rep = await readStaged(repId);
      const member = await readStaged(memberId);

      // Representative carries matchedGiftId (gift shows linked) AND the group id.
      expect(rep.matchedGiftId).toBe(giftId);
      expect(rep.groupReconciledGiftId).toBe(giftId);
      expect(rep.status).toBe("approved");
      // The donor was adopted from the gift.
      expect(rep.organizationId).toBe(ORG_ID);

      // Every member carries the group id but NOT matchedGiftId.
      expect(member.groupReconciledGiftId).toBe(giftId);
      expect(member.matchedGiftId).toBeNull();
      expect(member.status).toBe("approved");
    }, 30_000);

    it("rejects an out-of-tolerance combined total without touching the rows", async () => {
      // Gift 200.00 vs combined 100.00 → 200 > 100*1.1+1 = 111 → over band.
      const giftId = await seedGift("200.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "50.00");
      const bId = await seedStaged(giftId, "b", "50.00");

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("amount_mismatch");
      expect(res.json.details).toMatchObject({
        combinedTotal: 100,
        giftAmount: 200,
      });

      // Rows untouched — still pending, no gift links.
      const a = await readStaged(aId);
      const b = await readStaged(bId);
      for (const row of [a, b]) {
        expect(row.status).toBe("pending");
        expect(row.matchedGiftId).toBeNull();
        expect(row.groupReconciledGiftId).toBeNull();
      }
    }, 30_000);

    it("group-aware revert clears the whole group back to pending", async () => {
      const giftId = await seedGift("90.00");
      seededGiftIds.push(giftId);
      const repId = await seedStaged(giftId, "a", "30.00");
      const m1Id = await seedStaged(giftId, "b", "30.00");
      const m2Id = await seedStaged(giftId, "c", "30.00");

      const grouped = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [repId, m1Id, m2Id],
      });
      expect(grouped.status).toBe(200);
      expect(grouped.json.representativeStagedPaymentId).toBe(repId);

      // Revert from a NON-representative member: the whole group must revert,
      // including the representative's matchedGiftId.
      const reverted = await api(`/api/staged-payments/${m1Id}/revert`);
      expect(reverted.status).toBe(200);

      for (const id of [repId, m1Id, m2Id]) {
        const row = await readStaged(id);
        expect(row.status).toBe("pending");
        expect(row.matchedGiftId).toBeNull();
        expect(row.groupReconciledGiftId).toBeNull();
        expect(row.createdGiftId).toBeNull();
        expect(row.approvedByUserId).toBeNull();
        expect(row.matchConfirmedAt).toBeNull();
      }

      // The pre-existing gift is never deleted by a group revert.
      const [gift] = await db
        .select()
        .from(schema.giftsAndPayments)
        .where(eqFn(schema.giftsAndPayments.id, giftId));
      expect(gift).toBeTruthy();
    }, 30_000);
  },
);
