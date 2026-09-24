import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `donorpi_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const PERSON_ID = `${RUN}_person`;
const PI_ONE_ID = `${RUN}_pi_one`;
const PI_TWO_ID = `${RUN}_pi_two`;
const HOUSEHOLD_ID = `${RUN}_household`;
const ARCHIVED_HOUSEHOLD_ID = `${RUN}_archived_household`;
const linkIds: string[] = [];

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

async function request(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
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
    firstName: "Donor",
    lastName: "Intermediary",
    fullName: "Donor Intermediary",
  });
  await db.insert(schema.households).values([
    { id: HOUSEHOLD_ID, name: "Active Household" },
    {
      id: ARCHIVED_HOUSEHOLD_ID,
      name: "Archived Household",
      archivedAt: new Date(),
    },
  ]);
  await db.insert(schema.paymentIntermediaries).values([
    { id: PI_ONE_ID, name: "First DAF", type: "daf" },
    { id: PI_TWO_ID, name: "Second DAF", type: "daf" },
  ]);

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolveServer) => {
    const instance = app.listen(0, () => resolveServer(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }
  await db
    .delete(schema.auditLog)
    .where(inArray(schema.auditLog.entityId, [PERSON_ID, ...linkIds]));
  await db
    .delete(schema.donorPaymentIntermediaries)
    .where(
      eq(schema.donorPaymentIntermediaries.individualGiverPersonId, PERSON_ID),
    );
  await db.delete(schema.people).where(eq(schema.people.id, PERSON_ID));
  await db
    .delete(schema.households)
    .where(
      inArray(schema.households.id, [HOUSEHOLD_ID, ARCHIVED_HOUSEHOLD_ID]),
    );
  await db
    .delete(schema.paymentIntermediaries)
    .where(inArray(schema.paymentIntermediaries.id, [PI_ONE_ID, PI_TWO_ID]));
  await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("donor payment intermediaries", () => {
  it("edits primary household independently and rejects archived households", async () => {
    const updated = await request(`/people/${PERSON_ID}`, "PATCH", {
      primaryHouseholdId: HOUSEHOLD_ID,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.primaryHouseholdId).toBe(HOUSEHOLD_ID);

    const rejected = await request(`/people/${PERSON_ID}`, "PATCH", {
      primaryHouseholdId: ARCHIVED_HOUSEHOLD_ID,
    });
    expect(rejected.status).toBe(409);
    const [person] = await db
      .select({ primaryHouseholdId: schema.people.primaryHouseholdId })
      .from(schema.people)
      .where(eq(schema.people.id, PERSON_ID));
    expect(person.primaryHouseholdId).toBe(HOUSEHOLD_ID);
  });

  it("moves the preferred flag, archives reversibly, and rejects archived intermediaries", async () => {
    const first = await request("/donor-payment-intermediaries", "POST", {
      individualGiverPersonId: PERSON_ID,
      paymentIntermediaryId: PI_ONE_ID,
    });
    const second = await request("/donor-payment-intermediaries", "POST", {
      individualGiverPersonId: PERSON_ID,
      paymentIntermediaryId: PI_TWO_ID,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstId = first.json.id as string;
    const secondId = second.json.id as string;
    linkIds.push(firstId, secondId);

    expect(
      (
        await request(`/donor-payment-intermediaries/${firstId}`, "PATCH", {
          isDefault: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/donor-payment-intermediaries/${secondId}`, "PATCH", {
          isDefault: true,
        })
      ).status,
    ).toBe(200);

    const list = await request(
      `/donor-payment-intermediaries?individualGiverPersonId=${PERSON_ID}`,
    );
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({
      effectiveDefaultPaymentIntermediary: { id: PI_TWO_ID },
      effectiveDefaultSource: "source",
    });
    const rows = list.json.data as Array<{
      id: string;
      isDefault: boolean;
    }>;
    expect(rows.find((row) => row.id === firstId)?.isDefault).toBe(false);
    expect(rows.find((row) => row.id === secondId)?.isDefault).toBe(true);

    const archived = await request(
      `/donor-payment-intermediaries/${secondId}/archive`,
      "POST",
    );
    expect(archived.status).toBe(200);
    expect(archived.json).toMatchObject({ id: secondId, isDefault: false });
    expect(archived.json.archivedAt).toBeTruthy();

    const afterArchive = await request(
      `/donor-payment-intermediaries?individualGiverPersonId=${PERSON_ID}`,
    );
    expect(afterArchive.json.effectiveDefaultPaymentIntermediary).toBeNull();
    expect(
      (afterArchive.json.data as Array<{ id: string }>).map((row) => row.id),
    ).not.toContain(secondId);

    const restored = await request("/donor-payment-intermediaries", "POST", {
      individualGiverPersonId: PERSON_ID,
      paymentIntermediaryId: PI_TWO_ID,
    });
    expect(restored.status).toBe(201);
    expect(restored.json).toMatchObject({ id: secondId, archivedAt: null });

    await db
      .update(schema.paymentIntermediaries)
      .set({ archivedAt: new Date() })
      .where(eq(schema.paymentIntermediaries.id, PI_TWO_ID));
    const rejected = await request(
      `/donor-payment-intermediaries/${secondId}`,
      "PATCH",
      { isDefault: true },
    );
    expect(rejected.status).toBe(409);
  });
});
