import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the unified GET /search endpoint (routes/search.ts).
 * Seeds one row per searchable entity — all sharing a unique RUN token in their
 * name so a single query returns exactly the seeded set — then exercises the
 * endpoint as three viewers (owner / admin / other) to assert:
 *   - every entity group returns its seeded hit, ranked, with a numeric score
 *   - anonymous donor names are masked server-side: the org's own label and the
 *     opportunity/gift donor `sublabel` read "Anonymous" for a non-owner
 *     non-admin, but the real name for the owner and admins
 *   - archived rows are excluded for non-admins but visible to admins
 *   - sub-min-length queries short-circuit to empty groups
 *   - donor-join helper alias columns never leak into the response
 *
 * Like the anonymous-masking suite, the only seam mocked is the Clerk auth gate
 * (`requireAuth`), injecting a mutable app user so each test can switch viewers.
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `searchspec_${Date.now()}`;
const OWNER_ID = `${RUN}_owner`;
const OTHER_ID = `${RUN}_other`;
const ADMIN_ID = `${RUN}_admin`;
const ORG_ID = `${RUN}_org`;
const PERSON_ID = `${RUN}_person`;
const HOUSEHOLD_ID = `${RUN}_hh`;
const OPP_ID = `${RUN}_opp`;
const GIFT_ID = `${RUN}_gift`;
const ARCHIVED_PERSON_ID = `${RUN}_archperson`;

const REAL_ORG_NAME = `Secret Foundation ${RUN}`;
const PERSON_NAME = `Pat Person ${RUN}`;
const HOUSEHOLD_NAME = `The Household ${RUN}`;
const OPP_NAME = `Big Opp ${RUN}`;
const GIFT_NAME = `Big Gift ${RUN}`;
const ARCHIVED_PERSON_NAME = `Archived Person ${RUN}`;

const ANON = "Anonymous";

type Hit = {
  type: string;
  id: string;
  label: string;
  sublabel: string | null;
  score: number;
};
type Results = {
  people: Hit[];
  organizations: Hit[];
  households: Hit[];
  opportunities: Hit[];
  gifts: Hit[];
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

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  people: Db["people"];
  households: Db["households"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  giftsAndPayments: Db["giftsAndPayments"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function search(
  q: string,
  extra = "",
): Promise<{ status: number; json: Results }> {
  const res = await fetch(
    `${baseUrl}/api/search?q=${encodeURIComponent(q)}${extra}`,
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as Results };
}

function find(group: Hit[], id: string): Hit | undefined {
  return group.find((h) => h.id === id);
}

function assertHitShape(hit: Hit) {
  // The hit must be a clean projection — no donor-join helper aliases or raw
  // donor-name columns leaking through.
  expect(Object.keys(hit).sort()).toEqual(
    ["id", "label", "score", "sublabel", "type"].sort(),
  );
  expect(typeof hit.score).toBe("number");
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
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    giftsAndPayments: dbMod.giftsAndPayments,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

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
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
  ]);
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: REAL_ORG_NAME,
    anonymous: true,
    ownerUserId: OWNER_ID,
  });
  await db.insert(schema.people).values([
    { id: PERSON_ID, fullName: PERSON_NAME },
    {
      id: ARCHIVED_PERSON_ID,
      fullName: ARCHIVED_PERSON_NAME,
      archivedAt: new Date(),
    },
  ]);
  await db
    .insert(schema.households)
    .values({ id: HOUSEHOLD_ID, name: HOUSEHOLD_NAME });
  await db
    .insert(schema.opportunitiesAndPledges)
    .values({ id: OPP_ID, name: OPP_NAME, organizationId: ORG_ID });
  await db
    .insert(schema.giftsAndPayments)
    .values({ id: GIFT_ID, name: GIFT_NAME, organizationId: ORG_ID });

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
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, OPP_ID));
  await db
    .delete(schema.households)
    .where(eqFn(schema.households.id, HOUSEHOLD_ID));
  await db
    .delete(schema.people)
    .where(inArrayFn(schema.people.id, [PERSON_ID, ARCHIVED_PERSON_ID]));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [OWNER_ID, OTHER_ID, ADMIN_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("unified search", () => {
  it("short-circuits sub-min-length queries to empty groups", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    const { status, json } = await search("a");
    expect(status).toBe(200);
    expect(json.people).toEqual([]);
    expect(json.organizations).toEqual([]);
    expect(json.households).toEqual([]);
    expect(json.opportunities).toEqual([]);
    expect(json.gifts).toEqual([]);
  }, 30_000);

  it("returns one ranked hit per entity group to the owner with real names", async () => {
    auth.current = { id: OWNER_ID, role: "team_member" };
    const { status, json } = await search(RUN);
    expect(status).toBe(200);

    const person = find(json.people, PERSON_ID);
    const org = find(json.organizations, ORG_ID);
    const hh = find(json.households, HOUSEHOLD_ID);
    const opp = find(json.opportunities, OPP_ID);
    const gift = find(json.gifts, GIFT_ID);

    for (const [name, hit] of Object.entries({ person, org, hh, opp, gift })) {
      expect(hit, `${name} present`).toBeDefined();
      assertHitShape(hit!);
    }

    expect(person!.label).toBe(PERSON_NAME);
    expect(person!.type).toBe("person");
    expect(org!.label).toBe(REAL_ORG_NAME);
    expect(org!.type).toBe("organization");
    expect(hh!.label).toBe(HOUSEHOLD_NAME);
    expect(opp!.label).toBe(OPP_NAME);
    // Opportunity/gift donor name surfaces as the sublabel — real for the owner.
    expect(opp!.sublabel).toBe(REAL_ORG_NAME);
    expect(gift!.label).toBe(GIFT_NAME);
    expect(gift!.sublabel).toBe(REAL_ORG_NAME);
  }, 30_000);

  it("masks the anonymous donor name (and the opp/gift title) for a non-owner non-admin", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    const { json } = await search(RUN);

    expect(find(json.organizations, ORG_ID)!.label).toBe(ANON);
    // Donor sublabel is masked...
    expect(find(json.opportunities, OPP_ID)!.sublabel).toBe(ANON);
    expect(find(json.gifts, GIFT_ID)!.sublabel).toBe(ANON);
    // ...and the opp/gift TITLE is masked too, since the title can embed the
    // hidden donor's name (mirrors /top-priorities).
    expect(find(json.opportunities, OPP_ID)!.label).toBe(ANON);
    expect(find(json.gifts, GIFT_ID)!.label).toBe(ANON);
    // Non-anonymous entities are still shown in the clear.
    expect(find(json.people, PERSON_ID)!.label).toBe(PERSON_NAME);
    expect(find(json.households, HOUSEHOLD_ID)!.label).toBe(HOUSEHOLD_NAME);
  }, 30_000);

  it("reveals the real anonymous donor name and opp/gift title to an admin", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { json } = await search(RUN);
    expect(find(json.organizations, ORG_ID)!.label).toBe(REAL_ORG_NAME);
    expect(find(json.opportunities, OPP_ID)!.sublabel).toBe(REAL_ORG_NAME);
    // Donor visible ⇒ the opp/gift title is shown unmasked.
    expect(find(json.opportunities, OPP_ID)!.label).toBe(OPP_NAME);
    expect(find(json.gifts, GIFT_ID)!.label).toBe(GIFT_NAME);
  }, 30_000);

  it("excludes archived rows by default; admins can opt in via includeArchived", async () => {
    // Excluded for a non-admin even with the opt-in flag (admin-only).
    auth.current = { id: OTHER_ID, role: "team_member" };
    const asOther = await search(RUN, "&includeArchived=true");
    expect(find(asOther.json.people, ARCHIVED_PERSON_ID)).toBeUndefined();

    // Excluded for an admin too, until they explicitly ask to include archived.
    auth.current = { id: ADMIN_ID, role: "admin" };
    const adminDefault = await search(RUN);
    expect(find(adminDefault.json.people, ARCHIVED_PERSON_ID)).toBeUndefined();

    const adminOptIn = await search(RUN, "&includeArchived=true");
    expect(find(adminOptIn.json.people, ARCHIVED_PERSON_ID)).toBeDefined();
  }, 30_000);
});
