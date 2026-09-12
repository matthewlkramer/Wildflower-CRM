import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `enrichment_${Date.now()}`;
const OWNER_ID = `${RUN}_owner`;
const OTHER_ID = `${RUN}_other`;
const PERSON_ID = `${RUN}_person`;
const ORGANIZATION_ID = `${RUN}_organization`;
const REGION_ID = `${RUN}_region`;
const PERSON_ADDRESS_ID = `${RUN}_person_address`;
const ORGANIZATION_ADDRESS_ID = `${RUN}_organization_address`;

const auth = vi.hoisted(() => ({
  current: null as { id: string; role: string } | null,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!auth.current) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.appUser = auth.current;
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

type DbModule = typeof import("@workspace/db");
let db: DbModule["db"];
let schema: DbModule;
let drizzle: typeof import("drizzle-orm");
let server: Server;
let baseUrl = "";

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { status: response.status, json: await response.json() };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  drizzle = await import("drizzle-orm");
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
  ]);
  await db.insert(schema.regions).values({
    id: REGION_ID,
    name: `Missoula ${RUN}`,
    displayPath: `Missoula, Montana ${RUN}`,
    type: "city",
    stateAbbreviation: "MT",
  });
  await db.insert(schema.people).values({
    id: PERSON_ID,
    fullName: `Enrichment Person ${RUN}`,
    ownerUserId: OWNER_ID,
  });
  await db.insert(schema.organizations).values({
    id: ORGANIZATION_ID,
    name: `Enrichment Organization ${RUN}`,
    ownerUserId: OWNER_ID,
  });
  await db.insert(schema.addresses).values([
    {
      id: PERSON_ADDRESS_ID,
      personId: PERSON_ID,
      cityRegionId: REGION_ID,
      cityName: "Missoula",
      stateCode: "MT",
      postalCode: "59801",
    },
    {
      id: ORGANIZATION_ADDRESS_ID,
      organizationId: ORGANIZATION_ID,
      cityRegionId: REGION_ID,
      cityName: "Missoula",
      stateCode: "MT",
      postalCode: "59801",
    },
  ]);

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(schema.auditLog)
    .where(
      drizzle.inArray(schema.auditLog.entityId, [PERSON_ID, ORGANIZATION_ID]),
    );
  await db
    .delete(schema.enrichmentSuggestions)
    .where(
      drizzle.inArray(schema.enrichmentSuggestions.entityId, [
        PERSON_ID,
        ORGANIZATION_ID,
      ]),
    );
  await db
    .delete(schema.addresses)
    .where(
      drizzle.inArray(schema.addresses.id, [
        PERSON_ADDRESS_ID,
        ORGANIZATION_ADDRESS_ID,
      ]),
    );
  await db.delete(schema.people).where(drizzle.eq(schema.people.id, PERSON_ID));
  await db
    .delete(schema.organizations)
    .where(drizzle.eq(schema.organizations.id, ORGANIZATION_ID));
  await db
    .delete(schema.regions)
    .where(drizzle.eq(schema.regions.id, REGION_ID));
  await db
    .delete(schema.users)
    .where(drizzle.inArray(schema.users.id, [OWNER_ID, OTHER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("enrichment routes", () => {
  it("requires authentication", async () => {
    auth.current = null;
    expect(
      (await request(`/api/people/${PERSON_ID}/enrichment-suggestions`)).status,
    ).toBe(401);
  });

  it("derives a pending person region without changing the person", async () => {
    auth.current = { id: OWNER_ID, role: "team_member" };
    const result = await request(`/api/people/${PERSON_ID}/enrich`, {
      method: "POST",
    });
    expect(result.status).toBe(200);
    expect(result.json.data).toHaveLength(1);
    expect(result.json.data[0]).toMatchObject({
      entityType: "person",
      fieldName: "currentHomeRegionId",
      status: "pending",
      viewerCanResolve: true,
      suggestedValue: { regionId: REGION_ID },
    });
    const person = await db
      .select({ currentHomeRegionId: schema.people.currentHomeRegionId })
      .from(schema.people)
      .where(drizzle.eq(schema.people.id, PERSON_ID))
      .then((rows) => rows[0]);
    expect(person?.currentHomeRegionId).toBeNull();
  });

  it("rejects non-owner resolution and lets the owner accept atomically", async () => {
    const suggestion = await db
      .select({ id: schema.enrichmentSuggestions.id })
      .from(schema.enrichmentSuggestions)
      .where(
        drizzle.and(
          drizzle.eq(schema.enrichmentSuggestions.entityId, PERSON_ID),
          drizzle.eq(schema.enrichmentSuggestions.status, "pending"),
        ),
      )
      .then((rows) => rows[0]);
    expect(suggestion).toBeTruthy();

    auth.current = { id: OTHER_ID, role: "team_member" };
    expect(
      (
        await request(`/api/enrichment-suggestions/${suggestion!.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "accepted" }),
        })
      ).status,
    ).toBe(403);

    auth.current = { id: OWNER_ID, role: "team_member" };
    const accepted = await request(
      `/api/enrichment-suggestions/${suggestion!.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "accepted" }),
      },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.json.status).toBe("accepted");
    const [person, audit] = await Promise.all([
      db
        .select({ currentHomeRegionId: schema.people.currentHomeRegionId })
        .from(schema.people)
        .where(drizzle.eq(schema.people.id, PERSON_ID))
        .then((rows) => rows[0]),
      db
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(
          drizzle.and(
            drizzle.eq(schema.auditLog.entityId, PERSON_ID),
            drizzle.eq(schema.auditLog.action, "field_enriched"),
          ),
        )
        .then((rows) => rows[0]),
    ]);
    expect(person?.currentHomeRegionId).toBe(REGION_ID);
    expect(audit?.action).toBe("field_enriched");
  });

  it("does not infer funding interests from office location, including old pending suggestions", async () => {
    auth.current = { id: OWNER_ID, role: "team_member" };
    const created = await request(`/api/organizations/${ORGANIZATION_ID}/enrich`, { method: "POST" });
    expect(created.json.data).toEqual([]);
    const suggestionId = `${RUN}_legacy_org_region`;
    await db.insert(schema.enrichmentSuggestions).values({ id: suggestionId, entityType: "organization", entityId: ORGANIZATION_ID,
      fieldName: "regionIds", suggestedValue: { regionId: REGION_ID, label: "Missoula" }, sourceLabel: "Organization address" });
    const accepted = await request(`/api/enrichment-suggestions/${suggestionId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "accepted" }),
    });
    expect(accepted.status).toBe(409);
    expect(accepted.json.error).toBe("funding_interest_evidence_required");
    const dismissed = await request(`/api/enrichment-suggestions/${suggestionId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "dismissed" }),
    });
    expect(dismissed.status).toBe(200);
    expect((await request(`/api/organizations/${ORGANIZATION_ID}/enrich`, { method: "POST" })).json.data).toEqual([]);
  });
});
