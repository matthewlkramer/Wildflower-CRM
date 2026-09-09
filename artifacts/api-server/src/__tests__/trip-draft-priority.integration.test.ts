import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `tripdraftspec_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const TRIP_ID = `${RUN}_trip`;
const PERSON_IDS = {
  top: `${RUN}_top`,
  medium: `${RUN}_medium`,
  low: `${RUN}_low`,
  blank: `${RUN}_blank`,
  highOrg: `${RUN}_high_org`,
  lowOrg: `${RUN}_low_org`,
};
const ORGANIZATION_IDS = {
  high: `${RUN}_org_high`,
  low: `${RUN}_org_low`,
};

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

let schema: Db;
let server: Server;
let baseUrl = "";
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  ({ inArray: inArrayFn } = await import("drizzle-orm"));

  await schema.db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    displayName: "Trip Draft Test User",
    role: "team_member",
  });
  await schema.db.insert(schema.organizations).values([
    {
      id: ORGANIZATION_IDS.high,
      name: `${RUN} High Priority Organization`,
      priority: "high",
    },
    {
      id: ORGANIZATION_IDS.low,
      name: `${RUN} Low Priority Organization`,
      priority: "low",
    },
  ]);
  await schema.db.insert(schema.people).values([
    { id: PERSON_IDS.top, fullName: `${RUN} Top`, priority: "top" },
    { id: PERSON_IDS.medium, fullName: `${RUN} Medium`, priority: "medium" },
    { id: PERSON_IDS.low, fullName: `${RUN} Low`, priority: "low" },
    { id: PERSON_IDS.blank, fullName: `${RUN} Blank` },
    {
      id: PERSON_IDS.highOrg,
      fullName: `${RUN} High Organization Contact`,
      priority: "low",
    },
    { id: PERSON_IDS.lowOrg, fullName: `${RUN} Low Organization Contact` },
  ]);
  await schema.db.insert(schema.addresses).values(
    Object.values(PERSON_IDS).map((personId) => ({
      id: `${personId}_address`,
      personId,
      cityName: "Priorityville",
      stateCode: "MN",
    })),
  );
  await schema.db.insert(schema.peopleEntityRoles).values([
    {
      id: `${RUN}_role_high`,
      personId: PERSON_IDS.highOrg,
      entityType: "organization",
      organizationId: ORGANIZATION_IDS.high,
      current: "current",
    },
    {
      id: `${RUN}_role_low`,
      personId: PERSON_IDS.lowOrg,
      entityType: "organization",
      organizationId: ORGANIZATION_IDS.low,
      current: "current",
    },
  ]);
  await schema.db.insert(schema.tripPlans).values({
    id: TRIP_ID,
    travelerUserId: USER_ID,
    createdByUserId: USER_ID,
    destinationCity: "Priorityville",
    destinationState: "MN",
    travelStartsAt: new Date("2026-10-01T14:00:00.000Z"),
    travelEndsAt: new Date("2026-10-01T22:00:00.000Z"),
  });

  auth.current = { id: USER_ID, role: "team_member" };
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB || !schema) return;
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await schema.db
    .delete(schema.tripPlans)
    .where(inArrayFn(schema.tripPlans.id, [TRIP_ID]));
  await schema.db
    .delete(schema.peopleEntityRoles)
    .where(
      inArrayFn(schema.peopleEntityRoles.personId, Object.values(PERSON_IDS)),
    );
  await schema.db
    .delete(schema.people)
    .where(inArrayFn(schema.people.id, Object.values(PERSON_IDS)));
  await schema.db
    .delete(schema.organizations)
    .where(inArrayFn(schema.organizations.id, Object.values(ORGANIZATION_IDS)));
  await schema.db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [USER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("trip CRM draft priority gate", () => {
  it("drafts only medium-or-higher people or contacts of medium-or-higher organizations", async () => {
    const res = await fetch(`${baseUrl}/api/trips/${TRIP_ID}/draft-visits`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      visits: Array<{ personId: string; rationale: string | null }>;
    };
    const draftedIds = detail.visits.map((visit) => visit.personId);

    expect(draftedIds).toEqual([
      PERSON_IDS.top,
      PERSON_IDS.highOrg,
      PERSON_IDS.medium,
    ]);
    expect(draftedIds).not.toContain(PERSON_IDS.low);
    expect(draftedIds).not.toContain(PERSON_IDS.blank);
    expect(draftedIds).not.toContain(PERSON_IDS.lowOrg);
  }, 30_000);
});
