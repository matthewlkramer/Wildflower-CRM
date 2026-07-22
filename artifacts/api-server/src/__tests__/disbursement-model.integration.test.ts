import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Invariant coverage for the disbursement-model split (Task #788):
 *
 * 1. Evidence-only gift creation — a manual POST /gifts-and-payments pointed
 *    at ANY pledge/opportunity 409s (manual_gift_on_pledge_blocked) unless the
 *    finance-gated off-books exception is claimed explicitly.
 * 2. Close-award semantics — the ONLY completion path for cost-reimbursement:
 *    fixed_commitment 409s (not_cost_reimbursement); unresolved projected
 *    allocations 409 with the remaining amount; closing flips derived status
 *    to cash_in; double-close and reopen-not-closed 409; reopen restores.
 * 3. Remaining-plan allocation inheritance — copyPledgeAllocationsToGift seeds
 *    from the un-drawn plan, copies restriction_description, and stamps
 *    source_pledge_allocation_id; a second draw only sees what remains.
 *
 * Real route handlers + real derivation against the dev Postgres. The only
 * mocked seam is the Clerk auth gate (admin, so finance-gated routes pass).
 * Skips automatically when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `dm_test_user_${Date.now()}`,
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

const RUN = `dm_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ENTITY_ID = `${RUN}_entity`;

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  entities: Db["entities"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let copyPledgeAllocationsToGift: (typeof import("../lib/reconciliationCommit"))["copyPledgeAllocationsToGift"];
let server: Server;
let baseUrl = "";

let gen = 0;
function nextId(label: string): string {
  gen += 1;
  return `${RUN}_${label}_${String(gen).padStart(3, "0")}`;
}

const seededGiftIds: string[] = [];
const seededOppIds: string[] = [];

async function seedOpp(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = nextId("opp");
  await db.insert(schema.opportunitiesAndPledges).values({
    id,
    name: `DM ${id}`,
    organizationId: ORG_ID,
    stage: "written_commitment",
    writtenPledge: true,
    ...overrides,
  });
  seededOppIds.push(id);
  return id;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  const commit = await import("../lib/reconciliationCommit");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    entities: dbMod.entities,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  copyPledgeAllocationsToGift = commit.copyPledgeAllocationsToGift;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({ id: ORG_ID, name: `DM Org ${RUN}` });
  await db.insert(schema.entities).values({ id: ENTITY_ID, name: `DM Entity ${RUN}` });

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
  if (seededGiftIds.length) {
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, seededGiftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, seededGiftIds));
  }
  if (seededOppIds.length) {
    await db
      .delete(schema.pledgeAllocations)
      .where(inArrayFn(schema.pledgeAllocations.pledgeOrOpportunityId, seededOppIds));
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, seededOppIds));
  }
  await db.delete(schema.entities).where(eqFn(schema.entities.id, ENTITY_ID));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) console.warn("[disbursement-model] skipped: no live DATABASE_URL");
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe.skipIf(!HAS_DB)("evidence-only gift creation (Task #788)", () => {
  it("blocks a manual gift pointed at a pledge without the off-books exception", async () => {
    const oppId = await seedOpp();
    const { status, json } = await post("/api/gifts-and-payments", {
      name: "DM manual blocked",
      organizationId: ORG_ID,
      opportunityId: oppId,
      amount: "100.00",
    });
    expect(status).toBe(409);
    expect(json?.error).toBe("manual_gift_on_pledge_blocked");
  });

  it("allows the gift when offBooksException=true (finance/admin) and does not persist the flag", async () => {
    const oppId = await seedOpp();
    const { status, json } = await post("/api/gifts-and-payments", {
      name: "DM off-books ok",
      organizationId: ORG_ID,
      opportunityId: oppId,
      amount: "100.00",
      offBooksException: true,
    });
    expect(status).toBe(201);
    expect(json?.id).toBeTruthy();
    seededGiftIds.push(json.id);
    // The exception is a request-level flag, never a column.
    expect(json).not.toHaveProperty("offBooksException");
  });

  it("does not touch gifts with no linked opportunity", async () => {
    const { status, json } = await post("/api/gifts-and-payments", {
      name: "DM plain gift",
      organizationId: ORG_ID,
      amount: "50.00",
    });
    expect(status).toBe(201);
    seededGiftIds.push(json.id);
  });

  it("blocks the mint-gift route without the off-books exception (no bypass)", async () => {
    const oppId = await seedOpp();
    const { status, json } = await post(
      `/api/opportunities-and-pledges/${oppId}/mint-gift`,
      {},
    );
    expect(status).toBe(409);
    expect(json?.error).toBe("manual_gift_on_pledge_blocked");
    const { status: s2, json: j2 } = await post(
      `/api/opportunities-and-pledges/${oppId}/mint-gift`,
      { awaitingSettlement: true },
    );
    expect(s2).toBe(409);
    expect(j2?.error).toBe("manual_gift_on_pledge_blocked");
  });

  it("mint-gift allows offBooksException=true (finance/admin) and inherits scope", async () => {
    const oppId = await seedOpp();
    const { status, json } = await post(
      `/api/opportunities-and-pledges/${oppId}/mint-gift`,
      { offBooksException: true },
    );
    expect(status).toBe(201);
    expect(json?.id).toBeTruthy();
    seededGiftIds.push(json.id);
    // The exception is a request-level flag, never a column.
    expect(json).not.toHaveProperty("offBooksException");
    const allocs = await db
      .select({ id: schema.giftAllocations.id })
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, json.id));
    expect(allocs.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("evidence-only also covers PATCH re-pointing (Task #788)", () => {
  async function patch(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  it("blocks the create-then-patch bypass (setting opportunityId on an unlinked gift)", async () => {
    const oppId = await seedOpp();
    const { status: s1, json: gift } = await post("/api/gifts-and-payments", {
      name: "DM patch bypass",
      organizationId: ORG_ID,
      amount: "75.00",
    });
    expect(s1).toBe(201);
    seededGiftIds.push(gift.id);

    const { status, json } = await patch(`/api/gifts-and-payments/${gift.id}`, {
      opportunityId: oppId,
    });
    expect(status).toBe(409);
    expect(json?.error).toBe("manual_gift_on_pledge_blocked");
  });

  it("blocks re-pointing a linked gift at a DIFFERENT pledge without the exception", async () => {
    const oppA = await seedOpp();
    const oppB = await seedOpp();
    const { status: s1, json: gift } = await post("/api/gifts-and-payments", {
      name: "DM patch repoint",
      organizationId: ORG_ID,
      opportunityId: oppA,
      amount: "75.00",
      offBooksException: true,
    });
    expect(s1).toBe(201);
    seededGiftIds.push(gift.id);

    const { status, json } = await patch(`/api/gifts-and-payments/${gift.id}`, {
      opportunityId: oppB,
    });
    expect(status).toBe(409);
    expect(json?.error).toBe("manual_gift_on_pledge_blocked");
  });

  it("allows PATCH re-pointing with offBooksException=true (finance/admin), never persisting the flag; clearing the link needs no exception", async () => {
    const oppA = await seedOpp();
    const oppB = await seedOpp();
    const { json: gift } = await post("/api/gifts-and-payments", {
      name: "DM patch ok",
      organizationId: ORG_ID,
      opportunityId: oppA,
      amount: "75.00",
      offBooksException: true,
    });
    seededGiftIds.push(gift.id);

    const { status, json } = await patch(`/api/gifts-and-payments/${gift.id}`, {
      opportunityId: oppB,
      offBooksException: true,
    });
    expect(status).toBe(200);
    expect(json?.opportunityId).toBe(oppB);
    expect(json).not.toHaveProperty("offBooksException");

    // Clearing the link is always allowed — no exception required.
    const { status: s3, json: j3 } = await patch(`/api/gifts-and-payments/${gift.id}`, {
      opportunityId: null,
    });
    expect(s3).toBe(200);
    expect(j3?.opportunityId).toBeNull();

    // Unrelated PATCHes (opportunityId untouched) are unaffected on a linked gift.
    const { status: s4 } = await patch(`/api/gifts-and-payments/${gift.id}`, {
      name: "DM patch renamed",
    });
    expect(s4).toBe(200);
  });
});

describe.skipIf(!HAS_DB)("plan-vs-actual per pledge-allocation line (Task #788)", () => {
  it("pledge detail derives actual, remaining, and variance reasons from stamped live gift allocations (archived excluded)", async () => {
    const oppId = await seedOpp({ awardedAmount: "1000.00" });
    const allocA = nextId("palloc");
    const allocB = nextId("palloc");
    await db.insert(schema.pledgeAllocations).values([
      { id: allocA, pledgeOrOpportunityId: oppId, subAmount: "600.00", entityId: ENTITY_ID },
      { id: allocB, pledgeOrOpportunityId: oppId, subAmount: "400.00", entityId: ENTITY_ID },
    ]);

    // Live gift drawing 250 from line A, with a recorded deliberate variance.
    const live = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: live,
      amount: "250.00",
      organizationId: ORG_ID,
      opportunityId: oppId,
    });
    seededGiftIds.push(live);
    await db.insert(schema.giftAllocations).values({
      id: nextId("galloc"),
      giftId: live,
      subAmount: "250.00",
      entityId: ENTITY_ID,
      sourcePledgeAllocationId: allocA,
      varianceReason: "Donor asked to front-load stipends",
    });

    // Archived gift also stamped on line A — must NOT count.
    const dead = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: dead,
      amount: "999.00",
      organizationId: ORG_ID,
      opportunityId: oppId,
      archivedAt: new Date(),
    });
    seededGiftIds.push(dead);
    await db.insert(schema.giftAllocations).values({
      id: nextId("galloc"),
      giftId: dead,
      subAmount: "999.00",
      entityId: ENTITY_ID,
      sourcePledgeAllocationId: allocA,
    });

    const res = await fetch(`${baseUrl}/api/opportunities-and-pledges/${oppId}`);
    expect(res.status).toBe(200);
    const detail: any = await res.json();
    const lineA = detail.allocations.find((a: any) => a.id === allocA);
    const lineB = detail.allocations.find((a: any) => a.id === allocB);
    expect(lineA?.actualAllocatedAmount).toBe("250.00");
    expect(lineA?.remainingPlannedAmount).toBe("350.00");
    expect(lineA?.varianceReasons).toEqual(["Donor asked to front-load stipends"]);
    expect(lineB?.actualAllocatedAmount).toBe("0.00");
    expect(lineB?.remainingPlannedAmount).toBe("400.00");
    expect(lineB?.varianceReasons).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("close-award closure semantics (Task #788)", () => {
  it("409s not_cost_reimbursement on a fixed commitment", async () => {
    const oppId = await seedOpp({ disbursementModel: "fixed_commitment" });
    const { status, json } = await post(
      `/api/opportunities-and-pledges/${oppId}/close-award`,
      { closedAt: "2026-07-01", reason: "award_period_ended" },
    );
    expect(status).toBe(409);
    expect(json?.error).toBe("not_cost_reimbursement");
  });

  it("409s unresolved_projected_allocations when the plan projects uncollected money", async () => {
    const oppId = await seedOpp({
      disbursementModel: "cost_reimbursement",
      awardedAmount: "1000.00",
    });
    await db.insert(schema.pledgeAllocations).values({
      id: nextId("palloc"),
      pledgeOrOpportunityId: oppId,
      subAmount: "1000.00",
      entityId: ENTITY_ID,
    });
    const { status, json } = await post(
      `/api/opportunities-and-pledges/${oppId}/close-award`,
      { closedAt: "2026-07-01", reason: "unused_balance" },
    );
    expect(status).toBe(409);
    expect(json?.error).toBe("unresolved_projected_allocations");
    expect(json?.details?.remainingProjected).toBe("1000.00");
  });

  it("closes when resolved, derives cash_in, blocks double-close, and reopen restores", async () => {
    const oppId = await seedOpp({
      disbursementModel: "cost_reimbursement",
      awardedAmount: "500.00",
    });
    await db.insert(schema.pledgeAllocations).values({
      id: nextId("palloc"),
      pledgeOrOpportunityId: oppId,
      subAmount: "300.00",
      entityId: ENTITY_ID,
    });
    // Live payment covering the whole remaining plan.
    const payId = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: payId,
      amount: "300.00",
      organizationId: ORG_ID,
      opportunityId: oppId,
    });
    seededGiftIds.push(payId);

    const closed = await post(`/api/opportunities-and-pledges/${oppId}/close-award`, {
      closedAt: "2026-07-01",
      reason: "fully_collected",
    });
    expect(closed.status).toBe(200);
    expect(closed.json?.awardClosedAt).toBeTruthy();
    expect(closed.json?.awardCloseReason).toBe("fully_collected");
    // Closure is the sole completion path — derived status flips to cash_in.
    expect(closed.json?.status).toBe("cash_in");

    const again = await post(`/api/opportunities-and-pledges/${oppId}/close-award`, {
      closedAt: "2026-07-02",
      reason: "terminated",
    });
    expect(again.status).toBe(409);
    expect(again.json?.error).toBe("award_already_closed");

    const reopened = await post(
      `/api/opportunities-and-pledges/${oppId}/reopen-award`,
      {},
    );
    expect(reopened.status).toBe(200);
    expect(reopened.json?.awardClosedAt).toBeNull();
    expect(reopened.json?.awardCloseReason).toBeNull();
    // Back to the active forecast: paid >= plan never completes CR.
    expect(reopened.json?.status).toBe("pledge");
  });

  it("409s award_not_closed when reopening an open award", async () => {
    const oppId = await seedOpp({ disbursementModel: "cost_reimbursement" });
    const { status, json } = await post(
      `/api/opportunities-and-pledges/${oppId}/reopen-award`,
      {},
    );
    expect(status).toBe(409);
    expect(json?.error).toBe("award_not_closed");
  });
});

describe.skipIf(!HAS_DB)("reimbursable retired as a write input (Task #788)", () => {
  it("400s POST /pledge-allocations with conditional=reimbursable", async () => {
    const oppId = await seedOpp({ disbursementModel: "cost_reimbursement" });
    const { status } = await post("/api/pledge-allocations", {
      pledgeOrOpportunityId: oppId,
      conditional: "reimbursable",
    });
    expect(status).toBe(400);
  });

  it("400s PATCH /pledge-allocations/:id with conditional=reimbursable", async () => {
    const oppId = await seedOpp({ disbursementModel: "cost_reimbursement" });
    const allocId = nextId("palloc");
    await db.insert(schema.pledgeAllocations).values({
      id: allocId,
      pledgeOrOpportunityId: oppId,
      entityId: ENTITY_ID,
    });
    const res = await fetch(`${baseUrl}/api/pledge-allocations/${allocId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conditional: "reimbursable" }),
    });
    expect(res.status).toBe(400);
    // Still accepts a non-retired value on the same row.
    const ok = await fetch(`${baseUrl}/api/pledge-allocations/${allocId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conditional: "conditional_on_target" }),
    });
    expect(ok.status).toBe(200);
  });
});

describe.skipIf(!HAS_DB)("CR planning completeness requires entity + purpose (Task #788)", () => {
  it("flags missing recipient entity and intended use, clears when coded", async () => {
    const oppId = await seedOpp({
      disbursementModel: "cost_reimbursement",
      awardedAmount: "1000.00",
      // Planning gaps only apply to won records; direct DB seed bypasses
      // derivation, so stamp the derived status a won pledge would carry.
      status: "pledge",
    });
    const allocId = nextId("palloc");
    await db.insert(schema.pledgeAllocations).values({
      id: allocId,
      pledgeOrOpportunityId: oppId,
      subAmount: "1000.00",
      grantYear: null,
      // No entityId, no intendedUsage, no reimbursementType.
    });

    const before = await fetch(`${baseUrl}/api/opportunities-and-pledges/${oppId}`);
    expect(before.status).toBe(200);
    const beforeJson = (await before.json()) as any;
    expect(beforeJson.planningComplete).toBe(false);
    expect(
      beforeJson.planningGaps.some((g: string) => g.includes("recipient entity")),
    ).toBe(true);
    expect(
      beforeJson.planningGaps.some((g: string) => g.includes("intended use")),
    ).toBe(true);

    await db
      .update(schema.pledgeAllocations)
      .set({
        entityId: ENTITY_ID,
        intendedUsage: "gen_ops",
        reimbursementType: "indirect",
      })
      .where(eqFn(schema.pledgeAllocations.id, allocId));

    const after = await fetch(`${baseUrl}/api/opportunities-and-pledges/${oppId}`);
    const afterJson = (await after.json()) as any;
    expect(
      afterJson.planningGaps.some(
        (g: string) => g.includes("recipient entity") || g.includes("intended use"),
      ),
    ).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("remaining-plan allocation inheritance (Task #788)", () => {
  it("seeds from the un-drawn plan, copies restriction_description, stamps source id", async () => {
    const oppId = await seedOpp({ awardedAmount: "1000.00" });
    const allocA = nextId("palloc");
    const allocB = nextId("palloc");
    await db.insert(schema.pledgeAllocations).values([
      {
        id: allocA,
        pledgeOrOpportunityId: oppId,
        subAmount: "600.00",
        entityId: ENTITY_ID,
        restrictionDescription: "For teacher stipends only",
      },
      {
        id: allocB,
        pledgeOrOpportunityId: oppId,
        subAmount: "400.00",
        entityId: ENTITY_ID,
      },
    ]);

    // First draw: 500 spread proportionally across the full remaining plan
    // (600/400 → 300/200) since no prior stamped draws exist.
    const gift1 = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: gift1,
      amount: "500.00",
      organizationId: ORG_ID,
      opportunityId: oppId,
    });
    seededGiftIds.push(gift1);
    await db.transaction((tx) => copyPledgeAllocationsToGift(tx, oppId, gift1, "500.00"));

    const rows1 = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, gift1));
    expect(rows1).toHaveLength(2);
    const total1 = rows1.reduce((s, r) => s + Number(r.subAmount ?? 0), 0);
    expect(total1.toFixed(2)).toBe("500.00"); // header == sum invariant
    for (const r of rows1) expect(r.sourcePledgeAllocationId).toBeTruthy();
    const fromA1 = rows1.find((r) => r.sourcePledgeAllocationId === allocA);
    expect(fromA1?.subAmount).toBe("300.00");
    expect(fromA1?.restrictionDescription).toBe("For teacher stipends only");
    const fromB1 = rows1.find((r) => r.sourcePledgeAllocationId === allocB);
    expect(fromB1?.subAmount).toBe("200.00");

    // Second draw: remaining plan is now 300/200 — another 500 consumes it
    // exactly (300/200 again), proving prior draws reduce the plan.
    const gift2 = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: gift2,
      amount: "500.00",
      organizationId: ORG_ID,
      opportunityId: oppId,
    });
    seededGiftIds.push(gift2);
    await db.transaction((tx) => copyPledgeAllocationsToGift(tx, oppId, gift2, "500.00"));

    const rows2 = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, gift2));
    const total2 = rows2.reduce((s, r) => s + Number(r.subAmount ?? 0), 0);
    expect(total2.toFixed(2)).toBe("500.00");
    const fromA2 = rows2.find((r) => r.sourcePledgeAllocationId === allocA);
    expect(fromA2?.subAmount).toBe("300.00");

    // Third draw with the plan fully consumed: falls back to all lines so the
    // gift is never scope-less.
    const gift3 = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: gift3,
      amount: "100.00",
      organizationId: ORG_ID,
      opportunityId: oppId,
    });
    seededGiftIds.push(gift3);
    await db.transaction((tx) => copyPledgeAllocationsToGift(tx, oppId, gift3, "100.00"));
    const rows3 = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, gift3));
    expect(rows3.length).toBeGreaterThan(0);
    const total3 = rows3.reduce((s, r) => s + Number(r.subAmount ?? 0), 0);
    expect(total3.toFixed(2)).toBe("100.00");
  });

  it("archived prior gifts do NOT count as drawn plan", async () => {
    const oppId = await seedOpp();
    const allocId = nextId("palloc");
    await db.insert(schema.pledgeAllocations).values({
      id: allocId,
      pledgeOrOpportunityId: oppId,
      subAmount: "100.00",
      entityId: ENTITY_ID,
    });
    // Archived gift that already drew the whole plan — dead money.
    const dead = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: dead,
      amount: "100.00",
      organizationId: ORG_ID,
      opportunityId: oppId,
      archivedAt: new Date(),
    });
    seededGiftIds.push(dead);
    await db.insert(schema.giftAllocations).values({
      id: nextId("galloc"),
      giftId: dead,
      subAmount: "100.00",
      entityId: ENTITY_ID,
      sourcePledgeAllocationId: allocId,
    });

    const gift = nextId("gift");
    await db.insert(schema.giftsAndPayments).values({
      id: gift,
      amount: "100.00",
      organizationId: ORG_ID,
      opportunityId: oppId,
    });
    seededGiftIds.push(gift);
    await db.transaction((tx) => copyPledgeAllocationsToGift(tx, oppId, gift, "100.00"));
    const rows = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, gift));
    // The plan still reads as fully remaining → seeded from it directly.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subAmount).toBe("100.00");
    expect(rows[0]?.sourcePledgeAllocationId).toBe(allocId);
  });
});
