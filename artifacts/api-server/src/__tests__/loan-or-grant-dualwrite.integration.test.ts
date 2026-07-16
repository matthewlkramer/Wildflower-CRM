import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the loan_or_grant CUTOVER (phase A003). The
 * `loan_or_grant` column is now the sole authoritative loan-vs-grant signal:
 * opportunity and goal writes take `loanOrGrant` directly (the legacy
 * `fundraising_category` / goal `category` are no longer written or returned),
 * while gift `type` still derives the flag (loan_fund_investment → loan).
 *
 * Exercises the real route handlers against the dev Postgres so it can assert
 * the persisted `loan_or_grant` value, covering: gift create/patch/bulk-update,
 * opportunity create/patch, goal upsert, and the two gift->pledge paths
 * (split-into-pledge, merge-into-pledge) which must inherit loan-vs-grant from
 * their source gift(s). Also asserts the deprecated legacy fields are scrubbed
 * from API responses.
 *
 * The only seam mocked is the Clerk auth gate (`requireAuth`) — a seeded admin
 * user is injected (goal upsert is admin-only). All seeded rows use a unique
 * run prefix and are cleaned up. Skips automatically when no real DATABASE_URL
 * is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `lorg_test_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    // Goal upsert is admin-gated (requireAdmin reads appUser.role), so inject
    // an admin role alongside the seeded user id.
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));

const RUN = `lorg_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ENTITY_ID = `${RUN}_entity`;
// A dedicated entity for the A002 read-source block so its FY-scoped goal /
// allocation rows can't collide with the dual-write block's route-created goal
// on ENTITY_ID (breakdown reads are scoped to this entity).
const ENTITY_RS = `${RUN}_entity_rs`;
const FY_ID = `${RUN}_fy`;

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  entities: Db["entities"];
  fiscalYears: Db["fiscalYears"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
  fiscalYearEntityGoals: Db["fiscalYearEntityGoals"];
  bulkOperations: Db["bulkOperations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let andFn: (typeof import("drizzle-orm"))["and"];
let server: Server;
let baseUrl = "";

let gen = 0;
function nextId(label: string): string {
  gen += 1;
  return `${RUN}_${label}_${String(gen).padStart(3, "0")}`;
}

const seededGiftIds: string[] = [];
const seededPledgeIds: string[] = [];

async function send(
  method: "POST" | "PATCH" | "PUT",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
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

async function readGiftLoanOrGrant(id: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, id));
  return row?.loanOrGrant;
}

async function readPledge(id: string) {
  const [row] = await db
    .select()
    .from(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, id));
  return row;
}

/** Seed a gift directly (bypassing the route) with explicit loan_or_grant. */
async function seedGift(
  amount: string,
  loanOrGrant: "loan" | "grant",
  allocs: string[],
): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
    type: loanOrGrant === "loan" ? "loan_fund_investment" : "standard_gift",
    loanOrGrant,
  });
  for (const sub of allocs) {
    await db.insert(schema.giftAllocations).values({
      id: nextId("alloc"),
      giftId: id,
      subAmount: sub,
    });
  }
  seededGiftIds.push(id);
  return id;
}

// ── A002 read-source seeds ──────────────────────────────────────────────────
// Each of these deliberately DESYNCS the legacy signal from the authoritative
// `loan_or_grant` flag, then asserts the analytics category buckets follow the
// FLAG. If any bucket still read the legacy type / fundraising_category, the row
// would land in the wrong track and the assertion would fail — so these tests
// prove the read cutover, not just the dual-write. All rows sit on ENTITY_RS and
// the breakdown reads are scoped to it, isolating them from the dual-write block.

/** Seed a goal-counting gift + allocation with type ⟂ loan_or_grant. */
async function seedGiftDesynced(
  subAmount: string,
  type: "standard_gift" | "loan_fund_investment",
  loanOrGrant: "loan" | "grant",
): Promise<string> {
  const id = nextId("rs_gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: subAmount,
    organizationId: ORG_ID,
    type,
    loanOrGrant,
  });
  await db.insert(schema.giftAllocations).values({
    id: nextId("rs_alloc"),
    giftId: id,
    subAmount,
    entityId: ENTITY_RS,
    grantYear: FY_ID,
  });
  seededGiftIds.push(id);
  return id;
}

async function readSourceBreakdown(): Promise<any> {
  const res = await fetch(
    `${baseUrl}/api/fiscal-year-breakdown/${FY_ID}?entityId=${ENTITY_RS}`,
  );
  const json = await res.json();
  if (res.status !== 200) {
    throw new Error(`breakdown ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    entities: dbMod.entities,
    fiscalYears: dbMod.fiscalYears,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
    fiscalYearEntityGoals: dbMod.fiscalYearEntityGoals,
    bulkOperations: dbMod.bulkOperations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  andFn = drizzle.and;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({ id: ORG_ID, name: `LorG Org ${RUN}` });
  await db.insert(schema.entities).values({ id: ENTITY_ID, name: `LorG Entity ${RUN}` });
  await db.insert(schema.entities).values({ id: ENTITY_RS, name: `LorG Entity RS ${RUN}` });
  await db.insert(schema.fiscalYears).values({ id: FY_ID, label: `FY ${RUN}` });

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
    .delete(schema.giftAllocations)
    .where(inArrayFn(schema.giftAllocations.giftId, seededGiftIds.length ? seededGiftIds : [""]));
  if (seededPledgeIds.length) {
    await db
      .delete(schema.pledgeAllocations)
      .where(inArrayFn(schema.pledgeAllocations.pledgeOrOpportunityId, seededPledgeIds));
  }
  if (seededGiftIds.length) {
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, seededGiftIds));
  }
  if (seededPledgeIds.length) {
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, seededPledgeIds));
  }
  await db
    .delete(schema.fiscalYearEntityGoals)
    .where(eqFn(schema.fiscalYearEntityGoals.fiscalYearId, FY_ID));
  await db
    .delete(schema.bulkOperations)
    .where(eqFn(schema.bulkOperations.actorUserId, TEST_USER_ID));
  await db.delete(schema.fiscalYears).where(eqFn(schema.fiscalYears.id, FY_ID));
  await db.delete(schema.entities).where(eqFn(schema.entities.id, ENTITY_ID));
  await db.delete(schema.entities).where(eqFn(schema.entities.id, ENTITY_RS));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) console.warn("[loan-or-grant-dualwrite] skipped: no live DATABASE_URL");
});

describe.skipIf(!HAS_DB)("loan_or_grant authoritative writes", () => {
  it("gift create mirrors loan_or_grant from type", async () => {
    const loan = await send("POST", "/api/gifts-and-payments", {
      amount: "100.00",
      organizationId: ORG_ID,
      type: "loan_fund_investment",
    });
    expect(loan.status).toBe(201);
    expect(loan.json.loanOrGrant).toBe("loan");
    seededGiftIds.push(loan.json.id);

    const grant = await send("POST", "/api/gifts-and-payments", {
      amount: "50.00",
      organizationId: ORG_ID,
      type: "standard_gift",
    });
    expect(grant.status).toBe(201);
    expect(grant.json.loanOrGrant).toBe("grant");
    seededGiftIds.push(grant.json.id);

    const noType = await send("POST", "/api/gifts-and-payments", {
      amount: "25.00",
      organizationId: ORG_ID,
    });
    expect(noType.status).toBe(201);
    expect(noType.json.loanOrGrant).toBe("grant");
    seededGiftIds.push(noType.json.id);
  });

  it("gift patch flips loan_or_grant only when type changes", async () => {
    const created = await send("POST", "/api/gifts-and-payments", {
      amount: "100.00",
      organizationId: ORG_ID,
      type: "standard_gift",
    });
    const id = created.json.id as string;
    seededGiftIds.push(id);
    expect(created.json.loanOrGrant).toBe("grant");

    const toLoan = await send("PATCH", `/api/gifts-and-payments/${id}`, {
      type: "loan_fund_investment",
    });
    expect(toLoan.status).toBe(200);
    expect(toLoan.json.loanOrGrant).toBe("loan");

    // A non-type patch must not reset the flag.
    const annotate = await send("PATCH", `/api/gifts-and-payments/${id}`, { amount: "120.00" });
    expect(annotate.status).toBe(200);
    expect(annotate.json.loanOrGrant).toBe("loan");

    const backToGrant = await send("PATCH", `/api/gifts-and-payments/${id}`, {
      type: "standard_gift",
    });
    expect(backToGrant.json.loanOrGrant).toBe("grant");
  });

  it("gift bulk-update mirrors loan_or_grant from a type change", async () => {
    const a = await send("POST", "/api/gifts-and-payments", {
      amount: "10.00",
      organizationId: ORG_ID,
      type: "standard_gift",
    });
    const b = await send("POST", "/api/gifts-and-payments", {
      amount: "20.00",
      organizationId: ORG_ID,
      type: "standard_gift",
    });
    const ids = [a.json.id as string, b.json.id as string];
    seededGiftIds.push(...ids);

    const bulk = await send("POST", "/api/gifts-and-payments/bulk-update", {
      ids,
      patch: { type: "loan_fund_investment" },
    });
    expect(bulk.status).toBe(200);
    expect(await readGiftLoanOrGrant(ids[0])).toBe("loan");
    expect(await readGiftLoanOrGrant(ids[1])).toBe("loan");

    // An owner-only bulk patch must leave the mirrored flag untouched.
    const ownerOnly = await send("POST", "/api/gifts-and-payments/bulk-update", {
      ids: [ids[0]],
      patch: { ownerUserId: TEST_USER_ID },
    });
    expect(ownerOnly.status).toBe(200);
    expect(await readGiftLoanOrGrant(ids[0])).toBe("loan");
  });

  it("opportunity create takes loanOrGrant directly (default grant) and scrubs the legacy field", async () => {
    const loan = await send("POST", "/api/opportunities-and-pledges", {
      name: `${RUN} loan opp`,
      organizationId: ORG_ID,
      loanOrGrant: "loan",
    });
    expect(loan.status).toBe(201);
    expect(loan.json.loanOrGrant).toBe("loan");
    // Deprecated legacy column must never reach the client.
    expect(loan.json).not.toHaveProperty("fundraisingCategory");
    seededPledgeIds.push(loan.json.id);

    const grant = await send("POST", "/api/opportunities-and-pledges", {
      name: `${RUN} grant opp`,
      organizationId: ORG_ID,
      loanOrGrant: "grant",
    });
    expect(grant.json.loanOrGrant).toBe("grant");
    seededPledgeIds.push(grant.json.id);

    const omitted = await send("POST", "/api/opportunities-and-pledges", {
      name: `${RUN} default opp`,
      organizationId: ORG_ID,
    });
    expect(omitted.json.loanOrGrant).toBe("grant");
    seededPledgeIds.push(omitted.json.id);
  });

  it("opportunity patch flips loan_or_grant via loanOrGrant", async () => {
    const created = await send("POST", "/api/opportunities-and-pledges", {
      name: `${RUN} flip opp`,
      organizationId: ORG_ID,
      loanOrGrant: "grant",
    });
    const id = created.json.id as string;
    seededPledgeIds.push(id);

    const toLoan = await send("PATCH", `/api/opportunities-and-pledges/${id}`, {
      loanOrGrant: "loan",
    });
    expect(toLoan.status).toBe(200);
    expect(toLoan.json.loanOrGrant).toBe("loan");
    expect(toLoan.json).not.toHaveProperty("fundraisingCategory");

    const back = await send("PATCH", `/api/opportunities-and-pledges/${id}`, {
      loanOrGrant: "grant",
    });
    expect(back.json.loanOrGrant).toBe("grant");
  });

  it("goal upsert keys on loan_or_grant (both path-token families) and scrubs legacy category", async () => {
    const loan = await send(
      "PUT",
      `/api/fiscal-year-entity-goals/${FY_ID}/${ENTITY_ID}/loan`,
      { goalAmount: "1000" },
    );
    expect(loan.status).toBe(200);
    expect(loan.json.loanOrGrant).toBe("loan");
    expect(loan.json).not.toHaveProperty("category");

    const grant = await send(
      "PUT",
      `/api/fiscal-year-entity-goals/${FY_ID}/${ENTITY_ID}/grant`,
      { goalAmount: "2000" },
    );
    expect(grant.json.loanOrGrant).toBe("grant");

    // Legacy path tokens still normalize onto the same rows (onConflict
    // update, not a duplicate insert).
    const reLoan = await send(
      "PUT",
      `/api/fiscal-year-entity-goals/${FY_ID}/${ENTITY_ID}/loan_capital`,
      { goalAmount: "1500" },
    );
    expect(reLoan.json.loanOrGrant).toBe("loan");
    expect(reLoan.json.goalAmount).toBe("1500.00");

    const reGrant = await send(
      "PUT",
      `/api/fiscal-year-entity-goals/${FY_ID}/${ENTITY_ID}/revenue`,
      { goalAmount: "2500" },
    );
    expect(reGrant.json.loanOrGrant).toBe("grant");
    expect(reGrant.json.goalAmount).toBe("2500.00");
  });

  it("split-into-pledge inherits loan from the source gift", async () => {
    const giftId = await seedGift("300.00", "loan", ["100.00", "200.00"]);
    const res = await send("POST", `/api/gifts-and-payments/${giftId}/split-into-pledge`, {});
    expect(res.status).toBe(200);
    const pledgeId = res.json.pledgeId as string;
    seededPledgeIds.push(pledgeId);

    const pledge = await readPledge(pledgeId);
    expect(pledge?.loanOrGrant).toBe("loan");

    // Every payment-gift (original + minted) carries the loan flag.
    for (const gid of res.json.giftIds as string[]) {
      if (!seededGiftIds.includes(gid)) seededGiftIds.push(gid);
      expect(await readGiftLoanOrGrant(gid)).toBe("loan");
    }
  });

  it("merge-into-pledge inherits loan from the source gift(s)", async () => {
    const giftId = await seedGift("500.00", "loan", ["500.00"]);
    const res = await send("POST", "/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [giftId],
      organizationId: ORG_ID,
    });
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(true);
    const pledgeId = res.json.pledgeId as string;
    seededPledgeIds.push(pledgeId);

    const pledge = await readPledge(pledgeId);
    expect(pledge?.loanOrGrant).toBe("loan");
  });
});

describe.skipIf(!HAS_DB)(
  "loan_or_grant read source (A002) — analytics bucket by the flag, not the legacy signal",
  () => {
    it("buckets a gift by loan_or_grant even when the legacy `type` disagrees", async () => {
      // type=standard_gift (→ legacy grant) but flag=loan ⇒ must land in loan capital.
      const flagLoan = await seedGiftDesynced("1000.00", "standard_gift", "loan");
      // type=loan_fund_investment (→ legacy loan) but flag=grant ⇒ must land in revenue.
      const flagGrant = await seedGiftDesynced("2000.00", "loan_fund_investment", "grant");

      const body = await readSourceBreakdown();
      const loanIds = body.loanCapital.received.rows.map((r: { giftId: string }) => r.giftId);
      const revIds = body.revenue.received.rows.map((r: { giftId: string }) => r.giftId);

      expect(loanIds).toContain(flagLoan);
      expect(revIds).not.toContain(flagLoan);
      expect(revIds).toContain(flagGrant);
      expect(loanIds).not.toContain(flagGrant);
    });

  },
);
