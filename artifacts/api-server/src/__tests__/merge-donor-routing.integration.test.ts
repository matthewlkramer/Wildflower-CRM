import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { inArray } from "drizzle-orm";

/**
 * Behavioral coverage for the donor_routing_preferences special-casing inside
 * mergeEntity (steps 1.5 and 2.5):
 *   - source preferences among primary + losers collapse to ONE survivor
 *     (primary's own preference wins, else the most recently updated), so the
 *     partial unique source index can never be violated by the FK repoint;
 *   - a preference that becomes self-targeting after the repoint is rewritten
 *     to mode 'self' with all target fields NULL, so the gift-insert routing
 *     trigger never sees a one-hop cycle.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `mergeroute_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const P1 = `${RUN}_p1`; // primary with own pref
const P2 = `${RUN}_p2`; // loser with competing pref
const P3 = `${RUN}_p3`; // primary without pref
const P4 = `${RUN}_p4`; // loser whose pref targets P3
const P5 = `${RUN}_p5`; // primary without pref
const P6 = `${RUN}_p6`; // loser, older pref
const P7 = `${RUN}_p7`; // loser, newer pref
const ORG_A = `${RUN}_org_a`;
const ORG_B = `${RUN}_org_b`;
const ALL_PEOPLE = [P1, P2, P3, P4, P5, P6, P7];

const auth = vi.hoisted(() => ({
  current: { id: "", role: "admin" } as { id: string; role: string },
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
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

let db: (typeof import("@workspace/db"))["db"];
let schema: typeof import("@workspace/db");
let server: Server;
let baseUrl = "";

async function mergePeople(primaryId: string, mergeIds: string[]) {
  const response = await fetch(`${baseUrl}/api/people/merge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ primaryId, mergeIds }),
  });
  return { status: response.status };
}

async function prefsForSources(personIds: string[]) {
  return db
    .select()
    .from(schema.donorRoutingPreferences)
    .where(inArray(schema.donorRoutingPreferences.sourcePersonId, personIds));
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  auth.current = { id: USER_ID, role: "admin" };
  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values([
    { id: ORG_A, name: `${RUN} Org A` },
    { id: ORG_B, name: `${RUN} Org B` },
  ]);
  await db.insert(schema.people).values(
    ALL_PEOPLE.map((id, i) => ({
      id,
      firstName: "Merge",
      lastName: `Routing ${i + 1}`,
      fullName: `Merge Routing ${i + 1}`,
    })),
  );

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolveServer) => {
    const instance = app.listen(0, () => resolveServer(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  await db
    .delete(schema.donorRoutingPreferences)
    .where(
      inArray(schema.donorRoutingPreferences.sourcePersonId, ALL_PEOPLE),
    );
  await db
    .delete(schema.auditLog)
    .where(inArray(schema.auditLog.entityId, ALL_PEOPLE));
  await db.delete(schema.people).where(inArray(schema.people.id, ALL_PEOPLE));
  await db
    .delete(schema.organizations)
    .where(inArray(schema.organizations.id, [ORG_A, ORG_B]));
  await db.delete(schema.users).where(inArray(schema.users.id, [USER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("merge x donor routing preferences", () => {
  it("keeps the primary's own preference and drops the loser's competitor", async () => {
    await db.insert(schema.donorRoutingPreferences).values([
      {
        id: `${RUN}_pref_p1`,
        sourceKind: "individual",
        sourcePersonId: P1,
        mode: "target",
        targetKind: "organization",
        targetOrganizationId: ORG_A,
      },
      {
        id: `${RUN}_pref_p2`,
        sourceKind: "individual",
        sourcePersonId: P2,
        mode: "target",
        targetKind: "organization",
        targetOrganizationId: ORG_B,
      },
    ]);

    const { status } = await mergePeople(P1, [P2]);
    expect(status).toBe(200);

    const prefs = await prefsForSources([P1, P2]);
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({
      id: `${RUN}_pref_p1`,
      sourcePersonId: P1,
      mode: "target",
      targetKind: "organization",
      targetOrganizationId: ORG_A,
    });
  });

  it("normalizes a preference that becomes self-targeting to mode 'self'", async () => {
    await db.insert(schema.donorRoutingPreferences).values({
      id: `${RUN}_pref_p4`,
      sourceKind: "individual",
      sourcePersonId: P4,
      mode: "target",
      targetKind: "individual",
      targetPersonId: P3,
    });

    const { status } = await mergePeople(P3, [P4]);
    expect(status).toBe(200);

    const prefs = await prefsForSources([P3, P4]);
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({
      id: `${RUN}_pref_p4`,
      sourcePersonId: P3,
      mode: "self",
      targetKind: null,
      targetPersonId: null,
      targetHouseholdId: null,
      targetOrganizationId: null,
    });
  });

  it("keeps the most recently updated loser preference when the primary has none", async () => {
    await db.insert(schema.donorRoutingPreferences).values([
      {
        id: `${RUN}_pref_p6`,
        sourceKind: "individual",
        sourcePersonId: P6,
        mode: "target",
        targetKind: "organization",
        targetOrganizationId: ORG_A,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: `${RUN}_pref_p7`,
        sourceKind: "individual",
        sourcePersonId: P7,
        mode: "target",
        targetKind: "organization",
        targetOrganizationId: ORG_B,
        updatedAt: new Date("2026-06-01T00:00:00Z"),
      },
    ]);

    const { status } = await mergePeople(P5, [P6, P7]);
    expect(status).toBe(200);

    const prefs = await prefsForSources([P5, P6, P7]);
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({
      id: `${RUN}_pref_p7`,
      sourcePersonId: P5,
      mode: "target",
      targetKind: "organization",
      targetOrganizationId: ORG_B,
    });
  });
});
