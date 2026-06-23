import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { clearPaymentApplicationsForRealm } from "./paymentApplicationsTestUtil";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the two gift-merge operator paths:
 *   - POST /gifts-and-payments/merge           (collapse N gifts into one)
 *   - POST /gifts-and-payments/merge-into-pledge (attach N gifts to a pledge)
 *
 * Like the QuickBooks integration suite, this exercises the real route handlers
 * against the dev Postgres so it can assert the actual DB state transitions:
 * allocation roll-up onto the survivor, the summed survivor amount, loser
 * deletion, donor resolution (Donor XOR), QuickBooks-link blocking, new-pledge
 * creation with awarded amount, attach-to-existing, and body validation.
 *
 * The only seam mocked is the Clerk auth gate (`requireAuth`) — a seeded test
 * user is injected so handlers run with a real `appUser` and can write the
 * bulk_operations audit row. All seeded rows use a unique run prefix and are
 * cleaned up. Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `gift_merge_test_user_${Date.now()}`,
}));

// Replace the Clerk-backed auth gate with one that injects our seeded user.
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

const RUN = `gmerge_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ORG2_ID = `${RUN}_org2`;
const PERSON_ID = `${RUN}_person`;
const REALM_ID = `${RUN}_realm`;
const FY_A_ID = `${RUN}_fya`;
const FY_B_ID = `${RUN}_fyb`;

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  people: Db["people"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
  stagedPayments: Db["stagedPayments"];
  stagedPaymentSplits: Db["stagedPaymentSplits"];
  fiscalYears: Db["fiscalYears"];
  bulkOperations: Db["bulkOperations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let likeFn: (typeof import("drizzle-orm"))["like"];
let server: Server;
let baseUrl = "";

let gen = 0;
function nextId(label: string): string {
  gen += 1;
  return `${RUN}_${label}_${String(gen).padStart(3, "0")}`;
}

async function api(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

type DonorFields = {
  organizationId?: string | null;
  individualGiverPersonId?: string | null;
  householdId?: string | null;
};

const seededGiftIds: string[] = [];
const seededPledgeIds: string[] = [];

/** Seed a gift with a single allocation carrying the same amount. */
async function seedGiftWithAllocation(
  amount: string,
  donor: DonorFields = { organizationId: ORG_ID },
): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: donor.organizationId ?? null,
    individualGiverPersonId: donor.individualGiverPersonId ?? null,
    householdId: donor.householdId ?? null,
  });
  await db.insert(schema.giftAllocations).values({
    id: nextId("alloc"),
    giftId: id,
    subAmount: amount,
  });
  seededGiftIds.push(id);
  return id;
}

/**
 * Seed a gift carrying >= 2 allocations (the split-into-pledge precondition).
 * Allocation ids are monotonically increasing so their insertion order matches
 * the route's `ORDER BY id` — i.e. allocs[0] is the one kept on the original
 * gift. The gift amount defaults to the cents-exact sum of the allocations so
 * the happy path passes the sum check; pass `giftOverrides.amount` to force a
 * mismatch.
 */
async function seedGiftWithAllocations(
  allocs: Array<{ subAmount: string; grantYear?: string | null }>,
  donor: DonorFields = { organizationId: ORG_ID },
  giftOverrides: { amount?: string; grantYear?: string | null } = {},
): Promise<string> {
  const id = nextId("gift");
  const sumCents = allocs.reduce(
    (s, a) => s + Math.round(Number(a.subAmount) * 100),
    0,
  );
  const amount = giftOverrides.amount ?? (sumCents / 100).toFixed(2);
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: donor.organizationId ?? null,
    individualGiverPersonId: donor.individualGiverPersonId ?? null,
    householdId: donor.householdId ?? null,
    grantYear: giftOverrides.grantYear ?? null,
  });
  for (const a of allocs) {
    await db.insert(schema.giftAllocations).values({
      id: nextId("alloc"),
      giftId: id,
      subAmount: a.subAmount,
      grantYear: a.grantYear ?? null,
    });
  }
  seededGiftIds.push(id);
  return id;
}

async function readGift(id: string) {
  const [row] = await db
    .select()
    .from(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, id));
  return row;
}

async function allocationsFor(giftId: string) {
  return db
    .select()
    .from(schema.giftAllocations)
    .where(eqFn(schema.giftAllocations.giftId, giftId));
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
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
    stagedPayments: dbMod.stagedPayments,
    stagedPaymentSplits: dbMod.stagedPaymentSplits,
    fiscalYears: dbMod.fiscalYears,
    bulkOperations: dbMod.bulkOperations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  likeFn = drizzle.like;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values([
    { id: ORG_ID, name: `Gift Merge Org ${RUN}` },
    { id: ORG2_ID, name: `Gift Merge Org 2 ${RUN}` },
  ]);
  await db.insert(schema.people).values({
    id: PERSON_ID,
    fullName: `Gift Merge Person ${RUN}`,
  });
  await db.insert(schema.fiscalYears).values([
    { id: FY_A_ID, label: `FY-A ${RUN}` },
    { id: FY_B_ID, label: `FY-B ${RUN}` },
  ]);

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
  // Children first: staged rows + gift allocations reference gifts; gift
  // payment links + pledge allocations reference pledges.
  // staged_payment_splits.gift_id is a RESTRICT FK, so clear splits before
  // their gifts (the staged_payments delete below would cascade these too).
  if (seededGiftIds.length) {
    await db
      .delete(schema.stagedPaymentSplits)
      .where(inArrayFn(schema.stagedPaymentSplits.giftId, seededGiftIds));
  }
  await clearPaymentApplicationsForRealm(REALM_ID);
  await db
    .delete(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.realmId, REALM_ID));
  await db
    .delete(schema.giftAllocations)
    .where(likeFn(schema.giftAllocations.id, `${RUN}_alloc_%`));
  // The new-pledge path mints pledge_allocations with a random id, so clean
  // them by their parent pledge id (a RESTRICT FK that would otherwise block
  // the pledge delete below) rather than by id prefix.
  if (seededPledgeIds.length) {
    await db
      .delete(schema.pledgeAllocations)
      .where(
        inArrayFn(schema.pledgeAllocations.pledgeOrOpportunityId, seededPledgeIds),
      );
  }
  if (seededGiftIds.length) {
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, seededGiftIds));
  }
  if (seededPledgeIds.length) {
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, seededPledgeIds));
  }
  // Fiscal years are a RESTRICT FK target for gifts + (gift|pledge) allocations,
  // so they can only be removed after every referencing row above is gone.
  await db
    .delete(schema.fiscalYears)
    .where(inArrayFn(schema.fiscalYears.id, [FY_A_ID, FY_B_ID]));
  await db
    .delete(schema.bulkOperations)
    .where(eqFn(schema.bulkOperations.actorUserId, TEST_USER_ID));
  await db.delete(schema.people).where(eqFn(schema.people.id, PERSON_ID));
  await db
    .delete(schema.organizations)
    .where(inArrayFn(schema.organizations.id, [ORG_ID, ORG2_ID]));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[gift-merge] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("POST /gifts-and-payments/merge", () => {
  it("rolls up allocations + amount onto the survivor and deletes losers", async () => {
    const a = await seedGiftWithAllocation("100.00");
    const b = await seedGiftWithAllocation("50.00");
    const c = await seedGiftWithAllocation("25.00");

    const res = await api("/api/gifts-and-payments/merge", {
      primaryId: a,
      mergeIds: [b, c],
    });

    expect(res.status).toBe(200);
    expect(res.json.primaryId).toBe(a);
    expect(res.json.mergedIds.sort()).toEqual([b, c].sort());

    const survivor = await readGift(a);
    expect(Number(survivor.amount)).toBeCloseTo(175);
    expect(survivor.organizationId).toBe(ORG_ID);

    // All three allocations now hang off the survivor.
    const allocs = await allocationsFor(a);
    expect(allocs.length).toBe(3);

    // Losers are gone.
    expect(await readGift(b)).toBeUndefined();
    expect(await readGift(c)).toBeUndefined();
  }, 30_000);

  it("resolves a mixed donor to the explicitly chosen donor (XOR)", async () => {
    const a = await seedGiftWithAllocation("60.00", { organizationId: ORG_ID });
    const b = await seedGiftWithAllocation("40.00", {
      individualGiverPersonId: PERSON_ID,
    });

    const res = await api("/api/gifts-and-payments/merge", {
      primaryId: a,
      mergeIds: [b],
      individualGiverPersonId: PERSON_ID,
    });

    expect(res.status).toBe(200);
    const survivor = await readGift(a);
    expect(survivor.individualGiverPersonId).toBe(PERSON_ID);
    expect(survivor.organizationId).toBeNull();
    expect(survivor.householdId).toBeNull();
    expect(Number(survivor.amount)).toBeCloseTo(100);
  }, 30_000);

  it("blocks (400 donor_resolution_required) a mixed-donor merge with no donor pick", async () => {
    const a = await seedGiftWithAllocation("60.00", { organizationId: ORG_ID });
    const b = await seedGiftWithAllocation("40.00", {
      individualGiverPersonId: PERSON_ID,
    });

    const res = await api("/api/gifts-and-payments/merge", {
      primaryId: a,
      mergeIds: [b],
    });

    expect(res.status).toBe(400);
    expect(res.json.error).toBe("donor_resolution_required");
    // Nothing deleted on a rejected merge.
    expect(await readGift(a)).toBeDefined();
    expect(await readGift(b)).toBeDefined();
  }, 30_000);

  it("rejects a donor pick that resolves to more than one type (XOR 400)", async () => {
    const a = await seedGiftWithAllocation("10.00");
    const b = await seedGiftWithAllocation("10.00");

    const res = await api("/api/gifts-and-payments/merge", {
      primaryId: a,
      mergeIds: [b],
      organizationId: ORG_ID,
      individualGiverPersonId: PERSON_ID,
    });

    expect(res.status).toBe(400);
    // Both survivors must remain — nothing deleted on a rejected merge.
    expect(await readGift(a)).toBeDefined();
    expect(await readGift(b)).toBeDefined();
  }, 30_000);

  it("blocks the merge (409) when a loser is linked to a QuickBooks staged payment", async () => {
    const a = await seedGiftWithAllocation("100.00");
    const b = await seedGiftWithAllocation("100.00");
    await db.insert(schema.stagedPayments).values({
      id: nextId("sp"),
      realmId: REALM_ID,
      qbEntityType: "payment",
      qbEntityId: nextId("qbe"),
      amount: "100.00",
      status: "approved",
      organizationId: ORG_ID,
      matchedGiftId: b,
    });

    const res = await api("/api/gifts-and-payments/merge", {
      primaryId: a,
      mergeIds: [b],
    });

    expect(res.status).toBe(409);
    expect(res.json.error).toBe("quickbooks_linked");
    // The loser must still exist.
    expect(await readGift(b)).toBeDefined();
  }, 30_000);

  it("returns 400 when mergeIds has no gift distinct from primaryId", async () => {
    const a = await seedGiftWithAllocation("10.00");
    const res = await api("/api/gifts-and-payments/merge", {
      primaryId: a,
      mergeIds: [a],
    });
    expect(res.status).toBe(400);
    expect(await readGift(a)).toBeDefined();
  }, 30_000);

  it("returns 400 when a referenced gift does not exist", async () => {
    const a = await seedGiftWithAllocation("10.00");
    const res = await api("/api/gifts-and-payments/merge", {
      primaryId: a,
      mergeIds: [`${RUN}_missing`],
    });
    expect(res.status).toBe(400);
  }, 30_000);
});

describe.skipIf(!HAS_DB)("POST /gifts-and-payments/merge-into-pledge", () => {
  it("creates a new pledge with the summed awarded amount and links the gifts", async () => {
    const a = await seedGiftWithAllocation("200.00");
    const b = await seedGiftWithAllocation("300.00");

    const res = await api("/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [a, b],
      name: `Merged Pledge ${RUN}`,
    });

    expect(res.status).toBe(200);
    expect(res.json.created).toBe(true);
    const pledgeId = res.json.pledgeId as string;
    seededPledgeIds.push(pledgeId);

    const [pledge] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, pledgeId));
    expect(Number(pledge.awardedAmount)).toBeCloseTo(500);
    expect(pledge.wasPledge).toBe(true);
    expect(pledge.organizationId).toBe(ORG_ID);

    // Both gifts now point at the new pledge; neither is deleted.
    expect((await readGift(a)).paymentOnPledgeId).toBe(pledgeId);
    expect((await readGift(b)).paymentOnPledgeId).toBe(pledgeId);
  }, 30_000);

  it("attaches gifts to an existing pledge", async () => {
    const pledgeId = nextId("pledge");
    await db.insert(schema.opportunitiesAndPledges).values({
      id: pledgeId,
      name: `Existing Pledge ${RUN}`,
      organizationId: ORG_ID,
      awardedAmount: "1000.00",
      stage: "written_commitment",
      wasPledge: true,
    });
    seededPledgeIds.push(pledgeId);
    const a = await seedGiftWithAllocation("75.00");

    const res = await api("/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [a],
      pledgeId,
    });

    expect(res.status).toBe(200);
    expect(res.json.created).toBe(false);
    expect(res.json.pledgeId).toBe(pledgeId);
    expect((await readGift(a)).paymentOnPledgeId).toBe(pledgeId);
  }, 30_000);

  it("rejects (409 donor_mismatch) attaching a gift whose donor differs from the existing pledge", async () => {
    const pledgeId = nextId("pledge");
    await db.insert(schema.opportunitiesAndPledges).values({
      id: pledgeId,
      name: `Donor Mismatch Pledge ${RUN}`,
      organizationId: ORG_ID,
      awardedAmount: "500.00",
      stage: "written_commitment",
      wasPledge: true,
    });
    seededPledgeIds.push(pledgeId);
    // Gift belongs to a PERSON, not the pledge's organization.
    const a = await seedGiftWithAllocation("50.00", {
      individualGiverPersonId: PERSON_ID,
    });

    const res = await api("/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [a],
      pledgeId,
    });

    expect(res.status).toBe(409);
    expect(res.json.error).toBe("donor_mismatch");
    // The gift must NOT have been re-pointed at the pledge.
    expect((await readGift(a)).paymentOnPledgeId).toBeNull();
  }, 30_000);

  it("rejects (409 gift_already_on_pledge) re-pointing a gift already on another pledge", async () => {
    const firstPledgeId = nextId("pledge");
    await db.insert(schema.opportunitiesAndPledges).values({
      id: firstPledgeId,
      name: `First Pledge ${RUN}`,
      organizationId: ORG_ID,
      awardedAmount: "100.00",
      stage: "written_commitment",
      wasPledge: true,
    });
    seededPledgeIds.push(firstPledgeId);
    const a = await seedGiftWithAllocation("80.00");

    // Attach the gift to the first pledge — this part succeeds.
    const attach = await api("/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [a],
      pledgeId: firstPledgeId,
    });
    expect(attach.status).toBe(200);
    expect((await readGift(a)).paymentOnPledgeId).toBe(firstPledgeId);

    // Now try to merge it into a brand-new pledge — must be surfaced, not moved.
    const res = await api("/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [a],
      name: `Second Pledge ${RUN}`,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("gift_already_on_pledge");
    // Still attached to the first pledge.
    expect((await readGift(a)).paymentOnPledgeId).toBe(firstPledgeId);
  }, 30_000);

  it("returns 409 when the target pledge does not exist", async () => {
    const a = await seedGiftWithAllocation("10.00");
    const res = await api("/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [a],
      pledgeId: `${RUN}_no_pledge`,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("pledge_not_found");
  }, 30_000);

  it("blocks (400 donor_resolution_required) a new pledge from mixed-donor gifts with no donor pick", async () => {
    const a = await seedGiftWithAllocation("60.00", { organizationId: ORG_ID });
    const b = await seedGiftWithAllocation("40.00", {
      individualGiverPersonId: PERSON_ID,
    });

    const res = await api("/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [a, b],
      name: `Mixed Donor Pledge ${RUN}`,
    });

    expect(res.status).toBe(400);
    expect(res.json.error).toBe("donor_resolution_required");
    // Neither gift was attached to a pledge.
    expect((await readGift(a)).paymentOnPledgeId).toBeNull();
    expect((await readGift(b)).paymentOnPledgeId).toBeNull();
  }, 30_000);

  it("returns 400 on an empty giftIds body", async () => {
    const res = await api("/api/gifts-and-payments/merge-into-pledge", {
      giftIds: [],
    });
    expect(res.status).toBe(400);
  }, 30_000);
});

describe.skipIf(!HAS_DB)(
  "POST /gifts-and-payments/:id/split-into-pledge",
  () => {
    it("splits a multi-allocation gift into a pledge + one gift per allocation", async () => {
      const giftId = await seedGiftWithAllocations(
        [
          { subAmount: "60000.00", grantYear: FY_A_ID },
          { subAmount: "40000.00", grantYear: FY_B_ID },
        ],
        { organizationId: ORG_ID },
        { grantYear: FY_A_ID },
      );

      const res = await api(
        `/api/gifts-and-payments/${giftId}/split-into-pledge`,
        { name: `Split Pledge ${RUN}` },
      );

      expect(res.status).toBe(200);
      expect(res.json.created).toBe(true);
      const pledgeId = res.json.pledgeId as string;
      seededPledgeIds.push(pledgeId);
      const giftIds = res.json.giftIds as string[];
      // Track the minted gift(s) for cleanup.
      for (const g of giftIds) {
        if (!seededGiftIds.includes(g)) seededGiftIds.push(g);
      }

      // The original gift is kept and listed first.
      expect(giftIds.length).toBe(2);
      expect(giftIds[0]).toBe(giftId);

      // Pledge: awarded = original gift amount, donor inherited, was_pledge.
      const [pledge] = await db
        .select()
        .from(schema.opportunitiesAndPledges)
        .where(eqFn(schema.opportunitiesAndPledges.id, pledgeId));
      expect(Number(pledge.awardedAmount)).toBeCloseTo(100000);
      expect(pledge.wasPledge).toBe(true);
      // Stage is always derived (never written directly): the two payment-gifts
      // fully fund the pledge, so applyDerivedOppFieldsMany resolves it to cash_in.
      expect(pledge.stage).toBe("cash_in");
      expect(pledge.organizationId).toBe(ORG_ID);

      // One pledge allocation per gift allocation, all superseded by the gifts.
      const pAllocs = await db
        .select()
        .from(schema.pledgeAllocations)
        .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, pledgeId));
      expect(pAllocs.length).toBe(2);
      expect(pAllocs.every((a) => a.status === "superseded_by_gift")).toBe(true);

      // Original gift: amount = first allocation, points at the pledge, FY_A.
      const original = await readGift(giftId);
      expect(Number(original.amount)).toBeCloseTo(60000);
      expect(original.paymentOnPledgeId).toBe(pledgeId);
      expect(original.grantYear).toBe(FY_A_ID);
      const originalAllocs = await allocationsFor(giftId);
      expect(originalAllocs.length).toBe(1);
      expect(Number(originalAllocs[0].subAmount)).toBeCloseTo(60000);

      // Minted gift: amount = second allocation, points at the pledge, FY_B.
      const mintedId = giftIds.find((g) => g !== giftId)!;
      const minted = await readGift(mintedId);
      expect(Number(minted.amount)).toBeCloseTo(40000);
      expect(minted.paymentOnPledgeId).toBe(pledgeId);
      expect(minted.organizationId).toBe(ORG_ID);
      expect(minted.grantYear).toBe(FY_B_ID);
      const mintedAllocs = await allocationsFor(mintedId);
      expect(mintedAllocs.length).toBe(1);
      expect(Number(mintedAllocs[0].subAmount)).toBeCloseTo(40000);
    }, 30_000);

    it("rejects (400 allocation_sum_mismatch) when allocations don't add up to the amount", async () => {
      // 90k of allocations against a 100k gift.
      const giftId = await seedGiftWithAllocations(
        [{ subAmount: "60000.00" }, { subAmount: "30000.00" }],
        { organizationId: ORG_ID },
        { amount: "100000.00" },
      );

      const res = await api(
        `/api/gifts-and-payments/${giftId}/split-into-pledge`,
        {},
      );

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("allocation_sum_mismatch");
      // Nothing changed — no pledge link, amount intact, allocations intact.
      const g = await readGift(giftId);
      expect(g.paymentOnPledgeId).toBeNull();
      expect(Number(g.amount)).toBeCloseTo(100000);
      expect((await allocationsFor(giftId)).length).toBe(2);
    }, 30_000);

    it("rejects (400 not_enough_allocations) a gift with a single allocation", async () => {
      const giftId = await seedGiftWithAllocation("100.00");
      const res = await api(
        `/api/gifts-and-payments/${giftId}/split-into-pledge`,
        {},
      );
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("not_enough_allocations");
      expect((await readGift(giftId)).paymentOnPledgeId).toBeNull();
    }, 30_000);

    it("rejects (409 gift_already_on_pledge) a gift that already pays a pledge", async () => {
      const pledgeId = nextId("pledge");
      await db.insert(schema.opportunitiesAndPledges).values({
        id: pledgeId,
        name: `Already Paid Pledge ${RUN}`,
        organizationId: ORG_ID,
        awardedAmount: "1000.00",
        stage: "written_commitment",
        wasPledge: true,
      });
      seededPledgeIds.push(pledgeId);
      const giftId = await seedGiftWithAllocations([
        { subAmount: "60.00" },
        { subAmount: "40.00" },
      ]);
      await db
        .update(schema.giftsAndPayments)
        .set({ paymentOnPledgeId: pledgeId })
        .where(eqFn(schema.giftsAndPayments.id, giftId));

      const res = await api(
        `/api/gifts-and-payments/${giftId}/split-into-pledge`,
        {},
      );

      expect(res.status).toBe(409);
      expect(res.json.error).toBe("gift_already_on_pledge");
      // No second pledge was created (still attached to the original).
      expect((await readGift(giftId)).paymentOnPledgeId).toBe(pledgeId);
      expect((await allocationsFor(giftId)).length).toBe(2);
    }, 30_000);

    it("blocks (409 quickbooks_linked) a gift matched to a QuickBooks staged payment", async () => {
      const giftId = await seedGiftWithAllocations([
        { subAmount: "60.00" },
        { subAmount: "40.00" },
      ]);
      await db.insert(schema.stagedPayments).values({
        id: nextId("sp"),
        realmId: REALM_ID,
        qbEntityType: "payment",
        qbEntityId: nextId("qbe"),
        amount: "100.00",
        status: "approved",
        organizationId: ORG_ID,
        matchedGiftId: giftId,
      });

      const res = await api(
        `/api/gifts-and-payments/${giftId}/split-into-pledge`,
        {},
      );

      expect(res.status).toBe(409);
      expect(res.json.error).toBe("quickbooks_linked");
      expect((await readGift(giftId)).paymentOnPledgeId).toBeNull();
    }, 30_000);

    it("blocks (409 quickbooks_linked) a gift wired into a staged-payment split", async () => {
      const giftId = await seedGiftWithAllocations([
        { subAmount: "60.00" },
        { subAmount: "40.00" },
      ]);
      const spId = nextId("sp");
      await db.insert(schema.stagedPayments).values({
        id: spId,
        realmId: REALM_ID,
        qbEntityType: "payment",
        qbEntityId: nextId("qbe"),
        amount: "100.00",
        status: "approved",
        organizationId: ORG_ID,
      });
      await db.insert(schema.stagedPaymentSplits).values({
        id: nextId("sps"),
        stagedPaymentId: spId,
        giftId,
        subAmount: "100.00",
      });

      const res = await api(
        `/api/gifts-and-payments/${giftId}/split-into-pledge`,
        {},
      );

      expect(res.status).toBe(409);
      expect(res.json.error).toBe("quickbooks_linked");
      expect((await readGift(giftId)).paymentOnPledgeId).toBeNull();
    }, 30_000);

    it("returns 404 when the gift does not exist", async () => {
      const res = await api(
        `/api/gifts-and-payments/${RUN}_missing_split/split-into-pledge`,
        {},
      );
      expect(res.status).toBe(404);
      expect(res.json.error).toBe("not_found");
    }, 30_000);
  },
);
