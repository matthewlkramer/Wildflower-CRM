import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearPaymentUnitsForChargeIds } from "./paymentApplicationsTestUtil";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Revert a gift back into the pipeline —
 * POST /gifts-and-payments/:id/revert-to-opportunity (Task #794 step 2).
 *
 * Money-correctness invariants locked in here:
 *
 *   - success mints a fresh opportunity (awarded = gift amount, donor XOR FKs
 *     copied, loanOrGrant inherited), mirrors every gift allocation onto
 *     pledge_allocations, and ARCHIVES the gift (soft delete — rows retained);
 *   - asPledge=true → written pledge at verbal_confirmation, deriving
 *     status='pledge'; asPledge=false → open pipeline opportunity;
 *   - guards: 404 unknown gift; 409 gift_archived; 409 gift_already_on_pledge;
 *     409 payment_linked when ANY counted payment application exists —
 *     regardless of evidence source (quickbooks, stripe, donorbox) —
 *     because reverting archives the gift and would orphan booked money.
 *
 * Only the Clerk auth gate is mocked. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `giftrevert_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const ORG_ID = `${RUN}_org`;
const GIFT_PLAIN = `${RUN}_g_plain`; // revert → open opportunity
const GIFT_PLEDGED = `${RUN}_g_pledged`; // revert → written pledge
const GIFT_ARCHIVED = `${RUN}_g_archived`;
const GIFT_ON_PLEDGE = `${RUN}_g_onpledge`;
const GIFT_QB = `${RUN}_g_qb`;
const GIFT_STRIPE = `${RUN}_g_stripe`;
const OPP_EXISTING = `${RUN}_opp_existing`;
const SP_QB = `${RUN}_sp_qb`;
const PA_QB = `${RUN}_pa_qb`;
const CHARGE_STRIPE = `${RUN}_charge`;
const PA_STRIPE = `${RUN}_pa_stripe`;

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
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  pledgeAllocations: Db["pledgeAllocations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stagedPayments: Db["stagedPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  paymentApplications: Db["paymentApplications"];
  bulkOperations: Db["bulkOperations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let likeFn: (typeof import("drizzle-orm"))["like"];
let arrayContainsFn: (typeof import("drizzle-orm"))["arrayContains"];
let server: Server;
let baseUrl = "";
const mintedOppIds: string[] = [];

async function revert(
  giftId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(
    `${baseUrl}/api/gifts-and-payments/${giftId}/revert-to-opportunity`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status === 200 && typeof json.opportunityId === "string")
    mintedOppIds.push(json.opportunityId);
  return { status: res.status, json };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    pledgeAllocations: dbMod.pledgeAllocations,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stagedPayments: dbMod.stagedPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    paymentApplications: dbMod.paymentApplications,
    bulkOperations: dbMod.bulkOperations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  likeFn = drizzle.like;
  arrayContainsFn = drizzle.arrayContains;

  await db.insert(schema.users).values({
    id: ADMIN_ID,
    clerkId: `clerk_${ADMIN_ID}`,
    email: `${ADMIN_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `GiftRevert Org ${RUN}` });
  await db.insert(schema.opportunitiesAndPledges).values({
    id: OPP_EXISTING,
    name: `GiftRevert existing pledge ${RUN}`,
    organizationId: ORG_ID,
    stage: "verbal_confirmation",
    writtenPledge: true,
    awardedAmount: "400.00",
  });

  await db.insert(schema.giftsAndPayments).values([
    {
      id: GIFT_PLAIN,
      name: `GiftRevert plain ${RUN}`,
      organizationId: ORG_ID,
      amount: "900.00",
      dateReceived: "2099-05-01",
      loanOrGrant: "grant",
    },
    {
      id: GIFT_PLEDGED,
      name: `GiftRevert pledged ${RUN}`,
      organizationId: ORG_ID,
      amount: "250.00",
      dateReceived: "2099-05-02",
    },
    {
      id: GIFT_ARCHIVED,
      name: `GiftRevert archived ${RUN}`,
      organizationId: ORG_ID,
      amount: "100.00",
      dateReceived: "2099-05-03",
      archivedAt: new Date("2099-05-04T00:00:00Z"),
    },
    {
      id: GIFT_ON_PLEDGE,
      name: `GiftRevert on-pledge ${RUN}`,
      organizationId: ORG_ID,
      opportunityId: OPP_EXISTING,
      amount: "400.00",
      dateReceived: "2099-05-05",
    },
    {
      id: GIFT_QB,
      name: `GiftRevert QB-linked ${RUN}`,
      organizationId: ORG_ID,
      amount: "600.00",
      dateReceived: "2099-05-06",
    },
    {
      id: GIFT_STRIPE,
      name: `GiftRevert Stripe-linked ${RUN}`,
      organizationId: ORG_ID,
      amount: "150.00",
      dateReceived: "2099-05-07",
    },
  ]);

  // Two uneven allocations on the plain gift so the mirror is observable.
  await db.insert(schema.giftAllocations).values([
    { id: `${RUN}_ga1`, giftId: GIFT_PLAIN, subAmount: "300.00" },
    { id: `${RUN}_ga2`, giftId: GIFT_PLAIN, subAmount: "600.00" },
  ]);

  // COUNTED QuickBooks link on GIFT_QB — the revert blocker.
  await db.insert(schema.stagedPayments).values({
    id: SP_QB,
    realmId: `${RUN}_realm`,
    qbEntityType: "deposit",
    qbEntityId: SP_QB,
    amount: "600.00",
    dateReceived: "2099-05-06",
    payerName: `GiftRevert payer ${RUN}`,
  });
  await db.insert(schema.paymentApplications).values({
    id: PA_QB,
    giftId: GIFT_QB,
    paymentId: SP_QB,
    evidenceSource: "quickbooks",
    linkRole: "counted",
    amountApplied: "600.00",
  });

  // COUNTED Stripe link on GIFT_STRIPE — must ALSO block the revert
  // (regression for the source-blind guard gap found in earlier test work).
  await db.insert(schema.stripeStagedCharges).values({
    id: CHARGE_STRIPE,
    stripeAccountId: RUN,
    grossAmount: "150.00",
  });
  await db.insert(schema.paymentApplications).values({
    id: PA_STRIPE,
    giftId: GIFT_STRIPE,
    stripeChargeId: CHARGE_STRIPE,
    evidenceSource: "stripe",
    linkRole: "counted",
    amountApplied: "150.00",
  });

  auth.current = { id: ADMIN_ID, role: "admin" };
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
    .delete(schema.paymentApplications)
    .where(inArrayFn(schema.paymentApplications.id, [PA_QB, PA_STRIPE]));
  await db
    .delete(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, SP_QB));
  await clearPaymentUnitsForChargeIds([CHARGE_STRIPE]);
  await db
    .delete(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, CHARGE_STRIPE));
  await db
    .delete(schema.bulkOperations)
    .where(
      arrayContainsFn(schema.bulkOperations.targetIds, [GIFT_PLAIN]),
    );
  await db
    .delete(schema.bulkOperations)
    .where(
      arrayContainsFn(schema.bulkOperations.targetIds, [GIFT_PLEDGED]),
    );
  await db
    .delete(schema.giftAllocations)
    .where(likeFn(schema.giftAllocations.id, `${RUN}%`));
  await db
    .delete(schema.giftsAndPayments)
    .where(likeFn(schema.giftsAndPayments.id, `${RUN}%`));
  if (mintedOppIds.length) {
    await db
      .delete(schema.pledgeAllocations)
      .where(
        inArrayFn(schema.pledgeAllocations.pledgeOrOpportunityId, mintedOppIds),
      );
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, mintedOppIds));
  }
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, OPP_EXISTING));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, ADMIN_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("gift revert-to-opportunity", () => {
  it("reverts a plain gift: opp minted with awarded = amount, allocations mirrored, gift archived", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await revert(GIFT_PLAIN, { asPledge: false });
    expect(status).toBe(200);
    const oppId = json.opportunityId as string;
    expect(oppId).toBeTruthy();

    const [opp] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(eqFn(schema.opportunitiesAndPledges.id, oppId));
    expect(Number(opp.awardedAmount)).toBeCloseTo(900);
    expect(opp.organizationId).toBe(ORG_ID);
    expect(opp.individualGiverPersonId).toBeNull();
    expect(opp.householdId).toBeNull();
    expect(opp.loanOrGrant).toBe("grant");
    expect(opp.writtenPledge).toBe(false);
    expect(opp.stage).toBe("in_conversation");
    expect(opp.status).toBe("open"); // derived, not pledge

    // Allocations mirrored 1:1 onto pledge_allocations, sums preserved.
    const pa = await db
      .select()
      .from(schema.pledgeAllocations)
      .where(eqFn(schema.pledgeAllocations.pledgeOrOpportunityId, oppId));
    expect(pa.map((a) => Number(a.subAmount)).sort((x, y) => x - y)).toEqual([
      300, 600,
    ]);

    // Source gift is ARCHIVED (soft delete), its allocation rows retained.
    const [gift] = await db
      .select()
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, GIFT_PLAIN));
    expect(gift.archivedAt).not.toBeNull();
    const ga = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, GIFT_PLAIN));
    expect(ga.length).toBe(2);
  });

  it("asPledge=true mints a WRITTEN pledge whose derived status is 'pledge'", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await revert(GIFT_PLEDGED, {
      asPledge: true,
      name: `GiftRevert as pledge ${RUN}`,
    });
    expect(status).toBe(200);
    const [opp] = await db
      .select()
      .from(schema.opportunitiesAndPledges)
      .where(
        eqFn(schema.opportunitiesAndPledges.id, json.opportunityId as string),
      );
    expect(opp.writtenPledge).toBe(true);
    // Derivation promotes a won pledge's funnel stage to terminal 'complete'.
    expect(opp.stage).toBe("complete");
    expect(opp.status).toBe("pledge"); // derived from the writtenPledge latch
    expect(opp.name).toBe(`GiftRevert as pledge ${RUN}`);
  });

  it("404s on an unknown gift", async () => {
    const { status } = await revert(`${RUN}_nope`);
    expect(status).toBe(404);
  });

  it("409 gift_archived — restore before reverting", async () => {
    const { status, json } = await revert(GIFT_ARCHIVED);
    expect(status).toBe(409);
    expect(json.error).toBe("gift_archived");
  });

  it("409 gift_already_on_pledge — a pledge payment must be detached first", async () => {
    const { status, json } = await revert(GIFT_ON_PLEDGE);
    expect(status).toBe(409);
    expect(json.error).toBe("gift_already_on_pledge");
  });

  it("409 payment_linked — a counted QuickBooks payment application blocks the revert", async () => {
    const { status, json } = await revert(GIFT_QB);
    expect(status).toBe(409);
    expect(json.error).toBe("payment_linked");
    expect(json.evidenceSources).toEqual(["quickbooks"]);
    // The gift stays live and the counted link untouched.
    const [gift] = await db
      .select()
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, GIFT_QB));
    expect(gift.archivedAt).toBeNull();
  });

  it("409 payment_linked — a counted STRIPE payment application also blocks the revert (regression)", async () => {
    const { status, json } = await revert(GIFT_STRIPE);
    expect(status).toBe(409);
    expect(json.error).toBe("payment_linked");
    expect(json.evidenceSources).toEqual(["stripe"]);
    // The gift stays live — no orphaned counted link at an archived gift.
    const [gift] = await db
      .select()
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, GIFT_STRIPE));
    expect(gift.archivedAt).toBeNull();
    const [pa] = await db
      .select()
      .from(schema.paymentApplications)
      .where(eqFn(schema.paymentApplications.id, PA_STRIPE));
    expect(pa).toBeTruthy();
  });
});
