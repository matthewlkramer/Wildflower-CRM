import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the unified "complete-match" reconciler approve route
 * (POST /api/reconciliation/cards/:stagedPaymentId/approve), E3
 * `link_existing_gift` outcome.
 *
 * The focus is the Stripe-evidence linkage invariant: when a Stripe charge is
 * selected, the approved charge row must be tied to the gift ROW-LOCALLY
 * (`matchedGiftId` = giftId, status `reconciled`, matchStatus `matched`) so the
 * existing Stripe list/detail `resolvedGift` (COALESCE(matchedGiftId,
 * createdGiftId)) and the revert flow keep working. It also exercises:
 *   - the gift's FINAL amount stamped from the Stripe GROSS (source `stripe`,
 *     pointer = the charge) and the payout marked `confirmed_reconciled`,
 *   - the E6 gate's Stripe precedence: omitting the charge when an unreconciled
 *     charge sits on the tied payout is a 409 `consistency_gate`
 *     (`stripe_charge_required`) and mutates nothing,
 *   - the in-tx charge-availability guard: a charge already reconciled to a
 *     DIFFERENT gift is a 409 `stripe_charge_not_available`.
 *
 * Same seam as the QuickBooks confirm/reconcile suites: only the Clerk auth gate
 * (`requireAuth`) is mocked to inject a seeded admin user; the transaction, the
 * gate, and the guarded UPDATEs are the real production code. Skips automatically
 * when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `recon_apv_user_${Date.now()}`,
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

const RUN = `reconapv_${Date.now()}`;
const REALM_ID = `${RUN}_realm`;
const ORG_ID = `${RUN}_org`;
const ACCOUNT_ID = `${RUN}_acct`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stagedPayments: Db["stagedPayments"];
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

const stagedIds: string[] = [];
const giftIds: string[] = [];
const allocIds: string[] = [];
const payoutIds: string[] = [];
const chargeIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

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

async function seedGift(amount: string): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
    details: "Existing CRM gift",
  });
  const allocId = nextId("alloc");
  await db.insert(schema.giftAllocations).values({
    id: allocId,
    giftId: id,
    subAmount: amount,
  });
  giftIds.push(id);
  allocIds.push(allocId);
  return id;
}

async function seedStaged(amount: string): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    amount,
    dateReceived: "2026-03-15",
    payerName: "Stripe",
    status: "pending",
  });
  stagedIds.push(id);
  return id;
}

async function seedPayout(stagedPaymentId: string): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: "100.00",
    netTotal: "97.00",
    arrivalDate: "2026-03-15",
    qbReconciliationStatus: "proposed",
    proposedQbStagedPaymentId: stagedPaymentId,
  });
  payoutIds.push(id);
  return id;
}

async function seedCharge(opts: {
  payoutId: string;
  grossAmount: string;
  status?: "pending" | "reconciled";
  matchedGiftId?: string | null;
}): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: opts.payoutId,
    grossAmount: opts.grossAmount,
    feeAmount: "3.00",
    netAmount: "97.00",
    status: opts.status ?? "pending",
    matchedGiftId: opts.matchedGiftId ?? null,
  });
  chargeIds.push(id);
  return id;
}

async function readStaged(id: string) {
  const [row] = await db
    .select()
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, id));
  return row;
}
async function readGift(id: string) {
  const [row] = await db
    .select()
    .from(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, id));
  return row;
}
async function readCharge(id: string) {
  const [row] = await db
    .select()
    .from(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, id));
  return row;
}
async function readPayout(id: string) {
  const [row] = await db
    .select()
    .from(schema.stripePayouts)
    .where(eqFn(schema.stripePayouts.id, id));
  return row;
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
    giftAllocations: dbMod.giftAllocations,
    stagedPayments: dbMod.stagedPayments,
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Reconciliation Approve Test Org ${RUN}`,
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
  // Release the gift→evidence final-amount pointers (RESTRICT FKs) before
  // deleting the charges/staged rows; reset source to `human` to keep the
  // source↔pointer XOR CHECK satisfied.
  if (giftIds.length)
    await db
      .update(schema.giftsAndPayments)
      .set({
        finalAmountSource: "human",
        finalAmountStripeChargeId: null,
        finalAmountQbStagedPaymentId: null,
      })
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (allocIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.id, allocIds));
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[reconciliation-approve] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("Reconciliation approve — link existing gift (integration)", () => {
  it("ties the selected Stripe charge to the gift (matchedGiftId) and stamps the GROSS amount", async () => {
    const giftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00");
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(
      `/api/reconciliation/cards/${stagedId}/approve`,
      { outcome: "link_existing_gift", giftId, stripeChargeId: chargeId },
    );
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    // Core regression: the charge carries the row-local gift linkage that the
    // Stripe list/detail resolution + revert depend on.
    const charge = await readCharge(chargeId);
    expect(charge.status).toBe("reconciled");
    expect(charge.matchedGiftId).toBe(giftId);
    expect(charge.createdGiftId).toBeNull();
    expect(charge.matchStatus).toBe("matched");
    expect(charge.matchConfirmedByUserId).toBe(TEST_USER_ID);

    // QB staged row + payout become permanent reconciled evidence.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("reconciled");
    expect(staged.matchedGiftId).toBe(giftId);

    const payout = await readPayout(payoutId);
    expect(payout.qbReconciliationStatus).toBe("confirmed_reconciled");
    expect(payout.matchedQbStagedPaymentId).toBe(stagedId);

    // Gift FINAL amount stamped from the Stripe GROSS (source + pointer).
    const gift = await readGift(giftId);
    expect(gift.finalAmountSource).toBe("stripe");
    expect(gift.finalAmountStripeChargeId).toBe(chargeId);
  }, 30_000);

  it("blocks approving without the Stripe charge when an unreconciled charge exists (stripe_charge_required)", async () => {
    const giftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00");
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(
      `/api/reconciliation/cards/${stagedId}/approve`,
      { outcome: "link_existing_gift", giftId },
    );
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("consistency_gate");
    const codes = (res.json.details?.issues ?? []).map((i: any) => i.code);
    expect(codes).toContain("stripe_charge_required");

    // Nothing mutated.
    expect((await readStaged(stagedId)).status).toBe("pending");
    expect((await readCharge(chargeId)).status).toBe("pending");
  }, 30_000);

  it("rejects a Stripe charge already reconciled to a different gift (stripe_charge_not_available)", async () => {
    const otherGiftId = await seedGift("100.00");
    const targetGiftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00");
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({
      payoutId,
      grossAmount: "100.00",
      status: "reconciled",
      matchedGiftId: otherGiftId,
    });

    const res = await api(
      `/api/reconciliation/cards/${stagedId}/approve`,
      { outcome: "link_existing_gift", giftId: targetGiftId, stripeChargeId: chargeId },
    );
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("stripe_charge_not_available");

    // The charge still belongs to the original gift; the staged row is untouched.
    expect((await readCharge(chargeId)).matchedGiftId).toBe(otherGiftId);
    expect((await readStaged(stagedId)).status).toBe("pending");
  }, 30_000);
});
