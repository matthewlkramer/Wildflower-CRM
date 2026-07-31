import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `giving_relationship_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const PERSON_ID = `${RUN}_person`;
const MEMBER_ID = `${RUN}_member`;
const HOUSEHOLD_ID = `${RUN}_household`;
const ORG_ID = `${RUN}_org`;
const PI_ID = `${RUN}_pi`;
const DIRECT_GIFT_ID = `${RUN}_direct`;
const MEMBER_GIFT_ID = `${RUN}_member_gift`;
const HOUSEHOLD_GIFT_ID = `${RUN}_household_gift`;
const ORG_GIFT_ID = `${RUN}_org_gift`;

const auth = vi.hoisted(() => ({ current: { id: "", role: "admin" } }));
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

async function get(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: await response.json() };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@example.org`,
    role: "admin",
  });
  await db.insert(schema.households).values({
    id: HOUSEHOLD_ID,
    name: "Giving Relationship Household",
  });
  await db.insert(schema.people).values([
    {
      id: PERSON_ID,
      fullName: "Giving Relationship Person",
      primaryHouseholdId: HOUSEHOLD_ID,
    },
    {
      id: MEMBER_ID,
      fullName: "Giving Relationship Member",
      primaryHouseholdId: HOUSEHOLD_ID,
    },
  ]);
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: "Giving Relationship Organization",
  });
  await db.insert(schema.paymentIntermediaries).values({
    id: PI_ID,
    name: "Giving Relationship DAF",
    type: "daf",
  });
  await db.insert(schema.peopleEntityRoles).values([
    {
      id: `${RUN}_person_principal`,
      personId: PERSON_ID,
      entityType: "organization",
      organizationId: ORG_ID,
      connection: "principal",
      current: "current",
    },
    {
      id: `${RUN}_member_principal`,
      personId: MEMBER_ID,
      entityType: "organization",
      organizationId: ORG_ID,
      connection: "principal",
      current: "current",
    },
  ]);
  await db.insert(schema.giftsAndPayments).values([
    {
      id: DIRECT_GIFT_ID,
      name: "Direct gift",
      amount: "100.00",
      dateReceived: "2026-01-01",
      individualGiverPersonId: PERSON_ID,
    },
    {
      id: MEMBER_GIFT_ID,
      name: "Member gift",
      amount: "50.00",
      dateReceived: "2026-01-02",
      individualGiverPersonId: MEMBER_ID,
    },
    {
      id: HOUSEHOLD_GIFT_ID,
      name: "Household gift",
      amount: "200.00",
      dateReceived: "2026-01-03",
      householdId: HOUSEHOLD_ID,
      paymentIntermediaryId: PI_ID,
    },
    {
      id: ORG_GIFT_ID,
      name: "Organization gift",
      amount: "300.00",
      dateReceived: "2026-01-04",
      organizationId: ORG_ID,
    },
  ]);

  auth.current = { id: USER_ID, role: "admin" };
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
    .delete(schema.giftsAndPayments)
    .where(
      inArray(schema.giftsAndPayments.id, [
        DIRECT_GIFT_ID,
        MEMBER_GIFT_ID,
        HOUSEHOLD_GIFT_ID,
        ORG_GIFT_ID,
      ]),
    );
  await db
    .delete(schema.peopleEntityRoles)
    .where(inArray(schema.peopleEntityRoles.personId, [PERSON_ID, MEMBER_ID]));
  await db
    .delete(schema.people)
    .where(inArray(schema.people.id, [PERSON_ID, MEMBER_ID]));
  await db
    .delete(schema.households)
    .where(eq(schema.households.id, HOUSEHOLD_ID));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, ORG_ID));
  await db
    .delete(schema.paymentIntermediaries)
    .where(eq(schema.paymentIntermediaries.id, PI_ID));
  await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("giving relationship", () => {
  it("separates direct, household, and principal-organization giving for a person", async () => {
    const result = await get(
      `/api/giving-relationships/individual/${PERSON_ID}`,
    );
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      relationshipTotal: "600.00",
      donorOfRecordTotal: "100.00",
      throughIntermediaryTotal: "200.00",
      giftCount: 3,
      resolvedDonor: { kind: "household", id: HOUSEHOLD_ID },
    });
    expect(
      Object.fromEntries(
        result.json.breakdown.map((item: { kind: string; amount: string }) => [
          item.kind,
          item.amount,
        ]),
      ),
    ).toEqual({
      direct: "100.00",
      household: "200.00",
      principal_organization: "300.00",
    });
  });

  it("includes member giving and deduplicates shared principal organizations for a household", async () => {
    const result = await get(
      `/api/giving-relationships/household/${HOUSEHOLD_ID}`,
    );
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      relationshipTotal: "650.00",
      donorOfRecordTotal: "200.00",
      throughIntermediaryTotal: "200.00",
      giftCount: 4,
    });
    expect(
      Object.fromEntries(
        result.json.breakdown.map((item: { kind: string; amount: string }) => [
          item.kind,
          item.amount,
        ]),
      ),
    ).toEqual({
      direct: "200.00",
      household_member: "150.00",
      principal_organization: "300.00",
    });
    expect(
      result.json.recentGifts.filter(
        (gift: { id: string }) => gift.id === ORG_GIFT_ID,
      ),
    ).toHaveLength(1);
  });

  it("shows only donor-of-record giving for an organization", async () => {
    const result = await get(
      `/api/giving-relationships/organization/${ORG_ID}`,
    );
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      relationshipTotal: "300.00",
      donorOfRecordTotal: "300.00",
      giftCount: 1,
    });
  });
});
