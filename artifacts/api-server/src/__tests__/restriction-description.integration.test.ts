import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Task: "Other restriction" rename + restriction_description field.
 *
 * DB-backed coverage for two contracts:
 *   1. The new optional restrictionDescription free-text field round-trips on
 *      create + edit for BOTH allocation types (gift + pledge), following the
 *      POST omit-if-empty / PATCH null-to-clear convention.
 *   2. The 0150 data-cleanup migration is idempotent and NEVER flips any
 *      allocation's derived restricted/unrestricted coding outcome
 *      (anyDonorRestricted across the three axes) — the hard guardrail. The
 *      migration's own DO-block guard aborts on a flip; this test proves the
 *      seeded shapes it targets (junk verbatim, plain-language verbatim,
 *      geo-named verbatim) survive with their coding outcome intact.
 *
 * Only `requireAuth` is mocked; routes and SQL are real production code.
 * Skips without a real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `restr_desc_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID };
    next();
  },
}));

const RUN = `restrdesc_${Date.now()}`;
const ORG_ID = `${RUN}_org`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let pool: Db["pool"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
};
let eqFn: typeof import("drizzle-orm").eq;
let server: Server;
let baseUrl = "";

const giftIds: string[] = [];
const oppIds: string[] = [];

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

async function seedGift(): Promise<string> {
  const r = await api("POST", "/gifts-and-payments", {
    name: `${RUN} gift`,
    organizationId: ORG_ID,
    amount: "100.00",
    dateReceived: "2099-01-15",
  });
  expect(r.status).toBe(201);
  const id = r.json.id as string;
  giftIds.push(id);
  return id;
}

async function seedOpp(): Promise<string> {
  const r = await api("POST", "/opportunities-and-pledges", {
    name: `${RUN} opp`,
    organizationId: ORG_ID,
  });
  expect(r.status).toBe(201);
  const id = r.json.id as string;
  oppIds.push(id);
  return id;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  pool = dbMod.pool;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
  };
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Restriction Description Test Org ${RUN}`,
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
  for (const id of giftIds) {
    await db.delete(schema.giftAllocations).where(eqFn(schema.giftAllocations.giftId, id));
    await db.delete(schema.giftsAndPayments).where(eqFn(schema.giftsAndPayments.id, id));
  }
  for (const id of oppIds) {
    await db
      .delete(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, id));
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, id));
  }
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("restrictionDescription round-trip", () => {
  it("round-trips on gift allocation create, edit, and null-to-clear", async () => {
    const giftId = await seedGift();
    const created = await api("POST", "/gift-allocations", {
      giftId,
      otherRestrictionType: "donor_restricted",
      restrictionDescription: "Grants to schools only",
    });
    expect(created.status).toBe(201);
    expect(created.json.restrictionDescription).toBe("Grants to schools only");
    expect(created.json.otherRestrictionType).toBe("donor_restricted");
    const allocId = created.json.id as string;

    const edited = await api("PATCH", `/gift-allocations/${allocId}`, {
      restrictionDescription: "Professional development only",
    });
    expect(edited.status).toBe(200);
    expect(edited.json.restrictionDescription).toBe("Professional development only");

    // PATCH null clears.
    const cleared = await api("PATCH", `/gift-allocations/${allocId}`, {
      restrictionDescription: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.json.restrictionDescription).toBeNull();

    // POST omit-if-empty: an allocation created without the field is null.
    const bare = await api("POST", "/gift-allocations", { giftId });
    expect(bare.status).toBe(201);
    expect(bare.json.restrictionDescription).toBeNull();
  });

  it("round-trips on pledge allocation create and edit", async () => {
    const oppId = await seedOpp();
    // Seeded starter allocation exists; create an explicit one with the field.
    const created = await api("POST", "/pledge-allocations", {
      pledgeOrOpportunityId: oppId,
      otherRestrictionType: "donor_restricted",
      restrictionDescription: "Salaries for RGL and Ops Guide only",
    });
    expect(created.status).toBe(201);
    expect(created.json.restrictionDescription).toBe(
      "Salaries for RGL and Ops Guide only",
    );
    const allocId = created.json.id as string;

    const edited = await api("PATCH", `/pledge-allocations/${allocId}`, {
      restrictionDescription: "Travel only",
    });
    expect(edited.status).toBe(200);
    expect(edited.json.restrictionDescription).toBe("Travel only");
  });
});

describe.skipIf(!HAS_DB)("0150 cleanup migration invariant", () => {
  const MIGRATION = join(
    __dirname,
    "../../../../lib/db/migrations/0150_other_restriction_rename_and_cleanup.sql",
  );

  async function anyDonorRestrictedMap(): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    for (const id of giftIds) {
      const rows = await db
        .select()
        .from(schema.giftAllocations)
        .where(eqFn(schema.giftAllocations.giftId, id));
      for (const a of rows) {
        out.set(
          `gift:${a.id}`,
          a.regionalRestrictionType === "donor_restricted" ||
            a.otherRestrictionType === "donor_restricted" ||
            a.timeRestrictionType === "donor_restricted",
        );
      }
    }
    for (const id of oppIds) {
      const rows = await db
        .select()
        .from(schema.pledgeAllocations)
        .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, id));
      for (const a of rows) {
        out.set(
          `pledge:${a.id}`,
          a.regionalRestrictionType === "donor_restricted" ||
            a.otherRestrictionType === "donor_restricted" ||
            a.timeRestrictionType === "donor_restricted",
        );
      }
    }
    return out;
  }

  it("preserves every seeded row's coding outcome and is idempotent", async () => {
    const giftId = await seedGift();
    // Junk verbatim on an UNRESTRICTED row — must be cleared, stays unrestricted.
    await api("POST", "/gift-allocations", {
      giftId,
      purposeVerbatim: "N/A",
    });
    // Plain-language verbatim on a donor-restricted row — moves to description,
    // latch stays donor_restricted.
    const plain = await api("POST", "/gift-allocations", {
      giftId,
      otherRestrictionType: "donor_restricted",
      purposeVerbatim: "Scholarships for teacher training",
    });
    // Quoted grant language — must STAY in purpose_verbatim.
    const quoted = await api("POST", "/gift-allocations", {
      giftId,
      otherRestrictionType: "donor_restricted",
      purposeVerbatim: 'Grant letter states: "for the sole use of MN schools"',
    });
    const oppId = await seedOpp();
    const pledgeJunk = await api("POST", "/pledge-allocations", {
      pledgeOrOpportunityId: oppId,
      otherRestrictionType: "donor_restricted",
      purposeVerbatim: "Support for the alumni program",
    });

    const before = await anyDonorRestrictedMap();
    const sqlText = readFileSync(MIGRATION, "utf8");
    await pool.query(sqlText);
    const after = await anyDonorRestrictedMap();
    expect(Object.fromEntries(after)).toEqual(Object.fromEntries(before));

    // Content sorting behaved as specified.
    const [plainRow] = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.id, plain.json.id as string));
    expect(plainRow!.purposeVerbatim).toBeNull();
    expect(plainRow!.restrictionDescription).toBe(
      "Scholarships for teacher training",
    );
    expect(plainRow!.otherRestrictionType).toBe("donor_restricted");

    const [quotedRow] = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.id, quoted.json.id as string));
    expect(quotedRow!.purposeVerbatim).toContain('"for the sole use of MN schools"');

    const [pledgeRow] = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.id, pledgeJunk.json.id as string));
    expect(pledgeRow!.purposeVerbatim).toBeNull();
    expect(pledgeRow!.restrictionDescription).toBe("Support for the alumni program");

    // Idempotency: a second run changes nothing.
    await pool.query(sqlText);
    const [plainRow2] = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.id, plain.json.id as string));
    expect(plainRow2!.restrictionDescription).toBe(
      "Scholarships for teacher training",
    );
    const again = await anyDonorRestrictedMap();
    expect(Object.fromEntries(again)).toEqual(Object.fromEntries(before));
  }, 60_000);
});
