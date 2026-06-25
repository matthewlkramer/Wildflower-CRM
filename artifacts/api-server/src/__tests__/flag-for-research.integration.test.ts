import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Coverage for POST /cleanup-queue (flagForResearch) — the in-app "Flag for
 * research" action that lets fundraisers add a record to the Cleanup Queue with
 * reason_code='needs_research'.
 *
 * Asserts:
 *   - flagging a fresh record creates an open needs_research item (201)
 *   - re-flagging the SAME record is idempotent against the
 *     (target_type, target_id, reason_code) unique key — returns the existing
 *     item (200) with the SAME id, never a duplicate
 *   - a blank note is rejected (400)
 *
 * Only the Clerk auth gate (requireAuth) is mocked. Skips when no real
 * DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `flagspec_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const ORG_ID = `${RUN}_org`;
const OPP_ID = `${RUN}_opp`;
const CLEANUP_ID = `cleanup_nr_${OPP_ID}`;

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
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  cleanupQueue: Db["cleanupQueue"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

type CleanupItem = {
  id: string;
  targetType: string;
  targetId: string;
  reasonCode: string;
  note: string;
  status: string;
};

async function flag(
  body: unknown,
): Promise<{ status: number; json: CleanupItem }> {
  const res = await fetch(`${baseUrl}/api/cleanup-queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as CleanupItem };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    cleanupQueue: dbMod.cleanupQueue,
  };
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "team_member",
  });
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `Flag Org ${RUN}` });
  await db
    .insert(schema.opportunitiesAndPledges)
    .values({ id: OPP_ID, name: `Flag Opp ${RUN}`, organizationId: ORG_ID });

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
    .delete(schema.cleanupQueue)
    .where(eqFn(schema.cleanupQueue.id, CLEANUP_ID));
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, OPP_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
}, 60_000);

beforeEach(() => {
  auth.current = { id: USER_ID, role: "team_member" };
});

describe.skipIf(!HAS_DB)("POST /cleanup-queue (flag for research)", () => {
  it("creates an open needs_research item for a fresh record (201)", async () => {
    const { status, json } = await flag({
      targetType: "opportunity",
      targetId: OPP_ID,
      note: "Looks like a duplicate import — research before working.",
    });
    expect(status).toBe(201);
    expect(json.id).toBe(CLEANUP_ID);
    expect(json.targetType).toBe("opportunity");
    expect(json.targetId).toBe(OPP_ID);
    expect(json.reasonCode).toBe("needs_research");
    expect(json.status).toBe("open");
  });

  it("is idempotent — re-flagging returns the existing item (200), no duplicate", async () => {
    const { status, json } = await flag({
      targetType: "opportunity",
      targetId: OPP_ID,
      note: "A different note that must NOT overwrite the original.",
    });
    expect(status).toBe(200);
    expect(json.id).toBe(CLEANUP_ID);
    // Original note preserved (the second flag is a no-op).
    expect(json.note).toBe(
      "Looks like a duplicate import — research before working.",
    );

    const rows = await db
      .select({ id: schema.cleanupQueue.id })
      .from(schema.cleanupQueue)
      .where(eqFn(schema.cleanupQueue.targetId, OPP_ID));
    expect(rows.length).toBe(1);
  });

  it("rejects a blank note (400)", async () => {
    const { status } = await flag({
      targetType: "opportunity",
      targetId: OPP_ID,
      note: "   ",
    });
    expect(status).toBe(400);
  });
});
