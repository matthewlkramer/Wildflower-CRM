import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Grant Leads dashboard counts.
 *
 * The dashboard card (GrantLeadsCard) shows "new" and "claimed" counts by
 * summing the `pagination.total` of two GET /api/grant-leads?status=… queries
 * with limit=1. This guard locks the invariant that makes those numbers
 * honest against the list the card links to:
 *   - total(status=new) + total(status=claimed) === total(default listing)
 *     (the default listing filter is exactly status IN (new, claimed));
 *   - converted/archived leads are excluded from the default listing but
 *     reachable via ?status=… / ?includeArchived=true.
 *
 * Seeds are scoped with a unique RUN marker via the title `search` filter so
 * pre-existing dev rows can't interfere. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `grantleadspec_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const LEAD_IDS = {
  new: `${RUN}_lead_new`,
  claimed: `${RUN}_lead_claimed`,
  converted: `${RUN}_lead_converted`,
  archived: `${RUN}_lead_archived`,
} as const;

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
let usersTable: Db["users"];
let grantLeadsTable: Db["grantLeads"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

async function fetchLeads(params: Record<string, string>): Promise<{
  total: number;
  ids: string[];
}> {
  const qs = new URLSearchParams({ search: RUN, ...params });
  const res = await fetch(`${baseUrl}/api/grant-leads?${qs.toString()}`);
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    data: Array<{ id: string }>;
    pagination: { total: number };
  };
  return { total: json.pagination.total, ids: json.data.map((d) => d.id) };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  usersTable = dbMod.users;
  grantLeadsTable = dbMod.grantLeads;
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;

  await db.insert(usersTable).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "team_member",
  });
  await db.insert(grantLeadsTable).values(
    (Object.entries(LEAD_IDS) as Array<[keyof typeof LEAD_IDS, string]>).map(
      ([status, id]) => ({
        id,
        dedupeKey: `dedupe_${id}`,
        title: `Lead ${status} ${RUN}`,
        status,
      }),
    ),
  );

  auth.current = { id: USER_ID, role: "team_member" };
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
    .delete(grantLeadsTable)
    .where(inArrayFn(grantLeadsTable.id, Object.values(LEAD_IDS)));
  await db.delete(usersTable).where(eqFn(usersTable.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("grant leads dashboard counts", () => {
  it("per-status totals match the seeded rows (limit=1 card pattern)", async () => {
    for (const status of ["new", "claimed", "converted", "archived"] as const) {
      const { total } = await fetchLeads({ status, limit: "1" });
      expect(total, `status=${status}`).toBe(1);
    }
  }, 30_000);

  it("card sum (new + claimed) equals the default listing total", async () => {
    const [newLeads, claimed, defaults] = await Promise.all([
      fetchLeads({ status: "new", limit: "1" }),
      fetchLeads({ status: "claimed", limit: "1" }),
      fetchLeads({ limit: "50" }),
    ]);
    expect(newLeads.total + claimed.total).toBe(defaults.total);
    expect(defaults.ids.sort()).toEqual(
      [LEAD_IDS.new, LEAD_IDS.claimed].sort(),
    );
  }, 30_000);

  it("includeArchived=true widens the listing to all statuses", async () => {
    const { total, ids } = await fetchLeads({
      includeArchived: "true",
      limit: "50",
    });
    expect(total).toBe(4);
    expect(ids.sort()).toEqual(Object.values(LEAD_IDS).sort());
  }, 30_000);
});
