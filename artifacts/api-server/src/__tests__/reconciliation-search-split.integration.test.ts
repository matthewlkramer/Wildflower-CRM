import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for SPLIT mode on the reconciliation gift search endpoint
 * (GET /api/reconciliation/search/gift?split=true).
 *
 * The "Split payment across gifts" dialog links one large staged payment to
 * several smaller existing gifts. The default (1:1 match) gift search requires
 * each candidate to be near-equal to the FULL payment amount, so every fraction
 * falls below the floor and the search is empty by construction. Split mode
 * drops that lower bound and instead returns any positive gift up to the payment
 * total (upper fee-band tolerance only), relaxing the date window too.
 *
 * These tests assert:
 *   - default (non-split) gift search returns NONE of the small fraction gifts,
 *   - split=true returns the small fraction gifts within the payment total,
 *   - a gift LARGER than the payment total is excluded even in split mode,
 *   - split candidates carry no (misleading) amount-confidence score.
 *
 * Same seam as the sibling reconciliation suites: only `requireAuth` is mocked
 * to inject a seeded admin user; the SQL and route validation are real
 * production code. Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `recon_split_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));

const RUN = `reconsplit_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const STAGED_ID = `${RUN}_staged`;
const SMALL_GIFT_A = `${RUN}_gift_a`;
const SMALL_GIFT_B = `${RUN}_gift_b`;
const HUGE_GIFT = `${RUN}_gift_huge`;
// A far-future window keeps the anchor clear of any real gifts.
const ANCHOR_DATE = "2099-09-15";
// A gift booked months before the lump payment — split mode must still find it.
const EARLY_DATE = "2099-02-01";
// The large lump payment being split across the small gifts.
const PAYMENT_AMOUNT = "478660.14";

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

type Candidate = {
  nodeType: string;
  id: string;
  label: string;
  confidence: number | null;
};

async function searchNode(
  qs: string,
): Promise<{ status: number; json: { data?: Candidate[] } }> {
  // Always request the max limit: split-mode candidates sort by date
  // proximity, so SMALL_GIFT_B (deliberately booked months early) ranks LAST
  // and gets crowded out of the default 25 when other parallel test forks'
  // 2099-dated gift seeds land in the amount band.
  const res = await fetch(
    `${baseUrl}/api/reconciliation/search/gift?limit=100&${qs}`,
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as { data?: Candidate[] } };
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
  };
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Reconciliation Split Test Org ${RUN}`,
  });
  // Two small gifts (fractions of the payment) booked on different dates, plus a
  // gift LARGER than the payment total that must be excluded even in split mode.
  await db.insert(schema.giftsAndPayments).values([
    {
      id: SMALL_GIFT_A,
      organizationId: ORG_ID,
      ownerUserId: TEST_USER_ID,
      amount: "250000.00",
      dateReceived: ANCHOR_DATE,
    },
    {
      id: SMALL_GIFT_B,
      organizationId: ORG_ID,
      ownerUserId: TEST_USER_ID,
      amount: "228660.14",
      dateReceived: EARLY_DATE,
    },
    {
      id: HUGE_GIFT,
      organizationId: ORG_ID,
      ownerUserId: TEST_USER_ID,
      amount: "900000.00",
      dateReceived: ANCHOR_DATE,
    },
  ]);
  await db.insert(schema.stagedPayments).values({
    id: STAGED_ID,
    realmId: `${RUN}_realm`,
    qbEntityType: "payment" as never,
    qbEntityId: `${RUN}_qbe`,
    amount: PAYMENT_AMOUNT,
    dateReceived: ANCHOR_DATE,
    payerName: `Zztest Split Payer ${RUN}`,
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
    .delete(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, STAGED_ID));
  for (const id of [SMALL_GIFT_A, SMALL_GIFT_B, HUGE_GIFT]) {
    await db
      .delete(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, id));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[reconciliation-search-split] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("reconciliation search split mode (integration)", () => {
  it("default (1:1) gift search returns none of the small fraction gifts", async () => {
    const { status, json } = await searchNode(`stagedPaymentId=${STAGED_ID}`);
    expect(status).toBe(200);
    const ids = new Set((json.data ?? []).map((c) => c.id));
    expect(ids.has(SMALL_GIFT_A)).toBe(false);
    expect(ids.has(SMALL_GIFT_B)).toBe(false);
  });

  it("split mode returns the small fraction gifts within the payment total", async () => {
    const { status, json } = await searchNode(
      `stagedPaymentId=${STAGED_ID}&split=true`,
    );
    expect(status).toBe(200);
    const ids = new Set((json.data ?? []).map((c) => c.id));
    expect(ids.has(SMALL_GIFT_A)).toBe(true);
    // Booked months earlier — split mode's relaxed date window must still find it.
    expect(ids.has(SMALL_GIFT_B)).toBe(true);
  });

  it("split mode excludes a gift larger than the payment total", async () => {
    const { json } = await searchNode(
      `stagedPaymentId=${STAGED_ID}&split=true`,
    );
    const ids = new Set((json.data ?? []).map((c) => c.id));
    expect(ids.has(HUGE_GIFT)).toBe(false);
  });

  it("split candidates carry no (misleading) amount-confidence score", async () => {
    const { json } = await searchNode(
      `stagedPaymentId=${STAGED_ID}&split=true`,
    );
    const hit = (json.data ?? []).find((c) => c.id === SMALL_GIFT_A);
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBeNull();
  });
});
