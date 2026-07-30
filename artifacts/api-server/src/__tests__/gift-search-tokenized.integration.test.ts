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
// The connector word "and" is exactly what the typed search omits.
const HH_NAME = `Alicia ${RUN} and Roberto Cul${RUN}`;

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

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    households: dbMod.households,
    giftsAndPayments: dbMod.giftsAndPayments,
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
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
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
});
