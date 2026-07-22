import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Coding-form gift matching (Task #794 step 3).
 *
 * `giftCandidatesFor` / `computeProposedMatch` (lib/codingForms.ts) decide
 * which CRM gift a coding-form sheet row is proposed against — a wrong match
 * books donor money onto the wrong gift. Locked in here:
 *
 *   - the amount band is EXACT (±$0.01) — a 1-cent-off gift matches, a
 *     2-cent-off gift does not (sheet rows transcribe the booked amount, so
 *     no fee gap is legitimate);
 *   - the date window is ±GIFT_MATCH_WINDOW_DAYS around the donation date;
 *   - archived gifts are never candidates;
 *   - donor scoping: without a donor FK the row yields NO candidates unless
 *     donorAgnostic is set (the record-first pass);
 *   - computeProposedMatch proposes record_exact_gift ONLY when exactly one
 *     donor-agnostic candidate exists — two candidates means ambiguity and no
 *     record-first proposal (never guess between donors).
 *
 * Calls the lib functions directly against the test DB (no HTTP). Skips when
 * no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `codematch_${Date.now()}`;
const ORG_A = `${RUN}_org_a`;
const ORG_B = `${RUN}_org_b`;
const GIFT_EXACT = `${RUN}_g_exact`; // org A, 500.00, in window
const GIFT_CENT = `${RUN}_g_cent`; // org A, 500.01 (inside ±1¢ band)
const GIFT_OFFBAND = `${RUN}_g_offband`; // org A, 500.02 (outside band)
const GIFT_STALE = `${RUN}_g_stale`; // org A, 500.00, outside date window
const GIFT_ARCHIVED = `${RUN}_g_arch`; // org A, 500.00, archived
const GIFT_OTHER_DONOR = `${RUN}_g_other`; // org B, 777.00 unique amount
const GIFT_DUP_1 = `${RUN}_g_dup1`; // org A, 888.00 — ambiguity pair
const GIFT_DUP_2 = `${RUN}_g_dup2`; // org B, 888.00 — ambiguity pair

const ANCHOR_DATE = "2096-06-15";

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let likeFn: (typeof import("drizzle-orm"))["like"];
let giftCandidatesFor: (typeof import("../lib/codingForms"))["giftCandidatesFor"];
let computeProposedMatch: (typeof import("../lib/codingForms"))["computeProposedMatch"];
let WINDOW = 0;

type AnyRow = Record<string, unknown>;
/** Minimal coding-form row stub — only the fields the matcher reads. */
function rowStub(over: AnyRow): never {
  return {
    id: `${RUN}_row`,
    organizationId: null,
    individualGiverPersonId: null,
    householdId: null,
    amount: "500.00",
    donationDate: ANCHOR_DATE,
    donorName: null,
    donorNameNormalized: null,
    internalMemo: null,
    internalMemoEffective: null,
    restrictionLanguage: null,
    restrictionLanguageEffective: null,
    ...over,
  } as never;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  const cf = await import("../lib/codingForms");
  const gm = await import("../lib/giftMatch");
  giftCandidatesFor = cf.giftCandidatesFor;
  computeProposedMatch = cf.computeProposedMatch;
  WINDOW = gm.GIFT_MATCH_WINDOW_DAYS;
  db = dbMod.db;
  schema = {
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
  };
  eqFn = drizzle.eq;
  likeFn = drizzle.like;

  await db.insert(schema.organizations).values([
    { id: ORG_A, name: `CodeMatch Org A ${RUN}` },
    { id: ORG_B, name: `CodeMatch Org B ${RUN}` },
  ]);

  const staleDate = new Date(`${ANCHOR_DATE}T00:00:00Z`);
  staleDate.setUTCDate(staleDate.getUTCDate() - (WINDOW + 5));
  const stale = staleDate.toISOString().slice(0, 10);

  await db.insert(schema.giftsAndPayments).values([
    { id: GIFT_EXACT, name: `CM exact ${RUN}`, organizationId: ORG_A, amount: "500.00", dateReceived: ANCHOR_DATE },
    { id: GIFT_CENT, name: `CM cent ${RUN}`, organizationId: ORG_A, amount: "500.01", dateReceived: "2096-06-16" },
    { id: GIFT_OFFBAND, name: `CM offband ${RUN}`, organizationId: ORG_A, amount: "500.02", dateReceived: ANCHOR_DATE },
    { id: GIFT_STALE, name: `CM stale ${RUN}`, organizationId: ORG_A, amount: "500.00", dateReceived: stale },
    {
      id: GIFT_ARCHIVED,
      name: `CM archived ${RUN}`,
      organizationId: ORG_A,
      amount: "500.00",
      dateReceived: ANCHOR_DATE,
      archivedAt: new Date("2096-06-20T00:00:00Z"),
    },
    { id: GIFT_OTHER_DONOR, name: `CM other donor ${RUN}`, organizationId: ORG_B, amount: "777.00", dateReceived: ANCHOR_DATE },
    { id: GIFT_DUP_1, name: `CM dup 1 ${RUN}`, organizationId: ORG_A, amount: "888.00", dateReceived: ANCHOR_DATE },
    { id: GIFT_DUP_2, name: `CM dup 2 ${RUN}`, organizationId: ORG_B, amount: "888.00", dateReceived: ANCHOR_DATE },
  ]);
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await db
    .delete(schema.giftsAndPayments)
    .where(likeFn(schema.giftsAndPayments.id, `${RUN}%`));
  for (const id of [ORG_A, ORG_B]) {
    await db.delete(schema.organizations).where(eqFn(schema.organizations.id, id));
  }
}, 60_000);

describe.skipIf(!HAS_DB)("coding-form gift matching", () => {
  it("matches only the EXACT ±1¢ amount band within the donor scope", async () => {
    const got = await giftCandidatesFor(
      rowStub({ organizationId: ORG_A }),
      10,
    );
    const ids = got.map((g) => g.id);
    expect(ids).toContain(GIFT_EXACT);
    expect(ids).toContain(GIFT_CENT); // 500.01 is inside the ±1¢ band
    expect(ids).not.toContain(GIFT_OFFBAND); // 500.02 is outside
    expect(ids).not.toContain(GIFT_ARCHIVED);
    expect(ids).not.toContain(GIFT_STALE); // outside the date window
    expect(ids).not.toContain(GIFT_OTHER_DONOR);
  });

  it("respects the ±GIFT_MATCH_WINDOW_DAYS date window edge", async () => {
    // A donation date exactly WINDOW days after the gift still matches …
    const edgeDate = new Date(`${ANCHOR_DATE}T00:00:00Z`);
    edgeDate.setUTCDate(edgeDate.getUTCDate() + WINDOW);
    const onEdge = await giftCandidatesFor(
      rowStub({
        organizationId: ORG_A,
        donationDate: edgeDate.toISOString().slice(0, 10),
      }),
      10,
    );
    expect(onEdge.map((g) => g.id)).toContain(GIFT_EXACT);

    // … one day past the window does not.
    edgeDate.setUTCDate(edgeDate.getUTCDate() + 1 + WINDOW); // far past
    const past = await giftCandidatesFor(
      rowStub({
        organizationId: ORG_A,
        donationDate: edgeDate.toISOString().slice(0, 10),
      }),
      10,
    );
    expect(past.map((g) => g.id)).not.toContain(GIFT_EXACT);
  });

  it("a row without any donor FK yields no candidates unless donorAgnostic", async () => {
    const scoped = await giftCandidatesFor(rowStub({ amount: "777.00" }), 10);
    expect(scoped).toEqual([]);

    const agnostic = await giftCandidatesFor(rowStub({ amount: "777.00" }), 10, {
      donorAgnostic: true,
    });
    expect(agnostic.map((g) => g.id)).toContain(GIFT_OTHER_DONOR);
  });

  it("computeProposedMatch: exactly ONE donor-agnostic candidate ⇒ record_exact_gift with the donor inherited", async () => {
    const match = await computeProposedMatch(rowStub({ amount: "777.00" }));
    expect(match.matchMethod).toBe("record_exact_gift");
    expect(match.matchedGiftId).toBe(GIFT_OTHER_DONOR);
    expect(match.organizationId).toBe(ORG_B);
    expect(match.individualGiverPersonId).toBeNull();
    expect(match.householdId).toBeNull();
  });

  it("computeProposedMatch: TWO cross-donor candidates at the same amount ⇒ no record-first gift proposal (never guess)", async () => {
    const match = await computeProposedMatch(rowStub({ amount: "888.00" }));
    expect(match.matchMethod).not.toBe("record_exact_gift");
    expect(match.matchedGiftId).toBeNull();
  });
});
