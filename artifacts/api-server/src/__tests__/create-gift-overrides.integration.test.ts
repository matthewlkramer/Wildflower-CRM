import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearPaymentUnitsForStagedIds,
  clearPaymentUnitsForChargeIds,
  qbMintedGiftIdForPayment,
} from "./paymentApplicationsTestUtil";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the OPTIONAL human-override bodies on the two
 * evidence-mint routes (the workbench "Create standalone gift…" dialog):
 *
 *   POST /api/staged-payments/:id/create-gift        (QuickBooks evidence)
 *   POST /api/stripe-staged-charges/:id/create-gift  (Stripe charge evidence)
 *
 * Override semantics under test (MintGiftOverridesBody):
 *   - OMITTED field → evidence-derived default (payer name / evidence date;
 *     QB entity attribution + gov-reimbursement goal-counting).
 *   - PRESENT field → overrides the minted header + seeded starter allocation.
 *   - entityId: explicit null CLEARS the QB attribution; omitted keeps it.
 *   - The gift AMOUNT is never overridable — always the evidence amount.
 *
 * Same seam as the sibling reconciliation suites: only `requireAuth` is mocked
 * to inject a seeded admin; the mint transactions are the real production code.
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `mint_ovr_user_${Date.now()}`,
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


vi.mock("@clerk/express", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/express")>();
  return {
    ...actual,
    clerkMiddleware:
      () =>
      (_req: unknown, _res: unknown, next: () => void): void =>
        next(),
  };
});

const RUN = `mintovr_${Date.now()}`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;
const ORG_ID = `${RUN}_org`;
// Second org: the pledge's donor on the payment-on-pledge tests, distinct from
// the charge's own resolved donor to PROVE the gift donor derives from the pledge.
const ORG_B = `${RUN}_org_b`;
const ENTITY_A = `${RUN}_ent_a`;
const ENTITY_B = `${RUN}_ent_b`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  entities: Db["entities"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stagedPayments: Db["stagedPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
};
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

const stagedIds: string[] = [];
const chargeIds: string[] = [];
const giftIds: string[] = [];
const oppIds: string[] = [];
const pledgeAllocIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function apiPost(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function seedStaged(opts?: { entityId?: string | null }): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "payment",
    qbEntityId: id,
    amount: "250.00",
    dateReceived: "2026-03-15",
    payerName: `${RUN} QB payer`,
    organizationId: ORG_ID,
    entityId: opts?.entityId === undefined ? ENTITY_A : opts.entityId,
  });
  stagedIds.push(id);
  return id;
}

async function seedCharge(opts?: {
  organizationId?: string | null;
}): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    grossAmount: "104.42",
    feeAmount: "3.58",
    netAmount: "100.84",
    dateReceived: "2026-03-15",
    payerName: `${RUN} Stripe payer`,
    organizationId: opts?.organizationId === undefined ? ORG_ID : opts.organizationId,
    matchStatus: "matched",
  });
  chargeIds.push(id);
  return id;
}

/**
 * Seed an opportunity/pledge (donor = ORG_B, distinct from the charge donor)
 * with ONE pledge-allocation plan line carrying ENTITY_A, for the
 * payment-on-pledge mint tests. Defaults to a live written pledge.
 */
async function seedPledge(opts?: {
  writtenPledge?: boolean;
}): Promise<{ oppId: string; allocationId: string }> {
  const oppId = nextId("opp");
  await db.insert(schema.opportunitiesAndPledges).values({
    id: oppId,
    name: `Pledge ${oppId}`,
    organizationId: ORG_B,
    stage: "written_commitment",
    awardedAmount: "500.00",
    writtenPledge: opts?.writtenPledge ?? true,
  });
  oppIds.push(oppId);
  const allocationId = nextId("palloc");
  await db.insert(schema.pledgeAllocations).values({
    id: allocationId,
    pledgeOrOpportunityId: oppId,
    subAmount: "500.00",
    entityId: ENTITY_A,
  });
  pledgeAllocIds.push(allocationId);
  return { oppId, allocationId };
}

async function readGiftWithAllocation(giftId: string) {
  const [gift] = await db
    .select()
    .from(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, giftId));
  const allocations = await db
    .select()
    .from(schema.giftAllocations)
    .where(eqFn(schema.giftAllocations.giftId, giftId));
  return { gift, allocations };
}

function trackGift(json: any): string {
  const giftId = json?.gift?.id as string;
  expect(giftId).toBeTruthy();
  giftIds.push(giftId);
  return giftId;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    entities: dbMod.entities,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stagedPayments: dbMod.stagedPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
  };
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values([
    { id: ORG_ID, name: `Mint Overrides Test Org ${RUN}` },
    { id: ORG_B, name: `Mint Overrides Pledge Org ${RUN}` },
  ]);
  await db.insert(schema.entities).values([
    { id: ENTITY_A, name: `Mint Overrides Entity A ${RUN}` },
    { id: ENTITY_B, name: `Mint Overrides Entity B ${RUN}` },
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
  // Children-first: units/ledger/ties → allocations → gifts → evidence rows →
  // entities/org → user.
  await clearPaymentUnitsForStagedIds(stagedIds);
  await clearPaymentUnitsForChargeIds(chargeIds);
  if (giftIds.length) {
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  // Pledge fixtures: allocations before their opps (RESTRICT), opps after the
  // gifts that reference them (gift.opportunityId) but before their org/entity.
  if (pledgeAllocIds.length)
    await db
      .delete(schema.pledgeAllocations)
      .where(inArrayFn(schema.pledgeAllocations.id, pledgeAllocIds));
  if (oppIds.length)
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, oppIds));
  await db
    .delete(schema.entities)
    .where(inArrayFn(schema.entities.id, [ENTITY_A, ENTITY_B]));
  await db
    .delete(schema.organizations)
    .where(inArrayFn(schema.organizations.id, [ORG_ID, ORG_B]));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)(
  "POST /staged-payments/:id/create-gift with overrides (integration)",
  () => {
    it("no body → evidence-derived defaults (payer name, evidence date, QB entity attribution, counts toward goal)", async () => {
      const spId = await seedStaged();
      const res = await apiPost(`/api/staged-payments/${spId}/create-gift`);
      expect(res.status).toBe(201);
      const giftId = trackGift(res.json);

      const { gift, allocations } = await readGiftWithAllocation(giftId);
      expect(gift.name).toBe(`${RUN} QB payer`);
      expect(gift.dateReceived).toBe("2026-03-15");
      expect(gift.amount).toBe("250.00");
      expect(allocations).toHaveLength(1);
      expect(allocations[0].entityId).toBe(ENTITY_A);
      expect(allocations[0].countsTowardGoal).toBe(true);
      expect(allocations[0].subAmount).toBe("250.00");
    }, 30_000);

    it("full overrides → name/date on the header, entity + goal-counting on the allocation; amount stays the evidence amount", async () => {
      const spId = await seedStaged();
      const res = await apiPost(`/api/staged-payments/${spId}/create-gift`, {
        name: "Custom override name",
        dateReceived: "2025-09-10",
        entityId: ENTITY_B,
        countsTowardGoal: false,
      });
      expect(res.status).toBe(201);
      const giftId = trackGift(res.json);

      const { gift, allocations } = await readGiftWithAllocation(giftId);
      expect(gift.name).toBe("Custom override name");
      expect(gift.dateReceived).toBe("2025-09-10");
      // The amount is NEVER overridable — evidence amount books.
      expect(gift.amount).toBe("250.00");
      expect(allocations).toHaveLength(1);
      expect(allocations[0].entityId).toBe(ENTITY_B);
      expect(allocations[0].countsTowardGoal).toBe(false);
      expect(allocations[0].subAmount).toBe("250.00");
    }, 30_000);

    it("explicit entityId: null clears the QB attribution; null name keeps the derived one", async () => {
      const spId = await seedStaged();
      const res = await apiPost(`/api/staged-payments/${spId}/create-gift`, {
        name: null,
        entityId: null,
      });
      expect(res.status).toBe(201);
      const giftId = trackGift(res.json);

      const { gift, allocations } = await readGiftWithAllocation(giftId);
      expect(gift.name).toBe(`${RUN} QB payer`);
      expect(allocations).toHaveLength(1);
      expect(allocations[0].entityId).toBeNull();
    }, 30_000);

    it("invalid dateReceived → 400 validation error; nothing is minted", async () => {
      const spId = await seedStaged();
      const res = await apiPost(`/api/staged-payments/${spId}/create-gift`, {
        dateReceived: "not-a-date",
      });
      expect(res.status).toBe(400);
      expect(res.json?.error).toBe("validation_error");
      expect(await qbMintedGiftIdForPayment(spId)).toBeNull();
    }, 30_000);
  },
);

describe.skipIf(!HAS_DB)(
  "POST /stripe-staged-charges/:id/create-gift with overrides (integration)",
  () => {
    it("no body → evidence-derived defaults (payer name, evidence date, no entity, counts toward goal by DB default)", async () => {
      const chargeId = await seedCharge();
      const res = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/create-gift`,
      );
      expect(res.status).toBe(201);
      const giftId = trackGift(res.json);

      const { gift, allocations } = await readGiftWithAllocation(giftId);
      expect(gift.name).toBe(`${RUN} Stripe payer`);
      expect(gift.dateReceived).toBe("2026-03-15");
      // Donor is credited GROSS.
      expect(gift.amount).toBe("104.42");
      expect(allocations).toHaveLength(1);
      expect(allocations[0].entityId).toBeNull();
      expect(allocations[0].countsTowardGoal).toBe(true);
      expect(allocations[0].subAmount).toBe("104.42");
    }, 30_000);

    it("full overrides → applied to header + allocation; amount stays the charge GROSS", async () => {
      const chargeId = await seedCharge();
      const res = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/create-gift`,
        {
          name: "Stripe override name",
          dateReceived: "2025-09-10",
          entityId: ENTITY_B,
          countsTowardGoal: false,
        },
      );
      expect(res.status).toBe(201);
      const giftId = trackGift(res.json);

      const { gift, allocations } = await readGiftWithAllocation(giftId);
      expect(gift.name).toBe("Stripe override name");
      expect(gift.dateReceived).toBe("2025-09-10");
      expect(gift.amount).toBe("104.42");
      expect(allocations).toHaveLength(1);
      expect(allocations[0].entityId).toBe(ENTITY_B);
      expect(allocations[0].countsTowardGoal).toBe(false);
      expect(allocations[0].subAmount).toBe("104.42");
    }, 30_000);
  },
);

describe.skipIf(!HAS_DB)(
  "POST /stripe-staged-charges/:id/create-gift with opportunityId (payment on pledge)",
  () => {
    it("mints under the pledge: donor from the pledge (charge donor not required), allocations copied at charge GROSS", async () => {
      // Donor-less charge: on the pledge path the charge's own resolved donor
      // is NOT required — the donor derives from the pledge (ORG_B).
      const chargeId = await seedCharge({ organizationId: null });
      const { oppId, allocationId } = await seedPledge();

      const res = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/create-gift`,
        { opportunityId: oppId },
      );
      expect(res.status).toBe(201);
      const giftId = trackGift(res.json);

      const { gift, allocations } = await readGiftWithAllocation(giftId);
      expect(gift.opportunityId).toBe(oppId);
      expect(gift.organizationId).toBe(ORG_B);
      // Donor is credited GROSS; the amount is never overridable.
      expect(gift.amount).toBe("104.42");
      // Allocations seed from the pledge's plan scaled to the charge GROSS,
      // carrying the plan's scope (entity) and the source-allocation stamp.
      expect(allocations).toHaveLength(1);
      expect(allocations[0].subAmount).toBe("104.42");
      expect(allocations[0].entityId).toBe(ENTITY_A);
      expect(allocations[0].sourcePledgeAllocationId).toBe(allocationId);

      // The charge owns the mint: pledge donor adopted onto the evidence row.
      const [charge] = await db
        .select()
        .from(schema.stripeStagedCharges)
        .where(eqFn(schema.stripeStagedCharges.id, chargeId));
      expect(charge.organizationId).toBe(ORG_B);
      expect(charge.matchStatus).toBe("matched");
    }, 30_000);

    it("refuses a non-pledge opportunity (409 not_a_pledge) and mints nothing", async () => {
      const chargeId = await seedCharge();
      const { oppId } = await seedPledge({ writtenPledge: false });

      const res = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/create-gift`,
        { opportunityId: oppId },
      );
      expect(res.status).toBe(409);
      expect(res.json?.error).toBe("not_a_pledge");

      const gifts = await db
        .select()
        .from(schema.giftsAndPayments)
        .where(eqFn(schema.giftsAndPayments.opportunityId, oppId));
      expect(gifts).toHaveLength(0);
    }, 30_000);
  },
);
