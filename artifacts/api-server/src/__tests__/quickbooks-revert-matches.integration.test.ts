import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { stagedStatusSql } from "../lib/derivedStatus";
import { getTableColumns } from "drizzle-orm";
import {
  clearPaymentApplicationsForRealm,
  qbCountedRowsForPayment,
} from "./paymentApplicationsTestUtil";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the bulk revert-matches endpoint
 * (POST /api/staged-payments/revert-matches) — the "Revert selected" action
 * used to clear auto-applied matches off the Auto-matched queue in one call.
 *
 * Asserts:
 *   - several auto-applied rows revert in one call (reconcile clears the link
 *     and leaves the pre-existing gift; auto-mint deletes the minted gift; both
 *     return to status='pending')
 *   - ids that are not revertible (manually-created gift; already pending;
 *     missing) are silently SKIPPED, not errors, and the rest still revert
 *   - an empty / invalid body is rejected 400 (Zod minItems)
 *   - duplicate ids are counted in `requested` but reverted once
 *
 * Same seam as the other QB suites: only the Clerk auth gate (`requireAuth`) is
 * mocked to inject a seeded test user; the revert transaction (gift deletion,
 * row locking, revertibility predicate) is the real production code. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `qb_rm_test_user_${Date.now()}`,
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

const RUN = `qbrm_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
  paymentApplications: Db["paymentApplications"];
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

const seededGiftIds: string[] = [];

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
 * Seed an approved staged row. Defaults to an auto-applied row; a
 * `linkedGiftId` (auto-RECONCILED, "Auto-matched" card) or `mintedGiftId`
 * (auto-MINT — createdTheGift) seeds the counted `payment_applications`
 * ledger row (the sole gift-link source). Override via opts for manual /
 * pending variants.
 */
async function seedStaged(
  label: string,
  opts: {
    autoApplied?: boolean;
    linkedGiftId?: string | null;
    mintedGiftId?: string | null;
  } = {},
): Promise<string> {
  const id = `${RUN}_sp_${label}`;
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    qbLineId: label,
    amount: "100.00",
    autoApplied: opts.autoApplied ?? true,
    organizationId: ORG_ID,
  });
  const linkGiftId = opts.linkedGiftId ?? opts.mintedGiftId;
  if (linkGiftId) {
    await db.insert(schema.paymentApplications).values({
      id: `${id}_pa`,
      paymentId: id,
      giftId: linkGiftId,
      amountApplied: "100.00",
      evidenceSource: "quickbooks",
      createdTheGift: !!opts.mintedGiftId,
    });
  }
  return id;
}

async function readStaged(id: string) {
  const [row] = await db
    .select({
      ...getTableColumns(schema.stagedPayments),
      status: stagedStatusSql,
    })
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, id));
  return row;
}

async function giftExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.giftsAndPayments.id })
    .from(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, id));
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
    giftsAndPayments: dbMod.giftsAndPayments,
    stagedPayments: dbMod.stagedPayments,
    paymentApplications: dbMod.paymentApplications,
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
    name: `QB Revert-Matches Test Org ${RUN}`,
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
  await clearPaymentApplicationsForRealm(REALM_ID);
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
      "[quickbooks-revert-matches] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("QuickBooks bulk revert-matches (integration)", () => {
  it("reverts several auto-applied matches in one call", async () => {
    // Auto-reconciled: links an existing gift (gift must survive the revert).
    const reconGift = await seedGift("100.00");
    const reconId = await seedStaged("recon", { linkedGiftId: reconGift });
    // Auto-minted: the created gift must be DELETED by the revert.
    const mintGift = await seedGift("100.00");
    const mintId = await seedStaged("mint", { mintedGiftId: mintGift });

    const res = await api("/api/staged-payments/revert-matches", {
      ids: [reconId, mintId],
    });

    expect(res.status).toBe(200);
    expect(res.json.requested).toBe(2);
    expect(new Set(res.json.revertedIds)).toEqual(new Set([reconId, mintId]));

    for (const id of [reconId, mintId]) {
      const row = await readStaged(id);
      expect(row.status).toBe("pending");
      expect(await qbCountedRowsForPayment(id)).toHaveLength(0);
      expect(row.autoApplied).toBe(false);
    }
    // Pre-existing reconciled gift is untouched; auto-minted gift is gone.
    expect(await giftExists(reconGift)).toBe(true);
    expect(await giftExists(mintGift)).toBe(false);
  }, 30_000);

  it("skips ids that aren't revertible but reverts the rest", async () => {
    const okGift = await seedGift("100.00");
    const okId = await seedStaged("ok", { linkedGiftId: okGift });
    // Manually created gift (autoApplied=false) → not revertible.
    const manualGift = await seedGift("100.00");
    const manualId = await seedStaged("manual", {
      mintedGiftId: manualGift,
      autoApplied: false,
    });
    // Already pending → not revertible.
    const pendingId = await seedStaged("pending");
    const missingId = `${RUN}_sp_missing`;

    const res = await api("/api/staged-payments/revert-matches", {
      ids: [okId, manualId, pendingId, missingId],
    });

    expect(res.status).toBe(200);
    expect(res.json.requested).toBe(4);
    expect(res.json.revertedIds).toEqual([okId]);

    // The manual gift survives and its row stays match_confirmed.
    expect(await giftExists(manualGift)).toBe(true);
    expect((await readStaged(manualId)).status).toBe("match_confirmed");
  }, 30_000);

  it("counts duplicate submitted ids in `requested` but reverts each row once", async () => {
    const gift = await seedGift("100.00");
    const id = await seedStaged("dup", { linkedGiftId: gift });

    const res = await api("/api/staged-payments/revert-matches", {
      ids: [id, id, id],
    });

    expect(res.status).toBe(200);
    expect(res.json.requested).toBe(3);
    expect(res.json.revertedIds).toEqual([id]);
  }, 30_000);

  it("rejects an empty id list with 400", async () => {
    const res = await api("/api/staged-payments/revert-matches", { ids: [] });
    expect(res.status).toBe(400);
  }, 30_000);
});
