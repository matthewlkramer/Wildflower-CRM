import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the Stripe-charge anchor on the reconciliation search
 * endpoint (GET /api/reconciliation/search/:nodeType).
 *
 * The settlement-bundle workbench lets a fundraiser click "Match" on a Stripe
 * charge row that has NO staged payment and search for an existing gift. That
 * search must anchor on the charge's GROSS amount + date instead of a QB staged
 * row. These tests assert:
 *   - passing neither / both anchors is a 400 (exactly-one),
 *   - a Stripe charge anchor rejects opportunity/qb node types (they need a
 *     staged anchor) but allows donor/gift,
 *   - gift search anchored on a charge returns a gift inside the charge's
 *     GROSS-amount / date window,
 *   - an unknown charge id is a 404.
 *
 * Same seam as the sibling reconciliation suites: only `requireAuth` is mocked
 * to inject a seeded admin user; the SQL and the route validation are real
 * production code. Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `recon_search_user_${Date.now()}`,
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

const RUN = `reconsearch_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ACCOUNT_ID = `${RUN}_acct`;
const PAYOUT_ID = `${RUN}_po`;
const CHARGE_ID = `${RUN}_ch`;
const GIFT_ID = `${RUN}_gift`;
// A gift linked ONLY via the QuickBooks cash-application ledger (no charge).
const GIFT_QB_ID = `${RUN}_gift_qb`;
const STAGED_ID = `${RUN}_staged`; // the QB payment that owns GIFT_QB_ID
const STAGED_ANCHOR_ID = `${RUN}_staged_anchor`; // a separate QB search anchor
const PAYAPP_ID = `${RUN}_payapp`;
// A gift already owned by ANOTHER Stripe charge (matched).
const GIFT_CH_ID = `${RUN}_gift_ch`;
const CHARGE_B_ID = `${RUN}_ch_b`;
const REALM_ID = `${RUN}_realm`;
// A far-future date keeps the anchor window clear of any real gifts.
const ANCHOR_DATE = "2099-12-15";

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  stagedPayments: Db["stagedPayments"];
  paymentApplications: Db["paymentApplications"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

type Candidate = {
  nodeType: string;
  id: string;
  label: string;
  alreadyLinkedStagedPaymentId?: string | null;
};

async function searchNode(
  nodeType: string,
  qs: string,
): Promise<{ status: number; json: { data?: Candidate[] } }> {
  const res = await fetch(
    `${baseUrl}/api/reconciliation/search/${nodeType}?${qs}`,
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as { data?: Candidate[] } };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    stagedPayments: dbMod.stagedPayments,
    paymentApplications: dbMod.paymentApplications,
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
    name: `Reconciliation Search Test Org ${RUN}`,
  });
  // A gift inside the charge's GROSS-amount / date window (same amount + date).
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    organizationId: ORG_ID,
    ownerUserId: TEST_USER_ID,
    amount: "100.00",
    dateReceived: ANCHOR_DATE,
  });
  await db.insert(schema.stripePayouts).values({
    id: PAYOUT_ID,
    stripeAccountId: ACCOUNT_ID,
    amount: "100.00",
    netTotal: "96.80",
    arrivalDate: ANCHOR_DATE,
    chargeCount: 1,
    qbReconciliationStatus: "unmatched" as never,
  });
  await db.insert(schema.stripeStagedCharges).values({
    id: CHARGE_ID,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: PAYOUT_ID,
    grossAmount: "100.00",
    feeAmount: "3.20",
    netAmount: "96.80",
    dateReceived: ANCHOR_DATE,
    payerName: `Zztest Search Charge ${RUN}`,
    payerEmail: `${RUN}-charge@example.invalid`,
    status: "pending" as never,
  });

  // A gift in the same window linked ONLY via the QuickBooks cash-application
  // ledger (a QB staged payment applied to it) — no Stripe charge owns it.
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_QB_ID,
    organizationId: ORG_ID,
    ownerUserId: TEST_USER_ID,
    amount: "100.00",
    dateReceived: ANCHOR_DATE,
  });
  for (const id of [STAGED_ID, STAGED_ANCHOR_ID]) {
    await db.insert(schema.stagedPayments).values({
      id,
      realmId: REALM_ID,
      qbEntityType: "payment",
      qbEntityId: id,
      qbLineId: "",
      amount: "100.00",
      dateReceived: ANCHOR_DATE,
      payerName: `Zztest QB Payer ${RUN}`,
      status: "pending" as never,
    });
  }
  await db.insert(schema.paymentApplications).values({
    id: PAYAPP_ID,
    paymentId: STAGED_ID,
    giftId: GIFT_QB_ID,
    amountApplied: "100.00",
    evidenceSource: "quickbooks" as never,
  });

  // A gift in the same window already owned by ANOTHER Stripe charge (matched).
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_CH_ID,
    organizationId: ORG_ID,
    ownerUserId: TEST_USER_ID,
    amount: "100.00",
    dateReceived: ANCHOR_DATE,
  });
  await db.insert(schema.stripeStagedCharges).values({
    id: CHARGE_B_ID,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: PAYOUT_ID,
    grossAmount: "100.00",
    feeAmount: "3.20",
    netAmount: "96.80",
    dateReceived: ANCHOR_DATE,
    payerName: `Zztest Owning Charge ${RUN}`,
    payerEmail: `${RUN}-charge-b@example.invalid`,
    status: "reconciled" as never,
    matchedGiftId: GIFT_CH_ID,
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
  // payment_applications FKs (gift + staged payment) are ON DELETE RESTRICT, so
  // the ledger row must go before its anchors.
  await db
    .delete(schema.paymentApplications)
    .where(eqFn(schema.paymentApplications.id, PAYAPP_ID));
  for (const id of [CHARGE_ID, CHARGE_B_ID]) {
    await db
      .delete(schema.stripeStagedCharges)
      .where(eqFn(schema.stripeStagedCharges.id, id));
  }
  for (const id of [STAGED_ID, STAGED_ANCHOR_ID]) {
    await db
      .delete(schema.stagedPayments)
      .where(eqFn(schema.stagedPayments.id, id));
  }
  await db
    .delete(schema.stripePayouts)
    .where(eqFn(schema.stripePayouts.id, PAYOUT_ID));
  for (const id of [GIFT_ID, GIFT_QB_ID, GIFT_CH_ID]) {
    await db
      .delete(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, id));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[reconciliation-search-charge-anchor] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("reconciliation search charge anchor (integration)", () => {
  it("400s when neither anchor is provided", async () => {
    const { status } = await searchNode("gift", "");
    expect(status).toBe(400);
  });

  it("400s when BOTH anchors are provided", async () => {
    const { status } = await searchNode(
      "gift",
      `stagedPaymentId=whatever&stripeChargeId=${CHARGE_ID}`,
    );
    expect(status).toBe(400);
  });

  it("400s for a node type a charge anchor cannot support (opportunity/qb)", async () => {
    const opp = await searchNode("opportunity", `stripeChargeId=${CHARGE_ID}`);
    expect(opp.status).toBe(400);
    const qb = await searchNode("qb", `stripeChargeId=${CHARGE_ID}`);
    expect(qb.status).toBe(400);
  });

  it("404s for an unknown charge id", async () => {
    const { status } = await searchNode(
      "gift",
      `stripeChargeId=${RUN}_does_not_exist`,
    );
    expect(status).toBe(404);
  });

  it("returns a gift inside the charge's GROSS-amount / date window", async () => {
    const { status, json } = await searchNode(
      "gift",
      `stripeChargeId=${CHARGE_ID}`,
    );
    expect(status).toBe(200);
    const hit = (json.data ?? []).find((c) => c.id === GIFT_ID);
    expect(hit).toBeDefined();
    expect(hit!.nodeType).toBe("gift");
  });

  it("from a charge anchor, a gift linked ONLY by a QB payment stays selectable", async () => {
    // The regression: QB + Stripe are parallel evidence for one gift, so a
    // gift's QuickBooks cash-application must NOT disable linking a Stripe
    // charge to it.
    const { status, json } = await searchNode(
      "gift",
      `stripeChargeId=${CHARGE_ID}`,
    );
    expect(status).toBe(200);
    const hit = (json.data ?? []).find((c) => c.id === GIFT_QB_ID);
    expect(hit).toBeDefined();
    expect(hit!.alreadyLinkedStagedPaymentId ?? null).toBeNull();
  });

  it("from a charge anchor, a gift owned by ANOTHER charge is flagged", async () => {
    const { status, json } = await searchNode(
      "gift",
      `stripeChargeId=${CHARGE_ID}`,
    );
    expect(status).toBe(200);
    const hit = (json.data ?? []).find((c) => c.id === GIFT_CH_ID);
    expect(hit).toBeDefined();
    expect(hit!.alreadyLinkedStagedPaymentId).toBe(CHARGE_B_ID);
  });

  it("from a QB staged anchor, a QB-ledger-linked gift stays flagged (unchanged)", async () => {
    // The staged-anchor path must keep disabling gifts already tied via the QB
    // ledger to a DIFFERENT staged payment.
    const { status, json } = await searchNode(
      "gift",
      `stagedPaymentId=${STAGED_ANCHOR_ID}`,
    );
    expect(status).toBe(200);
    const hit = (json.data ?? []).find((c) => c.id === GIFT_QB_ID);
    expect(hit).toBeDefined();
    expect(hit!.alreadyLinkedStagedPaymentId).toBe(STAGED_ID);
  });
});
