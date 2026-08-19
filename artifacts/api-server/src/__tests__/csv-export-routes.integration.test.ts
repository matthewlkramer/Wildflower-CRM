import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the CSV list-export endpoints. Seeds one
 * anonymous org (owned by a team member) + one plain org, then downloads
 * /api/organizations/export.csv as different viewers to prove:
 *   - the export honors the same filters as the JSON list (search)
 *   - anonymous masking matches the JSON list (non-owner sees "Anonymous")
 *   - `fields` narrows the columns; unknown keys (actions) are dropped
 *   - formula-leading names are neutralized with a leading quote
 *   - archived rows are excluded unless an admin asks for them
 * Only the Clerk auth gate is mocked (mutable viewer), matching the other
 * route-level integration suites. Skips when no real DATABASE_URL exists.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `csvexp_${Date.now()}`;
const OWNER_ID = `${RUN}_owner`;
const OTHER_ID = `${RUN}_other`;
const ADMIN_ID = `${RUN}_admin`;
const ANON_ORG_ID = `${RUN}_anonorg`;
const FORMULA_ORG_ID = `${RUN}_formulaorg`;
const ARCHIVED_ORG_ID = `${RUN}_archivedorg`;
const REAL_ORG_NAME = `Secret Csv Foundation ${RUN}`;
const FORMULA_ORG_NAME = `=HYPERLINK() ${RUN}`;
const ARCHIVED_ORG_NAME = `Archived Csv Org ${RUN}`;

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
let schema: { users: Db["users"]; organizations: Db["organizations"] };
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function getCsv(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, res, text };
}

function parseCsv(text: string): string[][] {
  // Good enough for these fixtures: strips BOM, splits CRLF rows, then
  // splits unquoted/quoted cells naively (no embedded newlines seeded).
  return text
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .filter((l) => l.length > 0)
    .map((line) =>
      line
        .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"')),
    );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = { users: dbMod.users, organizations: dbMod.organizations };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values([
    {
      id: OWNER_ID,
      clerkId: `clerk_${OWNER_ID}`,
      email: `${OWNER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
    {
      id: OTHER_ID,
      clerkId: `clerk_${OTHER_ID}`,
      email: `${OTHER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
  ]);
  await db.insert(schema.organizations).values([
    {
      id: ANON_ORG_ID,
      name: REAL_ORG_NAME,
      anonymous: true,
      ownerUserId: OWNER_ID,
    },
    { id: FORMULA_ORG_ID, name: FORMULA_ORG_NAME },
    {
      id: ARCHIVED_ORG_ID,
      name: ARCHIVED_ORG_NAME,
      archivedAt: new Date(),
    },
  ]);

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
    .delete(schema.organizations)
    .where(
      inArrayFn(schema.organizations.id, [
        ANON_ORG_ID,
        FORMULA_ORG_ID,
        ARCHIVED_ORG_ID,
      ]),
    );
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [OWNER_ID, OTHER_ID, ADMIN_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("organizations CSV export", () => {
  it("serves a CSV attachment honoring the list search filter", async () => {
    auth.current = { id: OWNER_ID, role: "team_member" };
    const { status, res, text } = await getCsv(
      `/api/organizations/export.csv?search=${encodeURIComponent(RUN)}`,
    );
    expect(status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="organizations-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const rows = parseCsv(text);
    expect(rows[0][0]).toBe("Name");
    const names = rows.slice(1).map((r) => r[0]);
    // Owner sees the real anonymous-org name; archived org is excluded.
    expect(names).toContain(REAL_ORG_NAME);
    expect(names).not.toContain(ARCHIVED_ORG_NAME);
  }, 30_000);

  it("masks anonymous org names for non-owner non-admin viewers (UI parity)", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    const { text } = await getCsv(
      `/api/organizations/export.csv?search=${encodeURIComponent(RUN)}&fields=name`,
    );
    const names = parseCsv(text)
      .slice(1)
      .map((r) => r[0]);
    expect(names).not.toContain(REAL_ORG_NAME);
    expect(names).toContain("Anonymous");
  }, 30_000);

  it("narrows columns via fields (dropping unknown keys) and neutralizes formulas", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { text } = await getCsv(
      `/api/organizations/export.csv?search=${encodeURIComponent(RUN)}&fields=name,owner,actions`,
    );
    const rows = parseCsv(text);
    expect(rows[0]).toEqual(["Name", "Owner"]);
    const names = rows.slice(1).map((r) => r[0]);
    expect(names).toContain(`'${FORMULA_ORG_NAME}`);
  }, 30_000);

  it("includes archived rows only when an admin requests them", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { text: withArchived } = await getCsv(
      `/api/organizations/export.csv?search=${encodeURIComponent(RUN)}&includeArchived=true&fields=name`,
    );
    expect(withArchived).toContain(ARCHIVED_ORG_NAME);

    // Non-admins never see archived rows even if they ask.
    auth.current = { id: OTHER_ID, role: "team_member" };
    const { text: nonAdmin } = await getCsv(
      `/api/organizations/export.csv?search=${encodeURIComponent(RUN)}&includeArchived=true&fields=name`,
    );
    expect(nonAdmin).not.toContain(ARCHIVED_ORG_NAME);
  }, 30_000);

  it("rejects invalid list query params like the JSON list", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status } = await getCsv(
      `/api/organizations/export.csv?lifetimeGivingPresence=banana`,
    );
    expect(status).toBe(400);
  }, 30_000);
});
