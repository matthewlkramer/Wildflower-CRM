import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for individual gift SOFT-CREDIT (Task #387). A person's
 * Lifetime giving / Last gift now also include an ORGANIZATION's gift when the
 * person is that gift's primary contact, its advisor, OR a *current principal*
 * of the donor organization — folded into the single blended number (no
 * separate "credited giving" line).
 *
 * Invariants asserted here:
 *  - Org-credit applies only to organization-donor gifts, so it never
 *    double-counts a person's own direct / household giving.
 *  - The three signals (primary contact / advisor / current principal) are
 *    OR-combined: a gift matching several of them is counted exactly once.
 *  - Archived gifts are excluded from all paths.
 *  - A plain direct/household-only person is unchanged.
 *  - The dashboard "Top priorities" person cards match the person page.
 *
 * Hits the real route handlers against the dev Postgres so the correlated
 * subquery SQL is actually exercised. Only the Clerk auth gate is mocked.
 * Skips automatically when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `soft_credit_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));

const RUN = `sc_${Date.now()}`;

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  people: Db["people"];
  households: Db["households"];
  peopleEntityRoles: Db["peopleEntityRoles"];
  giftsAndPayments: Db["giftsAndPayments"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

let gen = 0;
function nextId(label: string): string {
  gen += 1;
  return `${RUN}_${label}_${String(gen).padStart(3, "0")}`;
}

const seededGiftIds: string[] = [];
const seededRoleIds: string[] = [];
const seededPersonIds: string[] = [];
const seededOrgIds: string[] = [];
const seededHouseholdIds: string[] = [];

async function seedPerson(label: string): Promise<string> {
  const id = nextId(`person_${label}`);
  await db.insert(schema.people).values({
    id,
    firstName: label,
    lastName: RUN,
    fullName: `${label} ${RUN}`,
    priority: "top",
  });
  seededPersonIds.push(id);
  return id;
}

async function seedOrg(label: string): Promise<string> {
  const id = nextId(`org_${label}`);
  await db.insert(schema.organizations).values({ id, name: `${label} ${RUN}` });
  seededOrgIds.push(id);
  return id;
}

async function seedHousehold(label: string): Promise<string> {
  const id = nextId(`hh_${label}`);
  await db.insert(schema.households).values({ id, name: `${label} ${RUN}` });
  seededHouseholdIds.push(id);
  return id;
}

async function seedPrincipalRole(personId: string, orgId: string): Promise<void> {
  const id = nextId("role");
  await db.insert(schema.peopleEntityRoles).values({
    id,
    personId,
    entityType: "organization",
    organizationId: orgId,
    connection: "principal",
    current: "current",
  });
  seededRoleIds.push(id);
}

async function seedHouseholdMembership(personId: string, householdId: string): Promise<void> {
  const id = nextId("role");
  await db.insert(schema.peopleEntityRoles).values({
    id,
    personId,
    entityType: "household",
    householdId,
    current: "current",
  });
  seededRoleIds.push(id);
}

type GiftOpts = {
  amount: string;
  dateReceived: string;
  organizationId?: string;
  individualGiverPersonId?: string;
  householdId?: string;
  primaryContactPersonId?: string;
  advisorPersonId?: string;
  archived?: boolean;
};

async function seedGift(o: GiftOpts): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: o.amount,
    dateReceived: o.dateReceived,
    type: "standard_gift",
    organizationId: o.organizationId ?? null,
    individualGiverPersonId: o.individualGiverPersonId ?? null,
    householdId: o.householdId ?? null,
    primaryContactPersonId: o.primaryContactPersonId ?? null,
    advisorPersonId: o.advisorPersonId ?? null,
    archivedAt: o.archived ? new Date() : null,
  });
  seededGiftIds.push(id);
  return id;
}

async function getPerson(id: string): Promise<{
  lifetimeGiving: string | null;
  mostRecentGiftDate: string | null;
}> {
  const res = await fetch(`${baseUrl}/api/people/${id}`);
  const body = await res.json();
  if (res.status !== 200) throw new Error(`person ${res.status}: ${JSON.stringify(body)}`);
  return body as { lifetimeGiving: string | null; mostRecentGiftDate: string | null };
}

async function getTopPriorityPerson(id: string): Promise<{
  lastGiftDate: string | null;
  lastGiftAmount: string | null;
} | undefined> {
  const res = await fetch(`${baseUrl}/api/top-priorities`);
  const body = (await res.json()) as {
    individuals: Array<{
      id: string;
      lastGiftDate: string | null;
      lastGiftAmount: string | null;
    }>;
  };
  if (res.status !== 200) throw new Error(`top-priorities ${res.status}: ${JSON.stringify(body)}`);
  return body.individuals.find((p) => p.id === id);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    people: dbMod.people,
    households: dbMod.households,
    peopleEntityRoles: dbMod.peopleEntityRoles,
    giftsAndPayments: dbMod.giftsAndPayments,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (seededGiftIds.length)
    await db.delete(schema.giftsAndPayments).where(inArrayFn(schema.giftsAndPayments.id, seededGiftIds));
  if (seededRoleIds.length)
    await db.delete(schema.peopleEntityRoles).where(inArrayFn(schema.peopleEntityRoles.id, seededRoleIds));
  if (seededHouseholdIds.length)
    await db.delete(schema.households).where(inArrayFn(schema.households.id, seededHouseholdIds));
  if (seededPersonIds.length)
    await db.delete(schema.people).where(inArrayFn(schema.people.id, seededPersonIds));
  if (seededOrgIds.length)
    await db.delete(schema.organizations).where(inArrayFn(schema.organizations.id, seededOrgIds));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) console.warn("[people-org-soft-credit] skipped: no live DATABASE_URL");
});

describe.skipIf(!HAS_DB)("individual org soft-credit — lifetime giving & last gift", () => {
  it("credits a primary-contact person (Arthur Rock pattern)", async () => {
    const person = await seedPerson("PrimaryContact");
    const org = await seedOrg("ARockCo");
    await seedGift({
      amount: "1000000.00",
      dateReceived: "2024-01-15",
      organizationId: org,
      primaryContactPersonId: person,
    });
    await seedGift({
      amount: "1500000.00",
      dateReceived: "2025-06-25",
      organizationId: org,
      primaryContactPersonId: person,
    });

    const detail = await getPerson(person);
    expect(detail.lifetimeGiving).toBe("2500000.00");
    expect(detail.mostRecentGiftDate).toBe("2025-06-25");

    const card = await getTopPriorityPerson(person);
    expect(card?.lastGiftDate).toBe("2025-06-25");
    expect(card?.lastGiftAmount).toBe("1500000.00");
  });

  it("credits a current principal who is NOT the primary contact (Katherine Bradley pattern)", async () => {
    const principal = await seedPerson("Principal");
    const aide = await seedPerson("Aide");
    const org = await seedOrg("BradleyHoldings");
    await seedPrincipalRole(principal, org);
    // The aide is the primary contact, not the principal.
    await seedGift({
      amount: "750000.00",
      dateReceived: "2023-09-01",
      organizationId: org,
      primaryContactPersonId: aide,
    });

    const detail = await getPerson(principal);
    expect(detail.lifetimeGiving).toBe("750000.00");
    expect(detail.mostRecentGiftDate).toBe("2023-09-01");
  });

  it("credits an advisor on an org gift", async () => {
    const advisor = await seedPerson("Advisor");
    const org = await seedOrg("AdvisedFund");
    await seedGift({
      amount: "42000.00",
      dateReceived: "2022-03-03",
      organizationId: org,
      advisorPersonId: advisor,
    });

    const detail = await getPerson(advisor);
    expect(detail.lifetimeGiving).toBe("42000.00");
    expect(detail.mostRecentGiftDate).toBe("2022-03-03");
  });

  it("counts a gift once when multiple signals overlap", async () => {
    const person = await seedPerson("Overlap");
    const org = await seedOrg("OverlapOrg");
    await seedPrincipalRole(person, org);
    // Same person is primary contact AND advisor AND a current principal.
    await seedGift({
      amount: "300000.00",
      dateReceived: "2024-12-31",
      organizationId: org,
      primaryContactPersonId: person,
      advisorPersonId: person,
    });

    const detail = await getPerson(person);
    expect(detail.lifetimeGiving).toBe("300000.00");
    expect(detail.mostRecentGiftDate).toBe("2024-12-31");
  });

  it("blends direct + household + org-credit into one number, last gift is the latest across all", async () => {
    const person = await seedPerson("Blend");
    const org = await seedOrg("BlendOrg");
    const household = await seedHousehold("BlendHH");
    await seedHouseholdMembership(person, household);
    await seedGift({ amount: "100.00", dateReceived: "2020-01-01", individualGiverPersonId: person });
    await seedGift({ amount: "200.00", dateReceived: "2021-01-01", householdId: household });
    await seedGift({
      amount: "5000.00",
      dateReceived: "2026-02-02",
      organizationId: org,
      primaryContactPersonId: person,
    });

    const detail = await getPerson(person);
    expect(detail.lifetimeGiving).toBe("5300.00");
    expect(detail.mostRecentGiftDate).toBe("2026-02-02");

    const card = await getTopPriorityPerson(person);
    expect(card?.lastGiftDate).toBe("2026-02-02");
    expect(card?.lastGiftAmount).toBe("5000.00");
  });

  it("does not credit an org gift for a non-contact / non-principal / non-advisor person", async () => {
    const stranger = await seedPerson("Stranger");
    const org = await seedOrg("StrangerOrg");
    await seedGift({ amount: "999.00", dateReceived: "2024-05-05", organizationId: org });

    const detail = await getPerson(stranger);
    expect(detail.lifetimeGiving).toBe("0");
    expect(detail.mostRecentGiftDate).toBeNull();
  });

  it("excludes archived org-credit gifts", async () => {
    const person = await seedPerson("ArchiveCase");
    const org = await seedOrg("ArchiveOrg");
    await seedGift({
      amount: "111.00",
      dateReceived: "2024-04-04",
      organizationId: org,
      primaryContactPersonId: person,
    });
    await seedGift({
      amount: "888.00",
      dateReceived: "2025-05-05",
      organizationId: org,
      primaryContactPersonId: person,
      archived: true,
    });

    const detail = await getPerson(person);
    expect(detail.lifetimeGiving).toBe("111.00");
    expect(detail.mostRecentGiftDate).toBe("2024-04-04");
  });

  it("a plain direct/household-only person is unchanged (no org credit applied)", async () => {
    const person = await seedPerson("DirectOnly");
    const household = await seedHousehold("DirectHH");
    await seedHouseholdMembership(person, household);
    await seedGift({ amount: "250.00", dateReceived: "2023-07-07", individualGiverPersonId: person });
    await seedGift({ amount: "750.00", dateReceived: "2024-08-08", householdId: household });

    const detail = await getPerson(person);
    expect(detail.lifetimeGiving).toBe("1000.00");
    expect(detail.mostRecentGiftDate).toBe("2024-08-08");
  });
});
