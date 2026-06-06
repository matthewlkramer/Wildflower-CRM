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
 * End-to-end coverage for the QuickBooks deposit group-reconcile GUARDRAILS.
 *
 * Companion to `quickbooks-group-reconcile.integration.test.ts` (which covers
 * the happy path + revert). This file asserts the route's rejection paths each
 * return the right status/error AND leave every row untouched:
 *   - DIFFERENT bank deposits (or no deposit at all)   → 400 not_groupable
 *   - one row already resolved/approved                → 409 not_pending
 *   - gift already linked to a staged row outside group → 409 link_conflict
 *   - fewer than two rows                              → 400 group_too_small
 *
 * Same seam as the companion suite: only the Clerk auth gate (`requireAuth`) is
 * mocked to inject a seeded test user; transactions, locking, the deposit/
 * tolerance guards and the partial-unique index are the real production code.
 * All seeded rows use a unique run prefix and are cleaned up.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `qb_grpg_test_user_${Date.now()}`,
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

const RUN = `qbgrpg_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;

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
  seededGiftIds.push(id);
  return id;
}

/**
 * Seed a staged row. `depositId` is required so each test can opt into the
 * same/different/null deposit it needs; `status`, `matchedGiftId` and
 * `groupReconciledGiftId` default to a clean pending row.
 */
async function seedStaged(
  giftId: string,
  label: string,
  amount: string,
  opts: {
    depositId: string | null;
    status?: "pending" | "approved" | "rejected";
    matchedGiftId?: string | null;
    groupReconciledGiftId?: string | null;
  },
): Promise<string> {
  const id = stagedId(giftId, label);
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    qbLineId: label,
    amount,
    qbDepositId: opts.depositId,
    status: opts.status ?? "pending",
    matchedGiftId: opts.matchedGiftId ?? null,
    groupReconciledGiftId: opts.groupReconciledGiftId ?? null,
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

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `QB Group Guard Test Org ${RUN}`,
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
    console.warn(
      "[quickbooks-group-reconcile-guards] skipped: no live DATABASE_URL configured",
    );
  }
});

/** Assert a staged row is still a clean, untouched pending row. */
async function expectUntouchedPending(id: string) {
  const row = await readStaged(id);
  expect(row.status).toBe("pending");
  expect(row.matchedGiftId).toBeNull();
  expect(row.groupReconciledGiftId).toBeNull();
  expect(row.createdGiftId).toBeNull();
  expect(row.approvedByUserId).toBeNull();
  expect(row.matchConfirmedAt).toBeNull();
}

describe.skipIf(!HAS_DB)(
  "QuickBooks deposit group-reconcile guardrails (integration)",
  () => {
    it("rejects rows from DIFFERENT deposits with 400 not_groupable and changes nothing", async () => {
      const giftId = await seedGift("100.00");
      // Combined 100 == gift, so only the deposit guard (which runs first) can
      // be the reason for rejection.
      const aId = await seedStaged(giftId, "a", "50.00", {
        depositId: `${RUN}_depA`,
      });
      const bId = await seedStaged(giftId, "b", "50.00", {
        depositId: `${RUN}_depB`,
      });

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("not_groupable");

      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);
    }, 30_000);

    it("rejects rows with NO deposit with 400 not_groupable and changes nothing", async () => {
      const giftId = await seedGift("100.00");
      const aId = await seedStaged(giftId, "a", "50.00", { depositId: null });
      const bId = await seedStaged(giftId, "b", "50.00", { depositId: null });

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("not_groupable");

      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);
    }, 30_000);

    it("rejects when a row is already resolved with 409 not_pending and changes nothing", async () => {
      const giftId = await seedGift("100.00");
      const depositId = `${RUN}_dep_np`;
      const pendingId = await seedStaged(giftId, "a", "50.00", { depositId });
      // Already approved (resolved) — the not_pending guard runs before the
      // deposit/tolerance guards, so a shared deposit + matching total prove the
      // rejection is specifically because this row isn't pending.
      const resolvedId = await seedStaged(giftId, "b", "50.00", {
        depositId,
        status: "approved",
      });

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [pendingId, resolvedId],
      });

      expect(res.status).toBe(409);
      expect(res.json.error).toBe("not_pending");

      // The still-pending row is untouched.
      await expectUntouchedPending(pendingId);
      // The already-resolved row is left exactly as seeded.
      const resolved = await readStaged(resolvedId);
      expect(resolved.status).toBe("approved");
      expect(resolved.groupReconciledGiftId).toBeNull();
    }, 30_000);

    it("rejects when the gift is already linked outside the group with 409 link_conflict", async () => {
      // Gift the group would reconcile to, sized to pass the tolerance guard.
      const giftId = await seedGift("100.00");
      const depositId = `${RUN}_dep_lc`;
      const aId = await seedStaged(giftId, "a", "50.00", { depositId });
      const bId = await seedStaged(giftId, "b", "50.00", { depositId });
      // A staged row OUTSIDE the group already linked to the same gift — its
      // own deposit doesn't matter; the conflict query keys on the gift link.
      const outsiderId = await seedStaged(giftId, "out", "100.00", {
        depositId: `${RUN}_dep_other`,
        status: "approved",
        matchedGiftId: giftId,
      });

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(409);
      expect(res.json.error).toBe("link_conflict");

      // The two group members are untouched.
      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);
      // The outsider keeps its existing link, unchanged.
      const outsider = await readStaged(outsiderId);
      expect(outsider.matchedGiftId).toBe(giftId);
      expect(outsider.status).toBe("approved");
    }, 30_000);

    it("rejects a single-row array at the schema layer with 400 validation_error and changes nothing", async () => {
      // A literal one-element array never reaches the route's group_too_small
      // guard: the request schema (minItems: 2) rejects it first.
      const giftId = await seedGift("50.00");
      const onlyId = await seedStaged(giftId, "a", "50.00", {
        depositId: `${RUN}_dep_small`,
      });

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [onlyId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("validation_error");

      await expectUntouchedPending(onlyId);
    }, 30_000);

    it("collapses duplicate ids to one row → 400 group_too_small and changes nothing", async () => {
      // Two distinct ids pass the schema's minItems:2, but the route de-dupes
      // before counting, so the same row twice is a group of one — this is the
      // path that actually reaches the route's group_too_small guard.
      const giftId = await seedGift("50.00");
      const onlyId = await seedStaged(giftId, "a", "50.00", {
        depositId: `${RUN}_dep_dup`,
      });

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [onlyId, onlyId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("group_too_small");

      await expectUntouchedPending(onlyId);
    }, 30_000);
  },
);
