import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Per-payment unlink — POST /gifts-and-payments/:id/payment-units/:unitId/untie
 *
 * Invariants locked in here:
 *
 *   - the untie action is finance/admin gated (403 for team_member);
 *   - unknown gift / unknown unit → 404;
 *   - a unit counted against a DIFFERENT gift → 409 unit_not_tied_to_gift
 *     (the tie is verified against the gift the caller is acting on);
 *   - a successful untie clears ALL SEVEN tie facts (gift_id, allocation,
 *     match method, confirmed-by, confirmed-at, note, created_the_gift) and
 *     nothing else — the unit row itself survives;
 *   - unlinking the unit that CREATED the gift is allowed; the gift is never
 *     auto-archived;
 *   - the audit-reconciliation read view lists manual/bank-sourced units
 *     (no staged_payments row) as counted records with paymentUnitId set and
 *     null QB detail (the LEFT-join listing fix), and drops the row once the
 *     unit is untied;
 *   - Stripe-charge-sourced units are EXCLUDED from the listing (their
 *     evidence renders on the Stripe chain card) and the generic untie
 *     refuses them (409 stripe_unit_untie_unsupported) — their ties are
 *     reverted only through the Stripe-specific flows.
 *
 * Only the Clerk auth gate is mocked. Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `untieunit_${Date.now()}`;
const ADMIN_ID = `${RUN}_admin`;
const MEMBER_ID = `${RUN}_member`;
const ORG_ID = `${RUN}_org`;
const OPP_ID = `${RUN}_opp`;
const GIFT_MAIN = `${RUN}_gift_main`; // holds the created_the_gift unit
const GIFT_OTHER = `${RUN}_gift_other`; // holds the wrong-gift unit
const UNIT_TIED = `${RUN}_unit_tied`; // manual unit, no staged payment
const UNIT_OTHER = `${RUN}_unit_other`;
const CHARGE_STRIPE = `${RUN}_charge`; // staged Stripe charge evidence
const UNIT_STRIPE = `${RUN}_unit_stripe`; // stripe_charge unit tied to GIFT_MAIN

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
  giftsAndPayments: Db["giftsAndPayments"];
  paymentUnits: Db["paymentUnits"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  auditLog: Db["auditLog"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

async function untie(
  giftId: string,
  unitId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(
    `${baseUrl}/api/gifts-and-payments/${giftId}/payment-units/${unitId}/untie`,
    { method: "POST" },
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function auditView(giftId: string): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${baseUrl}/api/gifts-and-payments/${giftId}/audit-reconciliation`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
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
    giftsAndPayments: dbMod.giftsAndPayments,
    paymentUnits: dbMod.paymentUnits,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    auditLog: dbMod.auditLog,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values([
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      role: "admin",
    },
    {
      id: MEMBER_ID,
      clerkId: `clerk_${MEMBER_ID}`,
      email: `${MEMBER_ID}@wildflowerschools.org`,
      role: "team_member",
    },
  ]);
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `UntieUnit Org ${RUN}` });

  // A pledge parent so the post-untie derived-opp recompute path executes.
  await db.insert(schema.opportunitiesAndPledges).values({
    id: OPP_ID,
    name: `UntieUnit pledge ${RUN}`,
    organizationId: ORG_ID,
    stage: "verbal_confirmation",
    writtenPledge: true,
    awardedAmount: "100.00",
    loanOrGrant: "grant",
  });

  // 2099 dates: governing FY has no fiscal_years row → never audit-frozen.
  await db.insert(schema.giftsAndPayments).values([
    {
      id: GIFT_MAIN,
      name: `UntieUnit main gift ${RUN}`,
      organizationId: ORG_ID,
      opportunityId: OPP_ID,
      amount: "100.00",
      dateReceived: "2099-01-08",
    },
    {
      id: GIFT_OTHER,
      name: `UntieUnit other gift ${RUN}`,
      organizationId: ORG_ID,
      amount: "50.00",
      dateReceived: "2099-01-08",
    },
  ]);

  // Manual (bank-sourced) units: no staged_payments row on purpose — this is
  // exactly the shape the LEFT-join listing fix must surface.
  await db.insert(schema.paymentUnits).values([
    {
      id: UNIT_TIED,
      kind: "other",
      giftId: GIFT_MAIN,
      giftMatchMethod: "human",
      giftConfirmedByUserId: ADMIN_ID,
      giftConfirmedAt: new Date(),
      giftNote: "untie test tie",
      createdTheGift: true,
      grossAmount: "100.00",
      netAmount: "100.00",
      receivedDate: "2099-01-08",
    },
    {
      id: UNIT_OTHER,
      kind: "other",
      giftId: GIFT_OTHER,
      giftMatchMethod: "human",
      grossAmount: "50.00",
      netAmount: "50.00",
      receivedDate: "2099-01-08",
    },
  ]);

  // A Stripe-charge-sourced unit tied to the main gift: must be EXCLUDED
  // from the listing and refused by the generic untie.
  await db.insert(schema.stripeStagedCharges).values({
    id: CHARGE_STRIPE,
    stripeAccountId: `acct_${RUN}`,
    grossAmount: "25.00",
    netAmount: "24.00",
    dateReceived: "2099-01-08",
  });
  await db.insert(schema.paymentUnits).values({
    id: UNIT_STRIPE,
    kind: "stripe_charge",
    stripeChargeId: CHARGE_STRIPE,
    giftId: GIFT_MAIN,
    giftMatchMethod: "human",
    grossAmount: "25.00",
    netAmount: "24.00",
    receivedDate: "2099-01-08",
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
    .delete(schema.paymentUnits)
    .where(
      inArrayFn(schema.paymentUnits.id, [UNIT_TIED, UNIT_OTHER, UNIT_STRIPE]),
    );
  await db
    .delete(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, CHARGE_STRIPE));
  await db
    .delete(schema.auditLog)
    .where(inArrayFn(schema.auditLog.entityId, [GIFT_MAIN, GIFT_OTHER]));
  await db
    .delete(schema.giftsAndPayments)
    .where(inArrayFn(schema.giftsAndPayments.id, [GIFT_MAIN, GIFT_OTHER]));
  await db
    .delete(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, OPP_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db
    .delete(schema.users)
    .where(inArrayFn(schema.users.id, [ADMIN_ID, MEMBER_ID]));
}, 60_000);

describe.skipIf(!HAS_DB)("untie payment unit from gift", () => {
  it("lists a manual (no staged payment) unit as a counted record with paymentUnitId", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const view = await auditView(GIFT_MAIN);
    const counted = view.quickbooksRecords as Array<Record<string, unknown>>;
    // The tied stripe_charge unit is excluded — only the manual unit lists.
    expect(counted).toHaveLength(1);
    expect(counted[0].paymentUnitId).toBe(UNIT_TIED);
    expect(counted[0].unitKind).toBe("other");
    expect(counted[0].stagedPaymentId).toBeNull();
    expect(counted[0].linkType).toBe("created");
    expect(counted[0].amount).toBe("100.00");
    // Unit received_date fills in for the missing staged row.
    expect(counted[0].dateReceived).toBe("2099-01-08");
  });

  it("gates untie to finance/admin (403 for team_member)", async () => {
    auth.current = { id: MEMBER_ID, role: "team_member" };
    const { status, json } = await untie(GIFT_MAIN, UNIT_TIED);
    expect(status).toBe(403);
    expect(json.error).toBe("finance_role_required");
  });

  it("404s on an unknown gift", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status } = await untie(`${RUN}_missing_gift`, UNIT_TIED);
    expect(status).toBe(404);
  });

  it("404s on an unknown unit", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status } = await untie(GIFT_MAIN, `${RUN}_missing_unit`);
    expect(status).toBe(404);
  });

  it("409s when the unit is counted against a different gift", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await untie(GIFT_MAIN, UNIT_OTHER);
    expect(status).toBe(409);
    expect(json.error).toBe("unit_not_tied_to_gift");
    // The wrong-gift attempt must not have touched the other gift's tie.
    const [other] = await db
      .select({ giftId: schema.paymentUnits.giftId })
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, UNIT_OTHER));
    expect(other.giftId).toBe(GIFT_OTHER);
  });

  it("clears all seven tie facts, keeps the unit + gift, and drops the audit row", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await untie(GIFT_MAIN, UNIT_TIED);
    expect(status).toBe(200);
    expect(json.id).toBe(GIFT_MAIN);

    const [unit] = await db
      .select()
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, UNIT_TIED));
    expect(unit).toBeDefined();
    expect(unit.giftId).toBeNull();
    expect(unit.giftAllocationId).toBeNull();
    expect(unit.giftMatchMethod).toBeNull();
    expect(unit.giftConfirmedByUserId).toBeNull();
    expect(unit.giftConfirmedAt).toBeNull();
    expect(unit.giftNote).toBeNull();
    expect(unit.createdTheGift).toBe(false);
    // Non-tie facts survive untouched.
    expect(unit.grossAmount).toBe("100.00");

    // The gift survives (a created_the_gift untie never auto-archives).
    const [gift] = await db
      .select({ archivedAt: schema.giftsAndPayments.archivedAt })
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, GIFT_MAIN));
    expect(gift.archivedAt).toBeNull();

    const view = await auditView(GIFT_MAIN);
    expect(view.quickbooksRecords).toHaveLength(0);
  });

  it("second untie of the same unit is a 409 (no longer tied)", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await untie(GIFT_MAIN, UNIT_TIED);
    expect(status).toBe(409);
    expect(json.error).toBe("unit_not_tied_to_gift");
  });

  it("refuses to untie a stripe_charge unit (409) and leaves its tie intact", async () => {
    auth.current = { id: ADMIN_ID, role: "admin" };
    const { status, json } = await untie(GIFT_MAIN, UNIT_STRIPE);
    expect(status).toBe(409);
    expect(json.error).toBe("stripe_unit_untie_unsupported");
    const [unit] = await db
      .select({ giftId: schema.paymentUnits.giftId })
      .from(schema.paymentUnits)
      .where(eqFn(schema.paymentUnits.id, UNIT_STRIPE));
    expect(unit.giftId).toBe(GIFT_MAIN);
  });
});
