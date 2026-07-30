import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `donorroute_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const PERSON_ID = `${RUN}_person`;
const ORG_ID = `${RUN}_org`;
const HOUSEHOLD_ID = `${RUN}_household`;
const PI_ID = `${RUN}_pi`;

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

async function get(kind: string, id: string) {
  const response = await fetch(`${baseUrl}/api/donor-routing/${kind}/${id}`);
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function put(kind: string, id: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/donor-routing/${kind}/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
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
  await db.insert(schema.people).values({
    id: PERSON_ID,
    firstName: "Arthur",
    lastName: "Rock",
    fullName: "Arthur Rock",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: "Arthur Rock & Company",
  });
  await db.insert(schema.households).values({
    id: HOUSEHOLD_ID,
    name: "Rock Household",
  });
  await db.insert(schema.paymentIntermediaries).values({
    id: PI_ID,
    name: "Vanguard Charitable",
    type: "daf",
  });

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
    .delete(schema.auditLog)
    .where(inArray(schema.auditLog.entityId, [PERSON_ID, ORG_ID]));
  await db
    .delete(schema.donorRoutingPreferences)
    .where(eq(schema.donorRoutingPreferences.sourcePersonId, PERSON_ID));
  await db
    .delete(schema.donorRoutingPreferences)
    .where(eq(schema.donorRoutingPreferences.sourceOrganizationId, ORG_ID));
  await db
    .delete(schema.donorPaymentIntermediaries)
    .where(eq(schema.donorPaymentIntermediaries.paymentIntermediaryId, PI_ID));
  await db
    .delete(schema.peopleEntityRoles)
    .where(eq(schema.peopleEntityRoles.personId, PERSON_ID));
  await db.delete(schema.people).where(eq(schema.people.id, PERSON_ID));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, ORG_ID));
  await db
    .delete(schema.households)
    .where(eq(schema.households.id, HOUSEHOLD_ID));
  await db
    .delete(schema.paymentIntermediaries)
    .where(eq(schema.paymentIntermediaries.id, PI_ID));
  await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("preferred donor pathways", () => {
  it("uses the automatic default and falls back to the record itself", async () => {
    const { status, json } = await get("individual", PERSON_ID);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      mode: "automatic",
      requiresDecision: false,
      source: { kind: "individual", id: PERSON_ID, name: "Arthur Rock" },
      resolved: { kind: "individual", id: PERSON_ID, name: "Arthur Rock" },
      path: [{ kind: "individual", id: PERSON_ID, name: "Arthur Rock" }],
      primaryHousehold: null,
      defaultPaymentIntermediary: null,
    });
  });

  it("routes Arthur to his company and saves household and DAF defaults", async () => {
    const { status, json } = await put("individual", PERSON_ID, {
      mode: "target",
      targetKind: "organization",
      targetId: ORG_ID,
      primaryHouseholdId: HOUSEHOLD_ID,
      defaultPaymentIntermediaryId: PI_ID,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      mode: "target",
      target: { kind: "organization", id: ORG_ID },
      resolved: { kind: "organization", id: ORG_ID },
      path: [
        { kind: "individual", id: PERSON_ID },
        { kind: "organization", id: ORG_ID },
      ],
      primaryHousehold: { id: HOUSEHOLD_ID, name: "Rock Household" },
      defaultPaymentIntermediary: {
        id: PI_ID,
        name: "Vanguard Charitable",
        type: "daf",
      },
    });

    const [person] = await db
      .select({ primaryHouseholdId: schema.people.primaryHouseholdId })
      .from(schema.people)
      .where(eq(schema.people.id, PERSON_ID));
    expect(person.primaryHouseholdId).toBe(HOUSEHOLD_ID);

    const roles = await db
      .select()
      .from(schema.peopleEntityRoles)
      .where(eq(schema.peopleEntityRoles.personId, PERSON_ID));
    expect(roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          householdId: HOUSEHOLD_ID,
          current: "current",
        }),
      ]),
    );

    const [defaultPi] = await db
      .select()
      .from(schema.donorPaymentIntermediaries)
      .where(
        eq(schema.donorPaymentIntermediaries.paymentIntermediaryId, PI_ID),
      );
    expect(defaultPi).toMatchObject({
      individualGiverPersonId: PERSON_ID,
      isDefault: true,
    });
  });

  it("rejects a pathway cycle without changing the organization", async () => {
    const { status, json } = await put("organization", ORG_ID, {
      mode: "target",
      targetKind: "individual",
      targetId: PERSON_ID,
      primaryHouseholdId: null,
      defaultPaymentIntermediaryId: null,
    });
    expect(status).toBe(409);
    expect(json.error).toBe("donor_routing_cycle");

    const org = await get("organization", ORG_ID);
    expect(org.status).toBe(200);
    expect(org.json).toMatchObject({
      mode: "automatic",
      resolved: { kind: "organization", id: ORG_ID },
    });
  });

  it("serializes concurrent edits so opposite pointers cannot create a cycle", async () => {
    await put("individual", PERSON_ID, {
      mode: "self",
      targetKind: null,
      targetId: null,
      primaryHouseholdId: HOUSEHOLD_ID,
      defaultPaymentIntermediaryId: PI_ID,
    });
    await put("organization", ORG_ID, {
      mode: "self",
      targetKind: null,
      targetId: null,
      primaryHouseholdId: null,
      defaultPaymentIntermediaryId: null,
    });

    const results = await Promise.all([
      put("individual", PERSON_ID, {
        mode: "target",
        targetKind: "organization",
        targetId: ORG_ID,
        primaryHouseholdId: HOUSEHOLD_ID,
        defaultPaymentIntermediaryId: PI_ID,
      }),
      put("organization", ORG_ID, {
        mode: "target",
        targetKind: "individual",
        targetId: PERSON_ID,
        primaryHouseholdId: null,
        defaultPaymentIntermediaryId: null,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.json.error).toBe(
      "donor_routing_cycle",
    );
  });

  it("supports an explicit ask-each-time pathway", async () => {
    const { status, json } = await put("individual", PERSON_ID, {
      mode: "ask",
      targetKind: null,
      targetId: null,
      primaryHouseholdId: HOUSEHOLD_ID,
      defaultPaymentIntermediaryId: PI_ID,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      mode: "ask",
      resolved: null,
      requiresDecision: true,
      path: [{ kind: "individual", id: PERSON_ID }],
    });
  });
});
