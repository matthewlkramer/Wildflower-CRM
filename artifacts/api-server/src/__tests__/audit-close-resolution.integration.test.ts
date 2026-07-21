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
import { proRataNegativeShares } from "../lib/auditCloseResolution";

/**
 * AUDIT-CLOSE AMOUNT-MISMATCH RESOLUTION coverage.
 *
 * Two surfaces are exercised:
 *
 *  1. `proRataNegativeShares` — the pure cents-exact splitter that turns a
 *     positive uncollected remainder into one NEGATIVE 2-decimal share per
 *     source allocation. DB-free, so it always runs.
 *
 *  2. The two post-close resolution routes, end-to-end against a real DB:
 *       - POST /opportunities-and-pledges/:id/write-off
 *       - POST /gifts-and-payments/:id/resolve-overpay
 *     Both book a NEW linked record in the current open FY and NEVER mutate the
 *     audited original. The tests assert every 409 guard predicate returns the
 *     right error code and leaves the ledger untouched, plus the write-off happy
 *     path (child pledge created, original unchanged, remainder written as a
 *     negative offsetting allocation).
 *
 * Same seam as the other route integration suites: only `requireAuth` is mocked
 * to inject a seeded user; freeze/governing-FY logic, transactions, and the
 * partial-unique indexes are real production code. All seeded rows use a unique
 * run prefix and skip automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `audit_close_test_user_${Date.now()}`,
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

// ── 1. Pure helper: proRataNegativeShares ──────────────────────────────────
describe("proRataNegativeShares", () => {
  /** Sum of the returned share strings, in integer cents. */
  function sumCents(shares: string[]): number {
    return shares.reduce((acc, s) => acc + Math.round(Number(s) * 100), 0);
  }

  it("splits an even remainder into equal negative shares", () => {
    expect(proRataNegativeShares([100, 100], 100)).toEqual(["-50.00", "-50.00"]);
  });

  it("splits proportionally to the weights", () => {
    expect(proRataNegativeShares([300, 100], 400)).toEqual([
      "-300.00",
      "-100.00",
    ]);
  });

  it("absorbs rounding drift into the LAST bucket so pieces reconcile exactly", () => {
    const shares = proRataNegativeShares([1, 1, 1], 100);
    expect(shares).toEqual(["-33.33", "-33.33", "-33.34"]);
    expect(sumCents(shares)).toBe(-10000);
  });

  it("handles a single bucket (whole remainder to it)", () => {
    expect(proRataNegativeShares([500], 400)).toEqual(["-400.00"]);
  });

  it("always reconciles to exactly -remainder for awkward amounts", () => {
    const cases: Array<[number[], number]> = [
      [[7, 11, 13], 100.01],
      [[1, 2, 3, 4], 999.99],
      [[50, 50, 50], 33.33],
      [[123.45, 67.89], 12.34],
    ];
    for (const [weights, remainder] of cases) {
      const shares = proRataNegativeShares(weights, remainder);
      expect(shares).toHaveLength(weights.length);
      expect(sumCents(shares)).toBe(-Math.round(remainder * 100));
      // Every piece is a well-formed 2-decimal non-positive amount.
      for (const s of shares) {
        expect(s).toMatch(/^-?\d+\.\d{2}$/);
        expect(Number(s)).toBeLessThanOrEqual(0);
      }
    }
  });

  it("throws when total weight is not positive", () => {
    expect(() => proRataNegativeShares([], 100)).toThrow(/total weight/);
    expect(() => proRataNegativeShares([0, 0], 100)).toThrow(/total weight/);
  });
});

// ── 2. Route integration ────────────────────────────────────────────────────
const RUN = `auditclose_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const CLOSED_FY_ID = `${RUN}_fy_closed`;
const OPEN_FY_ID = `${RUN}_fy_open`;
// A recognition date inside the (historical, audit-closed) FY window below. No
// real Wildflower FY covers 1990, so this FY is the sole container → frozen.
const CLOSED_DATE = "1990-12-01";

/** Today in America/Chicago (matches the FY-window date format the server uses). */
function todayChicago(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
  }).format(new Date());
}

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  fiscalYears: Db["fiscalYears"];
  giftsAndPayments: Db["giftsAndPayments"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

let gen = 0;
function nextId(kind: string): string {
  gen += 1;
  return `${RUN}_${kind}_${String(gen).padStart(3, "0")}`;
}

// Cleanup registries. Write-off / surplus CHILD records self-reference their
// originals with onDelete: restrict, so children are deleted first.
const baseOppIds: string[] = [];
const childOppIds: string[] = [];
const giftIds: string[] = [];

async function api(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function seedPledge(opts: {
  writtenPledge?: boolean;
  isWriteOff?: boolean;
  actualCompletionDate?: string | null;
  awardedAmount?: string | null;
}): Promise<string> {
  const id = nextId("opp");
  await db.insert(schema.opportunitiesAndPledges).values({
    id,
    name: `Audit-close pledge ${id}`,
    organizationId: ORG_ID,
    writtenPledge: opts.writtenPledge ?? false,
    isWriteOff: opts.isWriteOff ?? false,
    actualCompletionDate: opts.actualCompletionDate ?? null,
    awardedAmount: opts.awardedAmount ?? null,
  });
  baseOppIds.push(id);
  return id;
}

async function seedPledgeAlloc(pledgeId: string, subAmount: string): Promise<void> {
  await db.insert(schema.pledgeAllocations).values({
    id: nextId("palloc"),
    pledgeOrOpportunityId: pledgeId,
    subAmount,
  });
}

/** Seed a gift. When `opportunityId` is set it counts as a payment on that
 * pledge (drives the uncollected-remainder derivation). */
async function seedGift(opts: {
  amount: string;
  dateReceived?: string | null;
  opportunityId?: string;
  overpayOfGiftId?: string;
}): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: opts.amount,
    organizationId: ORG_ID,
    dateReceived: opts.dateReceived ?? null,
    opportunityId: opts.opportunityId ?? null,
    overpayOfGiftId: opts.overpayOfGiftId ?? null,
  });
  giftIds.push(id);
  return id;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    fiscalYears: dbMod.fiscalYears,
    giftsAndPayments: dbMod.giftsAndPayments,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
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
    name: `Audit-close Test Org ${RUN}`,
  });
  // Audit-CLOSED historical FY (freezes records dated inside it).
  await db.insert(schema.fiscalYears).values({
    id: CLOSED_FY_ID,
    label: `FY closed ${RUN}`,
    startDate: "1990-07-01",
    endDate: "1991-06-30",
    auditClosedAt: new Date(),
  });
  // An OPEN FY containing today, so corrections always have somewhere to book.
  const today = todayChicago();
  await db.insert(schema.fiscalYears).values({
    id: OPEN_FY_ID,
    label: `FY open ${RUN}`,
    startDate: today,
    endDate: today,
    auditClosedAt: null,
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
  const allOppIds = [...baseOppIds, ...childOppIds];
  if (allOppIds.length) {
    await db
      .delete(schema.pledgeAllocations)
      .where(inArrayFn(schema.pledgeAllocations.pledgeOrOpportunityId, allOppIds));
  }
  if (giftIds.length) {
    // Overpay children first (self-FK restrict), then the rest.
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.overpayOfGiftId, giftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  if (childOppIds.length) {
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, childOppIds));
  }
  if (baseOppIds.length) {
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, baseOppIds));
  }
  await db
    .delete(schema.fiscalYears)
    .where(inArrayFn(schema.fiscalYears.id, [CLOSED_FY_ID, OPEN_FY_ID]));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) console.warn("[audit-close-resolution] skipped: no live DATABASE_URL");
});

describe.skipIf(!HAS_DB)("POST /opportunities-and-pledges/:id/write-off", () => {
  it("404s for an unknown pledge", async () => {
    const res = await api(`/api/opportunities-and-pledges/${RUN}_missing/write-off`);
    expect(res.status).toBe(404);
  });

  it("409 invalid_write_off_target when the target is itself a write-off", async () => {
    const id = await seedPledge({
      writtenPledge: true,
      isWriteOff: true,
      actualCompletionDate: CLOSED_DATE,
    });
    const res = await api(`/api/opportunities-and-pledges/${id}/write-off`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("invalid_write_off_target");
  });

  it("409 invalid_write_off_target when the target is not a written pledge", async () => {
    const id = await seedPledge({
      writtenPledge: false,
      actualCompletionDate: CLOSED_DATE,
    });
    const res = await api(`/api/opportunities-and-pledges/${id}/write-off`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("invalid_write_off_target");
  });

  it("409 fiscal_year_not_closed when the pledge's FY is still open", async () => {
    // No actual_completion_date → no governing FY → not frozen.
    const id = await seedPledge({ writtenPledge: true, actualCompletionDate: null });
    await seedPledgeAlloc(id, "1000.00");
    const res = await api(`/api/opportunities-and-pledges/${id}/write-off`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("fiscal_year_not_closed");
  });

  it("409 nothing_to_write_off when the pledge is fully paid", async () => {
    const id = await seedPledge({
      writtenPledge: true,
      actualCompletionDate: CLOSED_DATE,
    });
    await seedPledgeAlloc(id, "500.00");
    await seedGift({ amount: "500.00", opportunityId: id });
    const res = await api(`/api/opportunities-and-pledges/${id}/write-off`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("nothing_to_write_off");
  });

  it("books a negative offsetting write-off pledge and never mutates the original", async () => {
    const id = await seedPledge({
      writtenPledge: true,
      actualCompletionDate: CLOSED_DATE,
      awardedAmount: "1000.00",
    });
    await seedPledgeAlloc(id, "1000.00");
    await seedGift({ amount: "600.00", opportunityId: id }); // paid 600 of 1000

    const res = await api(`/api/opportunities-and-pledges/${id}/write-off`, {
      reason: "audit-close shortfall",
    });
    expect(res.status).toBe(201);
    const writeOff = res.json;
    childOppIds.push(writeOff.id);

    expect(writeOff.id).not.toBe(id);
    expect(writeOff.writeOffOfPledgeId).toBe(id);
    expect(writeOff.isWriteOff).toBe(true);
    expect(writeOff.writtenPledge).toBe(true);
    expect(Number(writeOff.awardedAmount)).toBe(-400);

    // The write-off carries a negative allocation summing to the remainder.
    const woAllocs = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, writeOff.id));
    const woSum = woAllocs.reduce(
      (acc, a) => acc + Math.round(Number(a.subAmount ?? 0) * 100),
      0,
    );
    expect(woSum).toBe(-40000);

    // The audited original is untouched.
    const [orig] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, id));
    expect(orig.isWriteOff).toBe(false);
    expect(orig.writtenPledge).toBe(true);
    expect(Number(orig.awardedAmount)).toBe(1000);
    expect(String(orig.actualCompletionDate)).toContain("1990-12-01");

    // A second write-off is rejected while the first is still editable
    // (its own FY is open, so it can be corrected in place instead).
    const dup = await api(`/api/opportunities-and-pledges/${id}/write-off`);
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe("editable_write_off_exists");
    expect(dup.json.details?.writeOffPledgeId).toBe(writeOff.id);
  });

  it("400 invalid_amount for a malformed or non-positive amount", async () => {
    const id = await seedPledge({
      writtenPledge: true,
      actualCompletionDate: CLOSED_DATE,
    });
    await seedPledgeAlloc(id, "500.00");

    for (const amount of ["abc", "-5.00", "0.00", "1.234"]) {
      const res = await api(`/api/opportunities-and-pledges/${id}/write-off`, {
        amount,
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("invalid_amount");
    }
  });

  it("books a PARTIAL write-off at the user-chosen amount", async () => {
    const id = await seedPledge({
      writtenPledge: true,
      actualCompletionDate: CLOSED_DATE,
    });
    await seedPledgeAlloc(id, "1000.00");
    await seedGift({ amount: "600.00", opportunityId: id }); // remainder 400

    const res = await api(`/api/opportunities-and-pledges/${id}/write-off`, {
      amount: "150.00",
      reason: "partial shortfall",
    });
    expect(res.status).toBe(201);
    childOppIds.push(res.json.id);
    expect(Number(res.json.awardedAmount)).toBe(-150);

    const woAllocs = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, res.json.id));
    const woSum = woAllocs.reduce(
      (acc, a) => acc + Math.round(Number(a.subAmount ?? 0) * 100),
      0,
    );
    expect(woSum).toBe(-15000);
  });

  it("409 amount_exceeds_remainder above the cap, with the cap in details.maxAmount", async () => {
    const id = await seedPledge({
      writtenPledge: true,
      actualCompletionDate: CLOSED_DATE,
    });
    await seedPledgeAlloc(id, "1000.00");
    await seedGift({ amount: "600.00", opportunityId: id }); // remainder 400

    const res = await api(`/api/opportunities-and-pledges/${id}/write-off`, {
      amount: "400.01",
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("amount_exceeds_remainder");
    expect(res.json.details?.maxAmount).toBe("400.00");
  });

  it("allows a SECOND write-off once the first is frozen, capped at the NET remainder", async () => {
    const id = await seedPledge({
      writtenPledge: true,
      actualCompletionDate: CLOSED_DATE,
    });
    await seedPledgeAlloc(id, "1000.00");
    await seedGift({ amount: "600.00", opportunityId: id }); // remainder 400

    // First (partial) write-off: 100 of the 400.
    const first = await api(`/api/opportunities-and-pledges/${id}/write-off`, {
      amount: "100.00",
    });
    expect(first.status).toBe(201);
    childOppIds.push(first.json.id);

    // Blocked while the first is still editable (open FY).
    const blocked = await api(`/api/opportunities-and-pledges/${id}/write-off`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe("editable_write_off_exists");
    expect(blocked.json.details?.writeOffPledgeId).toBe(first.json.id);

    // Freeze the first write-off (date it into the audit-closed FY) — as if a
    // later audit closed the FY it was booked into.
    await db
      .update(schema.opportunitiesAndPledges)
      .set({ actualCompletionDate: CLOSED_DATE })
      .where(eqFn(schema.opportunitiesAndPledges.id, first.json.id));

    // The cap now NETS OUT the frozen prior write-off: 1000 - 600 - 100 = 300.
    const overCap = await api(`/api/opportunities-and-pledges/${id}/write-off`, {
      amount: "300.01",
    });
    expect(overCap.status).toBe(409);
    expect(overCap.json.error).toBe("amount_exceeds_remainder");
    expect(overCap.json.details?.maxAmount).toBe("300.00");

    // A second write-off for the remaining net balance books cleanly.
    const second = await api(`/api/opportunities-and-pledges/${id}/write-off`, {
      amount: "300.00",
    });
    expect(second.status).toBe(201);
    childOppIds.push(second.json.id);
    expect(Number(second.json.awardedAmount)).toBe(-300);
    expect(second.json.writeOffOfPledgeId).toBe(id);
  });
});

describe.skipIf(!HAS_DB)("POST /gifts-and-payments/:id/resolve-overpay", () => {
  it("404s for an unknown gift", async () => {
    const res = await api(`/api/gifts-and-payments/${RUN}_missing/resolve-overpay`);
    expect(res.status).toBe(404);
  });

  it("409 fiscal_year_not_closed when the gift's FY is still open", async () => {
    const id = await seedGift({ amount: "100.00", dateReceived: null });
    const res = await api(`/api/gifts-and-payments/${id}/resolve-overpay`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("fiscal_year_not_closed");
  });

  it("409 overpay_resolution_exists when an active surplus child already exists", async () => {
    const id = await seedGift({ amount: "100.00", dateReceived: CLOSED_DATE });
    await seedGift({ amount: "25.00", overpayOfGiftId: id });
    const res = await api(`/api/gifts-and-payments/${id}/resolve-overpay`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("overpay_resolution_exists");
  });

  it("409 no_surplus when the gift is not over-paid, minting nothing", async () => {
    const id = await seedGift({ amount: "100.00", dateReceived: CLOSED_DATE });
    const res = await api(`/api/gifts-and-payments/${id}/resolve-overpay`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("no_surplus");
    // The transaction rolled back — no surplus child was created.
    const children = await db
      .select({ id: schema.giftsAndPayments.id })
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.overpayOfGiftId, id));
    expect(children).toHaveLength(0);
  });
});

// Both the write-off route's cap (computePledgeUncollectedRemainder) and the
// pre-close checklist's underpaid-pledge remainder derive from the SAME
// canonical formula (pledgeCapacity.ts: committed + writtenOff − paid, cents-
// rounded, archived write-off children excluded). This asserts the two routes
// actually agree for the same pledge — including after a partial write-off.
describe.skipIf(!HAS_DB)("write-off cap and pre-close checklist agree on capacity", () => {
  async function checklistPledge(
    pledgeId: string,
  ): Promise<{ remainder: string } | undefined> {
    const res = await fetch(
      `${baseUrl}/api/fiscal-years/${CLOSED_FY_ID}/pre-close-checklist`,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      samplePledges: { id: string; remainder: string }[];
    };
    return json.samplePledges.find((p) => p.id === pledgeId);
  }

  /** The write-off route's enforced cap, read via its 409 details.maxAmount. */
  async function writeOffCap(pledgeId: string): Promise<string> {
    const res = await api(`/api/opportunities-and-pledges/${pledgeId}/write-off`, {
      amount: "9999999.00",
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("amount_exceeds_remainder");
    return res.json.details?.maxAmount as string;
  }

  it("returns the identical cents-rounded remainder from both routes", async () => {
    const id = await seedPledge({
      writtenPledge: true,
      actualCompletionDate: CLOSED_DATE,
    });
    // Odd-cent amounts exercise the cents-rounding edge: 1000.33 − 600.66.
    await seedPledgeAlloc(id, "1000.33");
    await seedGift({ amount: "600.66", opportunityId: id });
    // The checklist reads the PERSISTED `paid` rollup (API-created gifts keep
    // it in sync via applyDerivedOppFields; raw test seeds don't) — stamp it
    // to mirror the seeded gift, exactly as production writes would.
    await db
      .update(schema.opportunitiesAndPledges)
      .set({ paid: "600.66" })
      .where(eqFn(schema.opportunitiesAndPledges.id, id));

    expect(await writeOffCap(id)).toBe("399.67");
    expect((await checklistPledge(id))?.remainder).toBe("399.67");

    // A partial write-off shrinks BOTH figures in lockstep.
    const partial = await api(`/api/opportunities-and-pledges/${id}/write-off`, {
      amount: "100.00",
    });
    expect(partial.status).toBe(201);
    childOppIds.push(partial.json.id);
    // Freeze the first write-off so the route allows sizing a second one
    // (the cap 409 still reports the NET remainder either way).
    await db
      .update(schema.opportunitiesAndPledges)
      .set({ actualCompletionDate: CLOSED_DATE })
      .where(eqFn(schema.opportunitiesAndPledges.id, partial.json.id));

    expect(await writeOffCap(id)).toBe("299.67");
    expect((await checklistPledge(id))?.remainder).toBe("299.67");
  });
});

// A surplus gift minted to resolve an overpayment (overpay_of_gift_id set) has no
// counted accounting evidence, so it is stamped quickbooks_tie_status='missing' by
// default. It is the RESOLUTION, not a new problem, and has no resolution path of
// its own — the pre-close checklist for the FY it lands in must NOT re-flag it.
describe.skipIf(!HAS_DB)("pre-close checklist excludes overpay-resolution children", () => {
  async function checklist(fiscalYearId: string): Promise<{
    giftsUnresolved: number;
    sampleGifts: { id: string }[];
  }> {
    const res = await fetch(
      `${baseUrl}/api/fiscal-years/${fiscalYearId}/pre-close-checklist`,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      giftsUnresolved: number;
      sampleGifts: { id: string }[];
    };
  }

  it("counts a normal unresolved gift but not a surplus (overpay child) gift", async () => {
    const today = todayChicago();
    // Baseline unresolved count for the OPEN FY (fresh each run — absorbs any
    // gifts prior tests booked into today's window, so the delta stays exact).
    const baseline = (await checklist(OPEN_FY_ID)).giftsUnresolved;

    // A normal unresolved gift dated in the open FY (default tie='missing').
    const normalId = await seedGift({ amount: "50.00", dateReceived: today });
    // An original gift plus its surplus overpay child, the child also dated in
    // the open FY. The child defaults to 'missing' but must be excluded.
    const originalId = await seedGift({ amount: "100.00", dateReceived: CLOSED_DATE });
    const surplusChildId = await seedGift({
      amount: "20.00",
      dateReceived: today,
      overpayOfGiftId: originalId,
    });

    const after = await checklist(OPEN_FY_ID);
    // Exactly one net addition (the normal gift); the surplus child is excluded.
    expect(after.giftsUnresolved).toBe(baseline + 1);
    const sampleIds = after.sampleGifts.map((g) => g.id);
    expect(sampleIds).toContain(normalId);
    expect(sampleIds).not.toContain(surplusChildId);
  });
});
