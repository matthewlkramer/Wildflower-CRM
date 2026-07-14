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
// Safe-merge pair: identical name + shared phone, differing ONLY where one is
// blank (S1 has a website, S2 doesn't). S2 has the only gift, so it wins the
// survivor pick and S1's website becomes the override.
const ORG_S1 = `${RUN}_orgs1`;
const ORG_S2 = `${RUN}_orgs2`;
// Unsafe pair: identical name + shared phone, but two distinct websites — a real
// conflict, so it must NOT be flagged safe.
const ORG_U1 = `${RUN}_orgu1`;
const ORG_U2 = `${RUN}_orgu2`;
// Token-conflict pair: trigram-similar names ("MN/US Department of Education")
// that differ in their distinctive token — must be filtered OUT of the queue.
const ORG_T1 = `${RUN}_orgt1`;
const ORG_T2 = `${RUN}_orgt2`;
// Web-identity conflict pair: identical names but disjoint website domains and
// no shared phone — different real-world orgs, must be filtered OUT.
const ORG_W1 = `${RUN}_orgw1`;
const ORG_W2 = `${RUN}_orgw2`;
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
const PH_S1 = `${RUN}_phs1`;
const PH_S2 = `${RUN}_phs2`;
const PH_U1 = `${RUN}_phu1`;
const PH_U2 = `${RUN}_phu2`;
const GIFT_S2 = `${RUN}_gifts2`;

const DUP_ORG_NAME = `Dup Org ${RUN}`;
const DISMISS_ORG_NAME = `Dismiss Org ${RUN}`;
const SAFE_ORG_NAME = `Safe Org ${RUN}`;
const UNSAFE_ORG_NAME = `Unsafe Org ${RUN}`;
// Trigram-similar (long shared tail) but token-conflicting (MN vs US).
const TOKEN_ORG_NAME_A = `MN Department of Education ${RUN}`;
const TOKEN_ORG_NAME_B = `US Department of Education ${RUN}`;
// Identical name — only the web identities (website domains) differ.
const WEB_ORG_NAME = `Department of Education ${RUN}`;
const DUP_PERSON_NAME = `Dup Person ${RUN}`;

const SAFE_WEBSITE = "https://safe-merge.example.org";
const PHONE_P = "+1 (555) 010-1111";
const PHONE_D = "+1 (555) 010-2222";
const PHONE_PE = "+1 (555) 010-3333";
const PHONE_S = "+1 (555) 010-4444";
const PHONE_U = "+1 (555) 010-5555";
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
type MergeSuggestion = {
  primaryId: string;
  mergeIds: string[];
  overrides: Record<string, unknown>;
};
type Pair = {
  type: string;
  score: number;
  signals: string[];
  a: Side;
  b: Side;
  safeMerge: boolean;
  mergeSuggestion: MergeSuggestion | null;
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
    // Safe pair: S1 has a website, S2 leaves it blank — only a null-vs-filled
    // difference, so it's safe to auto-merge.
    { id: ORG_S1, name: SAFE_ORG_NAME, website: SAFE_WEBSITE },
    { id: ORG_S2, name: SAFE_ORG_NAME },
    // Unsafe pair: two distinct websites is a real conflict.
    { id: ORG_U1, name: UNSAFE_ORG_NAME, website: "https://u1.example.org" },
    { id: ORG_U2, name: UNSAFE_ORG_NAME, website: "https://u2.example.org" },
    // Token-conflict pair: high trigram similarity, but distinctive tokens
    // differ (MN vs US) — must never surface as a name-signal duplicate.
    { id: ORG_T1, name: TOKEN_ORG_NAME_A },
    { id: ORG_T2, name: TOKEN_ORG_NAME_B },
    // Web-identity conflict pair: identical names, disjoint website domains —
    // different orgs, must never surface as a name-signal duplicate.
    { id: ORG_W1, name: WEB_ORG_NAME, website: "https://education.mn.gov" },
    { id: ORG_W2, name: WEB_ORG_NAME, website: "https://www.ed.gov" },
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
    { id: PH_S1, phoneNumber: PHONE_S, organizationId: ORG_S1 },
    { id: PH_S2, phoneNumber: PHONE_S, organizationId: ORG_S2 },
    { id: PH_U1, phoneNumber: PHONE_U, organizationId: ORG_U1 },
    { id: PH_U2, phoneNumber: PHONE_U, organizationId: ORG_U2 },
  ]);

  await db.insert(schema.emails).values({
    id: EMAIL_P1,
    email: PRIMARY_EMAIL,
    organizationId: ORG_P1,
    isPreferred: true,
  });

  await db.insert(schema.giftsAndPayments).values([
    { id: GIFT_ENR, name: `Gift ${RUN}`, organizationId: ORG_P1 },
    // S2 gets the only gift so it wins the survivor pick (most gifts).
    { id: GIFT_S2, name: `Gift S2 ${RUN}`, organizationId: ORG_S2 },
  ]);

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 180_000);

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
    .where(inArrayFn(schema.giftsAndPayments.id, [GIFT_ENR, GIFT_S2]));
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
        PH_S1,
        PH_S2,
        PH_U1,
        PH_U2,
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
        ORG_S1,
        ORG_S2,
        ORG_U1,
        ORG_U2,
        ORG_T1,
        ORG_T2,
        ORG_W1,
        ORG_W2,
      ]),
    );
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [OWNER_ID, OTHER_ID, ADMIN_ID]));
}, 180_000);

describe.skipIf(!HAS_DB)("potential-duplicates queue", () => {
  it("rejects a non-admin on the list endpoint with 403", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    const { status } = await listDup("organization");
    expect(status).toBe(403);
  }, 120_000);

  it("rejects a non-admin on the dismiss endpoint with 403", async () => {
    auth.current = { id: OTHER_ID, role: "team_member" };
    const status = await dismiss({
      type: "organization",
      idA: ORG_P1,
      idB: ORG_P2,
    });
    expect(status).toBe(403);
  }, 120_000);

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
  }, 120_000);

  it("returns 400 when type is missing or invalid", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const res = await fetch(`${baseUrl}/api/potential-duplicates?limit=10`);
    expect(res.status).toBe(400);
  }, 120_000);

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
  }, 120_000);

  it("never surfaces an archived record as a duplicate side", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { json } = await listDup("organization");
    const touchesArchived = json.pairs.some(
      (p) => p.a.id === ORG_P3_ARCHIVED || p.b.id === ORG_P3_ARCHIVED,
    );
    expect(touchesArchived).toBe(false);
  }, 120_000);

  it("surfaces the seeded person pair to an admin", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { json } = await listDup("person");
    const pair = findPair(json.pairs, PERSON_1, PERSON_2);
    expect(pair, "seeded person pair present").toBeDefined();
    expect(pair!.type).toBe("person");
    expect(pair!.signals.sort()).toEqual(["name", "phone"]);
    expect(sideOf(pair!, PERSON_1).name).toBe(DUP_PERSON_NAME);
  }, 120_000);

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
  }, 120_000);

  it("returns 400 when dismissing a pair of identical ids", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const status = await dismiss({
      type: "organization",
      idA: ORG_P1,
      idB: ORG_P1,
    });
    expect(status).toBe(400);
  }, 120_000);

  it("flags a null-vs-filled pair safe with a survivor + override suggestion", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { json } = await listDup("organization");
    const pair = findPair(json.pairs, ORG_S1, ORG_S2);
    expect(pair, "seeded safe pair present").toBeDefined();
    expect(pair!.safeMerge).toBe(true);
    expect(pair!.mergeSuggestion).not.toBeNull();
    // S2 has the only gift ⇒ it survives; S1's website is carried over.
    expect(pair!.mergeSuggestion!.primaryId).toBe(ORG_S2);
    expect(pair!.mergeSuggestion!.mergeIds).toEqual([ORG_S1]);
    expect(pair!.mergeSuggestion!.overrides).toMatchObject({
      website: SAFE_WEBSITE,
    });
  }, 120_000);

  it("does NOT flag a pair with two distinct values as safe", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { json } = await listDup("organization");
    const pair = findPair(json.pairs, ORG_U1, ORG_U2);
    expect(pair, "seeded unsafe pair present").toBeDefined();
    expect(pair!.safeMerge).toBe(false);
    expect(pair!.mergeSuggestion).toBeNull();
  }, 120_000);

  it("filters out trigram-similar names whose distinctive tokens conflict (MN vs US Dept of Education)", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { json } = await listDup("organization");
    expect(findPair(json.pairs, ORG_T1, ORG_T2)).toBeUndefined();
  }, 120_000);

  it("filters out same-named orgs living on disjoint website domains", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { json } = await listDup("organization");
    expect(findPair(json.pairs, ORG_W1, ORG_W2)).toBeUndefined();
  }, 120_000);

  it("still surfaces distinct-website pairs that share a phone (via the phone signal)", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { json } = await listDup("organization");
    // ORG_U1/U2 have distinct websites (dropped from the name signal) but a
    // shared phone — the stronger tie keeps them in the review queue.
    expect(findPair(json.pairs, ORG_U1, ORG_U2)).toBeDefined();
  }, 120_000);
});

// Pure token-conflict guard — no DB needed, always runs.
describe("namesTokenConflict", () => {
  let namesTokenConflict: (a: string, b: string) => boolean;
  let tokensAreSpellingVariants: (a: string, b: string) => boolean;
  let normalizeWebDomain: (v: string | null | undefined) => string | null;
  let orgDomainSet: (parts: Array<string | null | undefined>) => Set<string>;
  let domainSetsConflict: (a: Set<string>, b: Set<string>) => boolean;

  beforeAll(async () => {
    const mod = await import("../routes/potentialDuplicates");
    namesTokenConflict = mod.namesTokenConflict;
    tokensAreSpellingVariants = mod.tokensAreSpellingVariants;
    normalizeWebDomain = mod.normalizeWebDomain;
    orgDomainSet = mod.orgDomainSet;
    domainSetsConflict = mod.domainSetsConflict;
  });

  it("drops state-prefix government lookalikes", () => {
    expect(
      namesTokenConflict(
        "MN Department of Education",
        "US Department of Education",
      ),
    ).toBe(true);
    expect(
      namesTokenConflict(
        "RI Department of Education",
        "MN Department of Education",
      ),
    ).toBe(true);
    expect(
      namesTokenConflict(
        "State University of New York",
        "City University of New York",
      ),
    ).toBe(true);
  });

  it("keeps misspelled duplicates (differing tokens are spelling variants)", () => {
    expect(
      namesTokenConflict("Wildflower Fundation", "Wildflower Foundation"),
    ).toBe(false);
    expect(namesTokenConflict("Jon Smith", "John Smith")).toBe(false);
    expect(namesTokenConflict("Katherine Reed", "Kathryn Reed")).toBe(false);
  });

  it("keeps one-sided prefix/suffix additions (subset names)", () => {
    expect(
      namesTokenConflict(
        "MN Department of Education",
        "Department of Education",
      ),
    ).toBe(false);
    expect(namesTokenConflict("Acme Foundation", "The Acme Foundation")).toBe(
      false,
    );
    expect(namesTokenConflict("John Smith", "John Smith Jr")).toBe(false);
  });

  it("keeps identical and connective-only-differing names", () => {
    expect(namesTokenConflict("Acme Fund", "Acme Fund")).toBe(false);
    expect(namesTokenConflict("University of Chicago", "University Chicago")).toBe(
      false,
    );
  });

  it("drops family foundations that differ only in the family name", () => {
    // "Family Foundation" is filler both sides share; Mai vs Hall is the
    // distinctive token and they are not similar.
    expect(
      namesTokenConflict("Mai Family Foundation", "Hall Family Foundation"),
    ).toBe(true);
  });

  it("drops names that differ in a person's distinctive token", () => {
    expect(namesTokenConflict("John Smith", "Jane Smith")).toBe(true);
    expect(namesTokenConflict("John Michael Smith", "John Robert Smith")).toBe(
      true,
    );
    // Single-letter middle initials are too weak to auto-drop: "a" doubles as
    // an article (stoplisted), leaving a one-sided leftover — kept for review.
    expect(namesTokenConflict("John A Smith", "John B Smith")).toBe(false);
  });

  it("treats abbreviations, plurals, and misspellings as the same word", () => {
    expect(tokensAreSpellingVariants("univ", "university")).toBe(true);
    expect(tokensAreSpellingVariants("school", "schools")).toBe(true);
    expect(tokensAreSpellingVariants("katherine", "kathryn")).toBe(true);
    expect(tokensAreSpellingVariants("mn", "us")).toBe(false);
    expect(tokensAreSpellingVariants("state", "city")).toBe(false);
  });

  it("normalizes URLs, bare domains, and e-mail addresses to a host", () => {
    expect(normalizeWebDomain("https://www.education.mn.gov/about?x=1")).toBe(
      "education.mn.gov",
    );
    expect(normalizeWebDomain("ED.GOV")).toBe("ed.gov");
    expect(normalizeWebDomain("grants@ed.gov")).toBe("ed.gov");
    expect(normalizeWebDomain("http://mn.gov:8080/path")).toBe("mn.gov");
    expect(normalizeWebDomain("  ")).toBeNull();
    expect(normalizeWebDomain(null)).toBeNull();
    expect(normalizeWebDomain("localhost")).toBeNull();
    // Free-mail providers say nothing about org identity.
    expect(normalizeWebDomain("someone@gmail.com")).toBeNull();
    // Shared-platform pages say nothing about org identity either.
    expect(normalizeWebDomain("https://www.facebook.com/some-org")).toBeNull();
    expect(normalizeWebDomain("https://m.facebook.com/some-org")).toBeNull();
    expect(normalizeWebDomain("https://linkedin.com/company/x")).toBeNull();
    // A URL query containing an e-mail must not hijack the host.
    expect(normalizeWebDomain("https://x.org/contact?email=a@b.com")).toBe(
      "x.org",
    );
  });

  it("flags disjoint domain sets, tolerates subdomains and blanks", () => {
    const mn = orgDomainSet(["https://education.mn.gov"]);
    const us = orgDomainSet(["https://www.ed.gov", "grants@ed.gov"]);
    expect(domainSetsConflict(mn, us)).toBe(true);
    // Subdomain of the same domain = same identity.
    expect(
      domainSetsConflict(orgDomainSet(["education.mn.gov"]), orgDomainSet(["mn.gov"])),
    ).toBe(false);
    // Any shared domain = evidence FOR a dupe.
    expect(
      domainSetsConflict(
        orgDomainSet(["mn.gov", "old-site.org"]),
        orgDomainSet(["mn.gov"]),
      ),
    ).toBe(false);
    // Blank or freemail-only sides never conflict.
    expect(domainSetsConflict(orgDomainSet([null]), us)).toBe(false);
    expect(domainSetsConflict(orgDomainSet(["a@gmail.com"]), us)).toBe(false);
  });
});
