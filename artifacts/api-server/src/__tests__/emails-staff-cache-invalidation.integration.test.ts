import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  loadInternalDomains,
  loadStaffDefaultSuppressedPersonIds,
  invalidateStaffDefaultSuppressionCache,
} from "../lib/emailMatcher";

/**
 * Proves the /emails mutation routes bust the staff-default suppression cache.
 *
 * loadStaffDefaultSuppressedPersonIds() caches its result for 60s. The staff
 * set is derived from person-owned internal-domain emails, so adding, editing,
 * or removing such an email must invalidate that cache immediately — otherwise
 * sync could (mis)attach a freshly-added staff person (or keep suppressing a
 * removed one) for up to a minute.
 *
 * Each case warms the cache (so a stale read would return the wrong set), hits
 * the route, then re-reads WITHOUT a manual invalidate: the only way the read
 * reflects the change within the TTL is if the route invalidated the cache.
 *
 * Mocks only the Clerk auth gate; uses the real DB. Skips with no DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `emailcache_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const P_POST = `${RUN}_ppost`;
const P_DEL = `${RUN}_pdel`;
const P_PATCH = `${RUN}_ppatch`;
const PM_PRIMARY = `${RUN}_pmprimary`;
const PM_LOSER = `${RUN}_pmloser`;
const EMAIL_DEL = `${RUN}_edel`;
const EMAIL_PATCH = `${RUN}_epatch`;
const EMAIL_MERGE = `${RUN}_emerge`;

const POST_ADDR = `post.${RUN}@wildflowerschools.org`;
const DEL_ADDR = `del.${RUN}@wildflowerschools.org`;
const PATCH_ADDR_BEFORE = `patch.${RUN}@outside.org`;
const PATCH_ADDR_AFTER = `patch2.${RUN}@wildflowerschools.org`;
const MERGE_ADDR = `merge.${RUN}@wildflowerschools.org`;

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
let schema: { users: Db["users"]; people: Db["people"]; emails: Db["emails"] };
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";
let postedEmailId = "";

async function isStaff(personId: string): Promise<boolean> {
  const internal = await loadInternalDomains();
  return (await loadStaffDefaultSuppressedPersonIds(internal)).has(personId);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = { users: dbMod.users, people: dbMod.people, emails: dbMod.emails };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "team_member",
  });
  await db.insert(schema.people).values([
    { id: P_POST, fullName: `Post Person ${RUN}` },
    { id: P_DEL, fullName: `Del Person ${RUN}` },
    { id: P_PATCH, fullName: `Patch Person ${RUN}` },
    { id: PM_PRIMARY, fullName: `Merge Primary ${RUN}` },
    { id: PM_LOSER, fullName: `Merge Loser ${RUN}` },
  ]);
  // P_DEL already owns an internal email; P_PATCH owns an external one.
  // PM_LOSER owns an internal email that a merge will re-point to PM_PRIMARY.
  await db.insert(schema.emails).values([
    { id: EMAIL_DEL, email: DEL_ADDR, personId: P_DEL },
    { id: EMAIL_PATCH, email: PATCH_ADDR_BEFORE, personId: P_PATCH },
    { id: EMAIL_MERGE, email: MERGE_ADDR, personId: PM_LOSER },
  ]);

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  auth.current = { id: USER_ID, role: "team_member" };
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  const emailIds = [EMAIL_DEL, EMAIL_PATCH, EMAIL_MERGE];
  if (postedEmailId) emailIds.push(postedEmailId);
  await db.delete(schema.emails).where(inArrayFn(schema.emails.id, emailIds));
  await db
    .delete(schema.people)
    .where(
      inArrayFn(schema.people.id, [
        P_POST,
        P_DEL,
        P_PATCH,
        PM_PRIMARY,
        PM_LOSER,
      ]),
    );
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
  invalidateStaffDefaultSuppressionCache();
}, 60_000);

describe.skipIf(!HAS_DB)("emails route — staff-default cache invalidation", () => {
  it("POST of an internal email busts the cache so the person becomes staff", async () => {
    invalidateStaffDefaultSuppressionCache();
    expect(await isStaff(P_POST)).toBe(false); // warms the cache

    const res = await fetch(`${baseUrl}/api/emails`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: POST_ADDR, personId: P_POST }),
    });
    expect(res.status).toBe(201);
    postedEmailId = ((await res.json()) as { id: string }).id;

    // No manual invalidate — a stale cache would still say "not staff".
    expect(await isStaff(P_POST)).toBe(true);
  }, 30_000);

  it("PATCH from external to internal busts the cache", async () => {
    invalidateStaffDefaultSuppressionCache();
    expect(await isStaff(P_PATCH)).toBe(false); // warms the cache

    const res = await fetch(`${baseUrl}/api/emails/${EMAIL_PATCH}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: PATCH_ADDR_AFTER }),
    });
    expect(res.status).toBe(200);

    expect(await isStaff(P_PATCH)).toBe(true);
  }, 30_000);

  it("DELETE of the internal email busts the cache so the person is no longer staff", async () => {
    invalidateStaffDefaultSuppressionCache();
    expect(await isStaff(P_DEL)).toBe(true); // warms the cache

    const res = await fetch(`${baseUrl}/api/emails/${EMAIL_DEL}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);

    expect(await isStaff(P_DEL)).toBe(false);
  }, 30_000);

  it("person merge (non-emails write path) busts the cache as ownership moves", async () => {
    // The merge route re-points emails.person_id from loser to primary, so the
    // internal-email staff status must move with it. This guards the non-route
    // write path (mergeEntities.ts) so a future email-ownership writer there
    // can't silently bypass the cache.
    auth.current = { id: USER_ID, role: "admin" }; // merge is admin-gated
    invalidateStaffDefaultSuppressionCache();
    expect(await isStaff(PM_LOSER)).toBe(true); // warms the cache
    expect(await isStaff(PM_PRIMARY)).toBe(false);

    const res = await fetch(`${baseUrl}/api/people/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ primaryId: PM_PRIMARY, mergeIds: [PM_LOSER] }),
    });
    expect(res.status).toBe(200);

    // The internal email now belongs to PM_PRIMARY; a stale cache would still
    // report PM_PRIMARY as non-staff.
    expect(await isStaff(PM_PRIMARY)).toBe(true);
  }, 30_000);
});
