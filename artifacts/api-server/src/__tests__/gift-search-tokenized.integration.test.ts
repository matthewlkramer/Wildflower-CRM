import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

/**
 * DB-backed HTTP coverage for the tokenized free-text search on
 * GET /gifts-and-payments (the broad gift-search dialog used by the
 * reconciliation workbench and the gifts list page).
 *
 * The regression this guards: donor households are commonly named
 * "<person A> and <person B>" ("Nancy Peretsman and Bob Scully"), so a
 * search for the couple WITHOUT the connector word ("Nancy Peretsman Bob
 * Scully") used to match nothing because the whole phrase was treated as one
 * contiguous ILIKE substring. The search now splits the input on whitespace:
 * every word must match at least one searched field (AND across words, OR
 * across fields per word).
 *
 * Only the Clerk auth gate is mocked. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `giftsearchtok_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const HH_ID = `${RUN}_hh`;
const GIFT_ID = `${RUN}_gift`;
const LINKED_GIFT_ID = `${RUN}_linked_gift`;
const PAYMENT_UNIT_ID = `${RUN}_payment_unit`;
const OPP_ID = `${RUN}_opp`;
// The connector word "and" is exactly what the typed search omits.
const HH_NAME = `Alicia ${RUN} and Roberto Cul${RUN}`;
// Mirrors the second real-world regression: "FY26 Nancy Peretsman $200,000"
// not found by "fy26 peretsman" (intervening first name breaks the phrase).
const OPP_NAME = `FY99 Alicia Cul${RUN} $200,000`;

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
  households: Db["households"];
  giftsAndPayments: Db["giftsAndPayments"];
  paymentUnits: Db["paymentUnits"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

async function search(term: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(
    `${baseUrl}/api/gifts-and-payments?search=${encodeURIComponent(term)}&limit=25`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

async function searchUnlinked(
  term: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(
    `${baseUrl}/api/gifts-and-payments?search=${encodeURIComponent(term)}&unlinkedToPaymentUnit=true&limit=25`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

async function searchOpps(
  term: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(
    `${baseUrl}/api/opportunities-and-pledges?search=${encodeURIComponent(term)}&limit=25`,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    households: dbMod.households,
    giftsAndPayments: dbMod.giftsAndPayments,
    paymentUnits: dbMod.paymentUnits,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
  };
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: ADMIN_ID,
    clerkId: `clerk_${ADMIN_ID}`,
    email: `${ADMIN_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.households).values({ id: HH_ID, name: HH_NAME });
  // 2099 date: governing FY has no fiscal_years row → never audit-frozen.
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    name: `Tokenized-search gift ${RUN}`,
    householdId: HH_ID,
    amount: "100.00",
    dateReceived: "2099-01-08",
  });
  await db.insert(schema.giftsAndPayments).values({
    id: LINKED_GIFT_ID,
    name: `Canonical-linked gift ${RUN}`,
    householdId: HH_ID,
    amount: "200.00",
    dateReceived: "2099-01-09",
  });
  // Deliberately no QBO / Stripe / Donorbox source pointer. A manually
  // composed bank payment still owns this gift and therefore makes it linked.
  await db.insert(schema.paymentUnits).values({
    id: PAYMENT_UNIT_ID,
    kind: "other",
    giftId: LINKED_GIFT_ID,
    grossAmount: "200.00",
    netAmount: "200.00",
    receivedDate: "2099-01-09",
  });
  await db.insert(schema.opportunitiesAndPledges).values({
    id: OPP_ID,
    name: OPP_NAME,
    householdId: HH_ID,
  });

  auth.current = { id: ADMIN_ID, role: "admin" };
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(schema.paymentUnits)
    .where(eqFn(schema.paymentUnits.id, PAYMENT_UNIT_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, LINKED_GIFT_ID));
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, OPP_ID));
  await db.delete(schema.households).where(eqFn(schema.households.id, HH_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, ADMIN_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("tokenized gift search", () => {
  it("finds a household-donor gift when the connector word is omitted", async () => {
    // "Alicia <run> Roberto Cul<run>" is NOT a contiguous substring of
    // "Alicia <run> and Roberto Cul<run>" — only tokenized matching finds it.
    const rows = await search(`Alicia ${RUN} Roberto Cul${RUN}`);
    expect(rows.map((r) => r.id)).toContain(GIFT_ID);
  });

  it("finds it regardless of word order", async () => {
    const rows = await search(`Cul${RUN} Alicia`);
    expect(rows.map((r) => r.id)).toContain(GIFT_ID);
  });

  it("still matches the full phrase including the connector word", async () => {
    const rows = await search(HH_NAME);
    expect(rows.map((r) => r.id)).toContain(GIFT_ID);
  });

  it("requires EVERY word to match (AND across words)", async () => {
    const rows = await search(`Alicia ${RUN} zebrafish`);
    expect(rows.map((r) => r.id)).not.toContain(GIFT_ID);
  });

  it("a word may match the gift name while another matches the donor", async () => {
    const rows = await search(`Tokenized-search Roberto`);
    expect(rows.map((r) => r.id)).toContain(GIFT_ID);
  });

  it("marks an already-owned gift in broad search without hiding it", async () => {
    const rows = await search(`Canonical-linked ${RUN}`);
    const linked = rows.find((row) => row.id === LINKED_GIFT_ID);
    expect(linked).toMatchObject({ hasPaymentEvidence: true });
  });

  it("Browse unlinked excludes any gift owned by a payment unit, even without QBO evidence", async () => {
    const rows = await searchUnlinked(RUN);
    expect(rows.map((row) => row.id)).toContain(GIFT_ID);
    expect(rows.map((row) => row.id)).not.toContain(LINKED_GIFT_ID);
  });
});

describe.skipIf(!HAS_DB)("tokenized opportunity/pledge search", () => {
  it("finds a pledge when words skip the intervening first name", async () => {
    // "FY99 Cul<run>" is NOT a contiguous substring of
    // "FY99 Alicia Cul<run> $200,000" — only tokenized matching finds it.
    const rows = await searchOpps(`FY99 Cul${RUN}`);
    expect(rows.map((r) => r.id)).toContain(OPP_ID);
  });

  it("a word may match the pledge name while another matches the household", async () => {
    // "Roberto" appears only in the household name, "FY99" only in the
    // pledge name.
    const rows = await searchOpps(`FY99 Roberto Cul${RUN}`);
    expect(rows.map((r) => r.id)).toContain(OPP_ID);
  });

  it("requires EVERY word to match (AND across words)", async () => {
    const rows = await searchOpps(`FY99 Cul${RUN} zebrafish`);
    expect(rows.map((r) => r.id)).not.toContain(OPP_ID);
  });
});
