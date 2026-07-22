import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Guard: unnamed placeholder accounts never appear in owner pickers.
 *
 * GET /api/users (the picker path, no ?includeArchived) must exclude:
 *   - archived users, and
 *   - "no usable identity" accounts: a leftover `<clerkId>@unknown.com`
 *     placeholder email with NO first/last/display name.
 * A placeholder-email account that DOES carry any name is still usable and
 * must stay visible; ?includeArchived=true (admin archive screen) sees all.
 *
 * Only the Clerk auth gate is mocked. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `ownerpickspec_${Date.now()}`;
const NAMED_ID = `${RUN}_named`;
const PLACEHOLDER_ID = `${RUN}_placeholder`;
const PLACEHOLDER_NAMED_ID = `${RUN}_placeholder_named`;
const ARCHIVED_ID = `${RUN}_archived`;
const ALL_IDS = [NAMED_ID, PLACEHOLDER_ID, PLACEHOLDER_NAMED_ID, ARCHIVED_ID];

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
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function listUsers(includeArchived = false): Promise<string[]> {
  const res = await fetch(
    `${baseUrl}/api/users${includeArchived ? "?includeArchived=true" : ""}`,
  );
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  usersTable = dbMod.users;
  inArrayFn = drizzle.inArray;

  await db.insert(usersTable).values([
    {
      id: NAMED_ID,
      clerkId: `clerk_${NAMED_ID}`,
      email: `${NAMED_ID}@wildflowerschools.org`,
      firstName: "Named",
      lastName: "User",
      role: "team_member",
    },
    {
      // Placeholder email + no name at all → never assignable.
      id: PLACEHOLDER_ID,
      clerkId: `clerk_${PLACEHOLDER_ID}`,
      email: `clerk_${PLACEHOLDER_ID}@unknown.com`,
      role: "team_member",
    },
    {
      // Placeholder email BUT has a display name → still usable identity.
      id: PLACEHOLDER_NAMED_ID,
      clerkId: `clerk_${PLACEHOLDER_NAMED_ID}`,
      email: `clerk_${PLACEHOLDER_NAMED_ID}@unknown.com`,
      displayName: "Recovered Placeholder",
      role: "team_member",
    },
    {
      id: ARCHIVED_ID,
      clerkId: `clerk_${ARCHIVED_ID}`,
      email: `${ARCHIVED_ID}@wildflowerschools.org`,
      firstName: "Archived",
      role: "team_member",
      archivedAt: new Date(),
    },
  ]);

  auth.current = { id: NAMED_ID, role: "team_member" };
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
  await db.delete(usersTable).where(inArrayFn(usersTable.id, ALL_IDS));
}, 60_000);

describe.skipIf(!HAS_DB)("owner picker user list", () => {
  it("default (picker) list excludes unnamed placeholder and archived accounts", async () => {
    const ids = await listUsers();
    expect(ids).toContain(NAMED_ID);
    expect(ids).toContain(PLACEHOLDER_NAMED_ID);
    expect(ids).not.toContain(PLACEHOLDER_ID);
    expect(ids).not.toContain(ARCHIVED_ID);
  }, 30_000);

  it("includeArchived=true (admin archive screen) still sees everything", async () => {
    const ids = await listUsers(true);
    for (const id of ALL_IDS) expect(ids).toContain(id);
  }, 30_000);
});
