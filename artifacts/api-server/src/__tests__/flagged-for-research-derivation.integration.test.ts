import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Coverage for the passive "Needs research" badge derivation
 * (`isFlaggedForResearch` -> `flaggedForResearch` response field) on the four
 * detail GET routes:
 *
 *   - GET /api/organizations/:id
 *   - GET /api/people/:id
 *   - GET /api/opportunities-and-pledges/:id
 *   - GET /api/gifts-and-payments/:id
 *
 * Asserts that each detail response returns:
 *   - flaggedForResearch: true  when an OPEN needs_research Cleanup Queue item
 *     targets the record
 *   - flaggedForResearch: false when no such item exists (absent), and after
 *     the item is resolved (open -> resolved flips the flag back to false)
 *
 * Only the Clerk auth gate (requireAuth) is mocked. Skips when no real
 * DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `flagderiv_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const ORG_ID = `${RUN}_org`;
const PERSON_ID = `${RUN}_person`;
const OPP_ID = `${RUN}_opp`;
const GIFT_ID = `${RUN}_gift`;

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
  people: Db["people"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  giftsAndPayments: Db["giftsAndPayments"];
  cleanupQueue: Db["cleanupQueue"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

async function getDetail(
  path: string,
): Promise<{ status: number; json: { flaggedForResearch?: boolean } }> {
  const res = await fetch(`${baseUrl}${path}`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as { flaggedForResearch?: boolean } };
}

async function flag(targetType: string, targetId: string): Promise<string> {
  const id = `cleanup_nr_${targetId}`;
  await db.insert(schema.cleanupQueue).values({
    id,
    targetType,
    targetId,
    reasonCode: "needs_research",
    note: "Needs research before working.",
    status: "open",
  });
  return id;
}

async function resolveFlag(id: string): Promise<void> {
  await db
    .update(schema.cleanupQueue)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(eqFn(schema.cleanupQueue.id, id));
}

// The four detail routes and the record each one targets.
const CASES: Array<{ label: string; path: string; targetType: string; targetId: string }> =
  [
    { label: "organization", path: `/api/organizations/${ORG_ID}`, targetType: "organization", targetId: ORG_ID },
    { label: "person", path: `/api/people/${PERSON_ID}`, targetType: "person", targetId: PERSON_ID },
    { label: "opportunity/pledge", path: `/api/opportunities-and-pledges/${OPP_ID}`, targetType: "opportunity", targetId: OPP_ID },
    { label: "gift", path: `/api/gifts-and-payments/${GIFT_ID}`, targetType: "gift", targetId: GIFT_ID },
  ];

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    people: dbMod.people,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    giftsAndPayments: dbMod.giftsAndPayments,
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
    .values({ id: ORG_ID, name: `Flag Deriv Org ${RUN}` });
  await db
    .insert(schema.people)
    .values({ id: PERSON_ID, fullName: `Flag Deriv Person ${RUN}` });
  await db
    .insert(schema.opportunitiesAndPledges)
    .values({ id: OPP_ID, name: `Flag Deriv Opp ${RUN}`, organizationId: ORG_ID });
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    amount: "250.00",
    dateReceived: "2026-01-15",
    organizationId: ORG_ID,
  });

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
  for (const { targetId } of CASES) {
    await db
      .delete(schema.cleanupQueue)
      .where(eqFn(schema.cleanupQueue.id, `cleanup_nr_${targetId}`));
  }
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, OPP_ID));
  await db.delete(schema.people).where(eqFn(schema.people.id, PERSON_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("flaggedForResearch derivation on detail routes", () => {
  for (const { label, path, targetType, targetId } of CASES) {
    it(`${label}: false when unflagged, true when an open item exists, false after resolve`, async () => {
      // No Cleanup Queue item yet -> badge off.
      const before = await getDetail(path);
      expect(before.status).toBe(200);
      expect(before.json.flaggedForResearch).toBe(false);

      // Flag it (open needs_research item) -> badge on.
      const cleanupId = await flag(targetType, targetId);
      const flagged = await getDetail(path);
      expect(flagged.status).toBe(200);
      expect(flagged.json.flaggedForResearch).toBe(true);

      // Resolve the item (open -> resolved) -> badge off again.
      await resolveFlag(cleanupId);
      const after = await getDetail(path);
      expect(after.status).toBe(200);
      expect(after.json.flaggedForResearch).toBe(false);
    });
  }
});
