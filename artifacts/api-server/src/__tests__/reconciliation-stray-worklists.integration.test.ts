import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the two NEW "stray worklist" read endpoints that hang
 * off the QB-anchored reconciliation workspace:
 *
 *   GET /api/reconciliation/gifts-missing-qb
 *     "gifts with no QuickBooks record" — every gift should eventually map to a
 *     QB money event; this surfaces the ones that don't. A gift is "missing a QB
 *     record" iff it carries NO final-amount QB pointer AND no staged_payments
 *     row links it (matched / created / group-reconciled). Broad + filterable
 *     (q, entityId, paymentMethod, hasStripe, date window); donor names masked
 *     per the viewer (match RAW name, mask DISPLAY).
 *
 *   GET /api/reconciliation/qb-search
 *     criteria-based QB staged-payment search with NO card anchor — the
 *     stray-Stripe worklist uses it to hunt the QB deposit an unmatched Stripe
 *     payout belongs to. Requires text (>=2 chars) OR a positive amount.
 *
 * Same seam as the other reconciliation suites: only `requireAuth` is mocked to
 * inject a seeded NON-admin (team_member) user so the anonymous-masking path is
 * actually exercised; the route SQL is the real production code. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `recon_stray_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    // NON-admin viewer so anonymous masking is enforced (admins see all names).
    req.appUser = { id: TEST_USER_ID, role: "team_member" };
    next();
  },
}));

const RUN = `recstray_${Date.now()}`;
const MARKER = `${RUN}_mk`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;
const ENTITY_ID = `${RUN}_entity`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stagedPayments: Db["stagedPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  entities: Db["entities"];
};
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

const orgIds: string[] = [];
const giftIds: string[] = [];
const allocIds: string[] = [];
const stagedIds: string[] = [];
const chargeIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function apiGet(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "GET" });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function seedOrg(opts: {
  label: string;
  anonymous?: boolean;
  ownerUserId?: string | null;
}): Promise<string> {
  const id = nextId("org");
  await db.insert(schema.organizations).values({
    id,
    name: `${MARKER} ${opts.label}`,
    anonymous: opts.anonymous ?? false,
    ownerUserId: opts.ownerUserId ?? null,
  });
  orgIds.push(id);
  return id;
}

async function seedGift(opts: {
  organizationId: string;
  amount?: string;
  dateReceived?: string | null;
  paymentMethod?: string | null;
  archived?: boolean;
}): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: opts.amount ?? "100.00",
    organizationId: opts.organizationId,
    dateReceived: opts.dateReceived ?? null,
    paymentMethod: (opts.paymentMethod ?? null) as never,
    archivedAt: opts.archived ? new Date() : null,
    details: "stray-worklist test gift",
  });
  giftIds.push(id);
  return id;
}

async function seedAllocation(giftId: string, entityId: string): Promise<void> {
  const id = nextId("alloc");
  await db.insert(schema.giftAllocations).values({
    id,
    giftId,
    entityId,
    subAmount: "100.00",
  });
  allocIds.push(id);
}

async function seedStaged(opts: {
  label: string;
  amount?: string;
  dateReceived?: string | null;
  status?: "pending" | "approved" | "reconciled";
  matchedGiftId?: string | null;
  createdGiftId?: string | null;
  groupReconciledGiftId?: string | null;
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    amount: opts.amount ?? "100.00",
    dateReceived: opts.dateReceived ?? "2026-03-15",
    payerName: `${MARKER} ${opts.label}`,
    status: opts.status ?? "pending",
    matchStatus: "unmatched",
    matchedGiftId: opts.matchedGiftId ?? null,
    createdGiftId: opts.createdGiftId ?? null,
    groupReconciledGiftId: opts.groupReconciledGiftId ?? null,
  });
  stagedIds.push(id);
  return id;
}

async function seedCharge(matchedGiftId: string): Promise<string> {
  const id = nextId("sc");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    grossAmount: "100.00",
    matchedGiftId,
  });
  chargeIds.push(id);
  return id;
}

type GiftRow = {
  id: string;
  donorName: string | null;
  donorKind: string | null;
  entityId: string | null;
  entityName: string | null;
  paymentMethod: string | null;
  hasStripeEvidence: boolean;
};

async function listGifts(qs: string): Promise<{
  rows: GiftRow[];
  ids: Set<string>;
  pagination: { page: number; limit: number; total: number };
}> {
  const res = await apiGet(`/api/reconciliation/gifts-missing-qb?${qs}`);
  expect(res.status).toBe(200);
  const rows = res.json.data as GiftRow[];
  return {
    rows,
    ids: new Set(rows.map((r) => r.id)),
    pagination: res.json.pagination,
  };
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
    stagedPayments: dbMod.stagedPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    entities: dbMod.entities,
  };
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "team_member",
  });
  await db.insert(schema.entities).values({ id: ENTITY_ID, name: `${MARKER} Entity` });

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
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (allocIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.id, allocIds));
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  if (orgIds.length)
    await db
      .delete(schema.organizations)
      .where(inArrayFn(schema.organizations.id, orgIds));
  await db.delete(schema.entities).where(eqFn(schema.entities.id, ENTITY_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn("[reconciliation-stray-worklists] skipped: no live DATABASE_URL");
  }
});

describe.skipIf(!HAS_DB)("GET /reconciliation/gifts-missing-qb (integration)", () => {
  it("includes gifts with no QB link and excludes any QB-linked or archived gift", async () => {
    const orgVisible = await seedOrg({ label: "Visible Org" });

    const giftNoQb = await seedGift({ organizationId: orgVisible });
    const giftMatched = await seedGift({ organizationId: orgVisible });
    const giftCreated = await seedGift({ organizationId: orgVisible });
    const giftGroup = await seedGift({ organizationId: orgVisible });
    const giftArchived = await seedGift({ organizationId: orgVisible, archived: true });

    await seedStaged({ label: "matched", matchedGiftId: giftMatched });
    await seedStaged({ label: "created", createdGiftId: giftCreated });
    await seedStaged({ label: "group", groupReconciledGiftId: giftGroup });

    const { ids, pagination } = await listGifts(`q=${encodeURIComponent(MARKER)}&limit=200`);

    expect(ids.has(giftNoQb)).toBe(true); // no QB link → surfaced
    expect(ids.has(giftMatched)).toBe(false); // staged_payments.matched_gift_id
    expect(ids.has(giftCreated)).toBe(false); // staged_payments.created_gift_id
    expect(ids.has(giftGroup)).toBe(false); // staged_payments.group_reconciled_gift_id
    expect(ids.has(giftArchived)).toBe(false); // archived gifts never surface

    // Pagination envelope is present and well-formed.
    expect(pagination.limit).toBe(200);
    expect(typeof pagination.total).toBe("number");
    expect(pagination.total).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("masks anonymous donor names for a non-owner, non-admin viewer (match RAW, mask DISPLAY)", async () => {
    // Anonymous org the viewer does NOT own → the team_member viewer must not
    // see its real name, but the RAW name still matches the `q` filter.
    const orgAnon = await seedOrg({
      label: "Secret Anon Org",
      anonymous: true,
    });
    const giftAnon = await seedGift({ organizationId: orgAnon });

    const { rows } = await listGifts(`q=${encodeURIComponent(MARKER)}&limit=200`);
    const row = rows.find((r) => r.id === giftAnon);
    expect(row).toBeDefined(); // matched on RAW name despite masking
    expect(row?.donorKind).toBe("organization");
    expect(row?.donorName).toBe("Anonymous"); // DISPLAY masked
  }, 30_000);

  it("filters by entityId, paymentMethod, and hasStripe", async () => {
    const org = await seedOrg({ label: "Filter Org" });

    const giftCheck = await seedGift({
      organizationId: org,
      paymentMethod: "check",
      dateReceived: "2026-02-10",
    });
    const giftAch = await seedGift({
      organizationId: org,
      paymentMethod: "ach",
      dateReceived: "2026-05-01",
    });
    await seedAllocation(giftAch, ENTITY_ID);

    // Stripe-but-no-QB: the high-priority anomaly. A stripe charge link does NOT
    // count as a QB record, so the gift still surfaces here AND flags hasStripe.
    const giftStripe = await seedGift({ organizationId: org, paymentMethod: "check" });
    await seedCharge(giftStripe);

    // entityId — only the entity-allocated gift, scoped DB-wide by the unique id.
    const byEntity = await listGifts(`entityId=${ENTITY_ID}&limit=200`);
    expect(byEntity.ids.has(giftAch)).toBe(true);
    expect(byEntity.ids.has(giftCheck)).toBe(false);
    const achRow = byEntity.rows.find((r) => r.id === giftAch);
    expect(achRow?.entityId).toBe(ENTITY_ID); // single-entity ⇒ concrete id
    expect(achRow?.entityName).toContain(MARKER);

    // paymentMethod — check vs ach.
    const byMethod = await listGifts(
      `q=${encodeURIComponent(MARKER)}&paymentMethod=check&limit=200`,
    );
    expect(byMethod.ids.has(giftCheck)).toBe(true);
    expect(byMethod.ids.has(giftAch)).toBe(false);

    // hasStripe=true ⇒ only the Stripe-backed anomaly; false ⇒ excludes it.
    const withStripe = await listGifts(
      `q=${encodeURIComponent(MARKER)}&hasStripe=true&limit=200`,
    );
    expect(withStripe.ids.has(giftStripe)).toBe(true);
    expect(withStripe.rows.find((r) => r.id === giftStripe)?.hasStripeEvidence).toBe(true);
    expect(withStripe.ids.has(giftCheck)).toBe(false);

    const withoutStripe = await listGifts(
      `q=${encodeURIComponent(MARKER)}&hasStripe=false&limit=200`,
    );
    expect(withoutStripe.ids.has(giftStripe)).toBe(false);
    expect(withoutStripe.ids.has(giftCheck)).toBe(true);
  }, 30_000);

  it("filters by date window (dateFrom / dateTo)", async () => {
    const org = await seedOrg({ label: "Date Org" });
    const giftEarly = await seedGift({
      organizationId: org,
      dateReceived: "2026-01-05",
      paymentMethod: "wire",
    });
    const giftLate = await seedGift({
      organizationId: org,
      dateReceived: "2026-09-20",
      paymentMethod: "wire",
    });

    const ranged = await listGifts(
      `q=${encodeURIComponent(MARKER)}&dateFrom=2026-08-01&dateTo=2026-12-31&limit=200`,
    );
    expect(ranged.ids.has(giftLate)).toBe(true);
    expect(ranged.ids.has(giftEarly)).toBe(false);
  }, 30_000);

  it("rejects a malformed date with 400 (not a DB 500)", async () => {
    const badFrom = await apiGet(
      `/api/reconciliation/gifts-missing-qb?dateFrom=2026-13-40`,
    );
    expect(badFrom.status).toBe(400);

    const badTo = await apiGet(
      `/api/reconciliation/gifts-missing-qb?dateTo=not-a-date`,
    );
    expect(badTo.status).toBe(400);
  }, 30_000);
});

describe.skipIf(!HAS_DB)("GET /reconciliation/qb-search (integration)", () => {
  it("returns [] without text or amount, and finds the staged row by text and by amount", async () => {
    const staged = await seedStaged({
      label: "QB Search Payer",
      amount: "250.00",
      dateReceived: "2026-03-20",
    });

    // No criteria ⇒ empty (the box only searches once given text/amount).
    const empty = await apiGet(`/api/reconciliation/qb-search`);
    expect(empty.status).toBe(200);
    expect(empty.json.data).toEqual([]);

    // Single char is below the 2-char text threshold ⇒ still empty.
    const tooShort = await apiGet(`/api/reconciliation/qb-search?q=a`);
    expect(tooShort.status).toBe(200);
    expect(tooShort.json.data).toEqual([]);

    // By text.
    const byText = await apiGet(
      `/api/reconciliation/qb-search?q=${encodeURIComponent(MARKER)}&limit=50`,
    );
    expect(byText.status).toBe(200);
    const textIds = (byText.json.data as Array<{ id: string }>).map((c) => c.id);
    expect(textIds).toContain(staged);

    // By amount (generous fee band around 250) — dev has no other QB data.
    const byAmount = await apiGet(`/api/reconciliation/qb-search?amount=250&limit=50`);
    expect(byAmount.status).toBe(200);
    const amountIds = (byAmount.json.data as Array<{ id: string }>).map((c) => c.id);
    expect(amountIds).toContain(staged);

    // Shape: qb candidates carry nodeType + label.
    const card = (byText.json.data as Array<{ id: string; nodeType: string }>).find(
      (c) => c.id === staged,
    );
    expect(card?.nodeType).toBe("qb");
  }, 30_000);

  it("rejects a malformed date with 400 (not a DB 500)", async () => {
    const bad = await apiGet(`/api/reconciliation/qb-search?date=2026-13-40`);
    expect(bad.status).toBe(400);
  }, 30_000);
});
