import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Revenue Extractor report completeness (Task #794 step 8).
 *
 * GET /api/revenue-extractor?startDate=&endDate= is the export the frontend
 * turns 1:1 into the finance CSV — so the report MUST contain every allocation
 * row the date filter matches, with no pagination or row cap. Locked in here:
 *
 *   - a batch larger than any typical page size (60 gifts) comes back complete;
 *   - the [startDate, endDate] range is INCLUSIVE on both ends and excludes
 *     out-of-range gifts;
 *   - archived gifts are excluded;
 *   - missing/invalid/reversed dates are rejected with 400 (not a 500).
 *
 * Only the Clerk auth gate (requireAuth) is mocked. Skips when no real
 * DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `revext_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const ORG_ID = `${RUN}_org`;

// A far-future window no real data can pollute.
const START = "2097-03-01";
const END = "2097-03-31";
const BATCH = 60; // > any typical page cap (50)

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
  giftAllocations: Db["giftAllocations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let likeFn: (typeof import("drizzle-orm"))["like"];
let server: Server;
let baseUrl = "";

const giftId = (i: number) => `${RUN}_g${String(i).padStart(3, "0")}`;
const IN_RANGE_IDS = Array.from({ length: BATCH }, (_, i) => giftId(i));
const GIFT_START_EDGE = giftId(0); // dateReceived = START
const GIFT_END_EDGE = giftId(1); // dateReceived = END
const GIFT_BEFORE = `${RUN}_before`; // day before START — excluded
const GIFT_AFTER = `${RUN}_after`; // day after END — excluded
const GIFT_ARCHIVED = `${RUN}_arch`; // in range but archived — excluded

interface ReportRow {
  giftId: string;
  allocationId: string | null;
  isFeeLine: boolean;
  transactionDate: string | null;
}

async function getReport(qs: string): Promise<{
  status: number;
  json: { rows?: ReportRow[]; error?: string };
}> {
  const res = await fetch(`${baseUrl}/api/revenue-extractor${qs}`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: (json ?? {}) as { rows?: ReportRow[] } };
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
    giftAllocations: dbMod.giftAllocations,
  };
  eqFn = drizzle.eq;
  likeFn = drizzle.like;

  await db.insert(schema.users).values({
    id: ADMIN_ID,
    clerkId: `clerk_${ADMIN_ID}`,
    email: `${ADMIN_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `RevExt Org ${RUN}` });

  // 60 in-range gifts: index 0 sits exactly on START, index 1 exactly on END,
  // the rest spread across the middle of the month.
  const dateFor = (i: number) => {
    if (i === 0) return START;
    if (i === 1) return END;
    return `2097-03-${String(2 + (i % 28)).padStart(2, "0")}`;
  };
  await db.insert(schema.giftsAndPayments).values([
    ...IN_RANGE_IDS.map((id, i) => ({
      id,
      name: `RevExt gift ${id}`,
      organizationId: ORG_ID,
      amount: "100.00",
      dateReceived: dateFor(i),
    })),
    {
      id: GIFT_BEFORE,
      name: `RevExt before ${RUN}`,
      organizationId: ORG_ID,
      amount: "100.00",
      dateReceived: "2097-02-28",
    },
    {
      id: GIFT_AFTER,
      name: `RevExt after ${RUN}`,
      organizationId: ORG_ID,
      amount: "100.00",
      dateReceived: "2097-04-01",
    },
    {
      id: GIFT_ARCHIVED,
      name: `RevExt archived ${RUN}`,
      organizationId: ORG_ID,
      amount: "100.00",
      dateReceived: "2097-03-15",
      archivedAt: new Date("2097-03-16T00:00:00Z"),
    },
  ]);
  await db.insert(schema.giftAllocations).values(
    [...IN_RANGE_IDS, GIFT_BEFORE, GIFT_AFTER, GIFT_ARCHIVED].map((g) => ({
      id: `${g}_alloc`,
      giftId: g,
      subAmount: "100.00",
    })),
  );

  auth.current = { id: ADMIN_ID, role: "admin" };
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
    .delete(schema.giftAllocations)
    .where(likeFn(schema.giftAllocations.id, `${RUN}%`));
  await db
    .delete(schema.giftsAndPayments)
    .where(likeFn(schema.giftsAndPayments.id, `${RUN}%`));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, ADMIN_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("revenue extractor export completeness", () => {
  it("returns EVERY in-range allocation row — no pagination or cap truncation", async () => {
    const { status, json } = await getReport(
      `?startDate=${START}&endDate=${END}`,
    );
    expect(status).toBe(200);
    const mine = (json.rows ?? []).filter(
      (r) => r.giftId.startsWith(RUN) && !r.isFeeLine,
    );
    // Exactly one allocation row per in-range gift — all 60 present.
    expect(mine.length).toBe(BATCH);
    const ids = new Set(mine.map((r) => r.giftId));
    for (const id of IN_RANGE_IDS) expect(ids.has(id)).toBe(true);
  });

  it("the range is inclusive on BOTH ends and excludes out-of-range + archived gifts", async () => {
    const { json } = await getReport(`?startDate=${START}&endDate=${END}`);
    const ids = new Set((json.rows ?? []).map((r) => r.giftId));
    expect(ids.has(GIFT_START_EDGE)).toBe(true);
    expect(ids.has(GIFT_END_EDGE)).toBe(true);
    expect(ids.has(GIFT_BEFORE)).toBe(false);
    expect(ids.has(GIFT_AFTER)).toBe(false);
    expect(ids.has(GIFT_ARCHIVED)).toBe(false);
  });

  it("rejects missing, malformed, nonsense, and reversed date ranges with 400", async () => {
    expect((await getReport("")).status).toBe(400);
    expect((await getReport(`?startDate=${START}`)).status).toBe(400);
    expect(
      (await getReport("?startDate=2097-13-40&endDate=2097-03-31")).status,
    ).toBe(400);
    expect(
      (await getReport(`?startDate=${END}&endDate=${START}`)).status,
    ).toBe(400);
  });
});
