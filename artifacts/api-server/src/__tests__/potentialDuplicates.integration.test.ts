import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the admin-only potential-duplicates queue
 * (routes/potentialDuplicates.ts) and the admin gate now guarding the two
 * entity-merge endpoints.
 *
 * The detection endpoint has NO query filter — it scans the whole table — so to
 * stay deterministic against the populated dev DB we seed pairs with IDENTICAL
 * names AND a shared phone. That yields the maximum possible score (name 1.0 +
 * phone bonus 0.5 = 1.5), so the seeded pairs rank at the very top and are
 * located by id within a max-limit response.
 *
 * Asserts:
 *   - non-admins get 403 on the list, the dismiss, and BOTH merge endpoints
 *   - an admin sees the seeded pair ranked, with both `name` and `phone`
 *     signals, a clean side projection, and enrichment (primaryEmail / giftCount)
 *   - archived records never surface as a duplicate side
 *   - dismissing a pair (with reversed idA/idB, to exercise canonicalization)
 *     removes it from results, and re-dismissing is an idempotent 204
 *   - person pairs work the same way
 *
 * Only the Clerk auth gate (`requireAuth`) is mocked, injecting a mutable app
 * user so each test can switch viewer/role. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `dupspec_${Date.now()}`;
const OWNER_ID = `${RUN}_owner`;
const OTHER_ID = `${RUN}_other`;
const ADMIN_ID = `${RUN}_admin`;

const ORG_P1 = `${RUN}_orgp1`;
const ORG_P2 = `${RUN}_orgp2`;
const ORG_P3_ARCHIVED = `${RUN}_orgp3`;
const ORG_D1 = `${RUN}_orgd1`;
const ORG_D2 = `${RUN}_orgd2`;
const PERSON_1 = `${RUN}_person1`;
const PERSON_2 = `${RUN}_person2`;

const GIFT_ENR = `${RUN}_gift`;
const EMAIL_P1 = `${RUN}_email`;
const PH_P1 = `${RUN}_php1`;
const PH_P2 = `${RUN}_php2`;
const PH_D1 = `${RUN}_phd1`;
const PH_D2 = `${RUN}_phd2`;
const PH_PE1 = `${RUN}_phpe1`;
const PH_PE2 = `${RUN}_phpe2`;

const DUP_ORG_NAME = `Dup Org ${RUN}`;
const DISMISS_ORG_NAME = `Dismiss Org ${RUN}`;
const DUP_PERSON_NAME = `Dup Person ${RUN}`;

const PHONE_P = "+1 (555) 010-1111";
const PHONE_D = "+1 (555) 010-2222";
const PHONE_PE = "+1 (555) 010-3333";
const PRIMARY_EMAIL = `${RUN}@example.org`;

type Side = {
  id: string;
  name: string;
  ownerName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  createdAt: string | null;
  giftCount: number;
};
type Pair = {
  type: string;
  score: number;
  signals: string[];
  a: Side;
  b: Side;
};
type PairList = { pairs: Pair[] };

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
  phoneNumbers: Db["phoneNumbers"];
  emails: Db["emails"];
  giftsAndPayments: Db["giftsAndPayments"];
  duplicateDismissals: Db["duplicateDismissals"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function listDup(
  type: "organization" | "person",
  extra = "",
): Promise<{ status: number; json: PairList }> {
  const res = await fetch(
    `${baseUrl}/api/potential-duplicates?type=${type}&limit=200${extra}`,
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as PairList };
}

async function dismiss(body: unknown): Promise<number> {
  const res = await fetch(`${baseUrl}/api/potential-duplicates/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function postMerge(path: string, body: unknown): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status;
}

function findPair(pairs: Pair[], id1: string, id2: string): Pair | undefined {
  return pairs.find(
    (p) =>
      (p.a.id === id1 && p.b.id === id2) ||
      (p.a.id === id2 && p.b.id === id1),
  );
}

function sideOf(pair: Pair, id: string): Side {
  return pair.a.id === id ? pair.a : pair.b;
}

function assertSideShape(side: Side) {
  expect(Object.keys(side).sort()).toEqual(
    [
      "createdAt",
      "giftCount",
      "id",
      "name",
      "ownerName",
      "primaryEmail",
      "primaryPhone",
    ].sort(),
  );
  expect(typeof side.giftCount).toBe("number");
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
    phoneNumbers: dbMod.phoneNumbers,
    emails: dbMod.emails,
    giftsAndPayments: dbMod.giftsAndPayments,
    duplicateDismissals: dbMod.duplicateDismissals,
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

  await db.insert(schema.organizations).values([
    { id: ORG_P1, name: DUP_ORG_NAME, ownerUserId: OWNER_ID },
    { id: ORG_P2, name: DUP_ORG_NAME, ownerUserId: OWNER_ID },
    // Same name as the P pair but archived ⇒ must never surface.
    { id: ORG_P3_ARCHIVED, name: DUP_ORG_NAME, archivedAt: new Date() },
    { id: ORG_D1, name: DISMISS_ORG_NAME },
    { id: ORG_D2, name: DISMISS_ORG_NAME },
  ]);

  await db.insert(schema.people).values([
    { id: PERSON_1, fullName: DUP_PERSON_NAME },
    { id: PERSON_2, fullName: DUP_PERSON_NAME },
  ]);

  await db.insert(schema.phoneNumbers).values([
    { id: PH_P1, phoneNumber: PHONE_P, organizationId: ORG_P1 },
    { id: PH_P2, phoneNumber: PHONE_P, organizationId: ORG_P2 },
    { id: PH_D1, phoneNumber: PHONE_D, organizationId: ORG_D1 },
    { id: PH_D2, phoneNumber: PHONE_D, organizationId: ORG_D2 },
    { id: PH_PE1, phoneNumber: PHONE_PE, personId: PERSON_1 },
    { id: PH_PE2, phoneNumber: PHONE_PE, personId: PERSON_2 },
  ]);

  await db.insert(schema.emails).values({
    id: EMAIL_P1,
    email: PRIMARY_EMAIL,
    organizationId: ORG_P1,
    isPreferred: true,
  });

  await db
    .insert(schema.giftsAndPayments)
    .values({ id: GIFT_ENR, name: `Gift ${RUN}`, organizationId: ORG_P1 });

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
  await db
    .delete(schema.duplicateDismissals)
    .where(
      inArrayFn(schema.duplicateDismissals.idA, [
        ORG_D1,
        ORG_D2,
        ORG_P1,
        ORG_P2,
      ]),
    );
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ENR));
  await db
    .delete(schema.phoneNumbers)
    .where(
      inArrayFn(schema.phoneNumbers.id, [
        PH_P1,
        PH_P2,
        PH_D1,
        PH_D2,
        PH_PE1,
        PH_PE2,
      ]),
    );
  await db.delete(schema.emails).where(eqFn(schema.emails.id, EMAIL_P1));
  await db
    .delete(schema.people)
    .where(inArrayFn(schema.people.id, [PERSON_1, PERSON_2]));
  await db
    .delete(schema.organizations)
    .where(
      inArrayFn(schema.organizations.id, [
        ORG_P1,
        ORG_P2,
        ORG_P3_ARCHIVED,
        ORG_D1,
        ORG_D2,
      ]),
    );
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [OWNER_ID, OTHER_ID, ADMIN_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("potential-duplicates queue", () => {
  it("rejects a non-admin on the list endpoint with 403", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    const { status } = await listDup("organization");
    expect(status).toBe(403);
  }, 30_000);

  it("rejects a non-admin on the dismiss endpoint with 403", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    const status = await dismiss({
      type: "organization",
      idA: ORG_P1,
      idB: ORG_P2,
    });
    expect(status).toBe(403);
  }, 30_000);

  it("rejects a non-admin on both merge endpoints with 403", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    expect(
      await postMerge("/api/organizations/merge", {
        primaryId: ORG_P1,
        duplicateId: ORG_P2,
      }),
    ).toBe(403);
    expect(
      await postMerge("/api/people/merge", {
        primaryId: PERSON_1,
        duplicateId: PERSON_2,
      }),
    ).toBe(403);
  }, 30_000);

  it("returns 400 when type is missing or invalid", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const res = await fetch(`${baseUrl}/api/potential-duplicates?limit=10`);
    expect(res.status).toBe(400);
  }, 30_000);

  it("surfaces the seeded org pair to an admin, ranked, with both signals and enrichment", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await listDup("organization");
    expect(status).toBe(200);

    const pair = findPair(json.pairs, ORG_P1, ORG_P2);
    expect(pair, "seeded org pair present").toBeDefined();
    expect(pair!.type).toBe("organization");
    expect(pair!.signals.sort()).toEqual(["name", "phone"]);
    // name (1.0) + phone bonus (0.5).
    expect(pair!.score).toBeGreaterThanOrEqual(1.4);
    assertSideShape(pair!.a);
    assertSideShape(pair!.b);

    const p1 = sideOf(pair!, ORG_P1);
    expect(p1.name).toBe(DUP_ORG_NAME);
    expect(p1.primaryEmail).toBe(PRIMARY_EMAIL);
    expect(p1.primaryPhone).toBe(PHONE_P);
    expect(p1.giftCount).toBe(1);
    // ownerName falls back to the owner's email (no display name seeded).
    expect(p1.ownerName).toBe(`${OWNER_ID}@wildflowerschools.org`);

    const p2 = sideOf(pair!, ORG_P2);
    expect(p2.giftCount).toBe(0);
  }, 30_000);

  it("never surfaces an archived record as a duplicate side", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { json } = await listDup("organization");
    const touchesArchived = json.pairs.some(
      (p) => p.a.id === ORG_P3_ARCHIVED || p.b.id === ORG_P3_ARCHIVED,
    );
    expect(touchesArchived).toBe(false);
  }, 30_000);

  it("surfaces the seeded person pair to an admin", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { json } = await listDup("person");
    const pair = findPair(json.pairs, PERSON_1, PERSON_2);
    expect(pair, "seeded person pair present").toBeDefined();
    expect(pair!.type).toBe("person");
    expect(pair!.signals.sort()).toEqual(["name", "phone"]);
    expect(sideOf(pair!, PERSON_1).name).toBe(DUP_PERSON_NAME);
  }, 30_000);

  it("removes a dismissed pair (canonicalizing reversed ids) and re-dismiss is an idempotent 204", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };

    // Present before dismissal.
    const before = await listDup("organization");
    expect(findPair(before.json.pairs, ORG_D1, ORG_D2)).toBeDefined();

    // Dismiss with idA/idB intentionally reversed (idA > idB) so the handler
    // must canonicalize for the NOT EXISTS exclusion to match.
    const [hi, lo] = ORG_D1 > ORG_D2 ? [ORG_D1, ORG_D2] : [ORG_D2, ORG_D1];
    expect(
      await dismiss({ type: "organization", idA: hi, idB: lo }),
    ).toBe(204);

    const after = await listDup("organization");
    expect(findPair(after.json.pairs, ORG_D1, ORG_D2)).toBeUndefined();

    // Re-dismissing the same pair is a no-op.
    expect(
      await dismiss({ type: "organization", idA: hi, idB: lo }),
    ).toBe(204);
  }, 30_000);

  it("returns 400 when dismissing a pair of identical ids", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const status = await dismiss({
      type: "organization",
      idA: ORG_P1,
      idB: ORG_P1,
    });
    expect(status).toBe(400);
  }, 30_000);
});
