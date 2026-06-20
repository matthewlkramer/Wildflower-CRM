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
const ORG2_ID = `${RUN}_org2`;
const ACCOUNT_ID = `${RUN}_acct`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  opportunitiesAndPledges: Db["opportunitiesAndPledges"];
  stagedPayments: Db["stagedPayments"];
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  giftAmountAllocationReview: Db["giftAmountAllocationReview"];
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
const oppIds: string[] = [];
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

async function apiGet(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "GET" });
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

async function seedStaged(
  amount: string,
  opts: {
    payerName?: string;
    status?: "pending" | "approved" | "reconciled";
    organizationId?: string | null;
    matchStatus?: "matched" | "suggested" | "unmatched";
  } = {},
): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    amount,
    dateReceived: "2026-03-15",
    payerName: opts.payerName ?? "Stripe",
    status: opts.status ?? "pending",
    ...(opts.organizationId !== undefined
      ? { organizationId: opts.organizationId }
      : {}),
    ...(opts.matchStatus !== undefined ? { matchStatus: opts.matchStatus } : {}),
  });
  stagedIds.push(id);
  return id;
}

// A gift that is a payment on an existing pledge/opportunity (donor ORG_ID),
// used to exercise the gift-donor-switch pledge-consistency block.
async function seedGiftOnPledge(
  amount: string,
  pledgeId: string,
): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
    paymentOnPledgeId: pledgeId,
    details: "Payment on pledge",
  });
  const allocId = nextId("alloc");
  await db
    .insert(schema.giftAllocations)
    .values({ id: allocId, giftId: id, subAmount: amount });
  giftIds.push(id);
  allocIds.push(allocId);
  return id;
}

// A gift with an explicit number of allocations (0, 1, or 2+) so the allocation
// rescale-vs-flag primitive can be exercised across all branches.
async function seedGiftWithAllocations(
  amount: string,
  subAmounts: string[],
): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
    details: "Allocation primitive gift",
  });
  giftIds.push(id);
  for (const sub of subAmounts) {
    const allocId = nextId("alloc");
    await db
      .insert(schema.giftAllocations)
      .values({ id: allocId, giftId: id, subAmount: sub });
    allocIds.push(allocId);
  }
  return id;
}

// Archived gift for the chosen org — used to prove the scoped gift search
// excludes archived rows.
async function seedArchivedGift(amount: string): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
    details: "Archived CRM gift",
    archivedAt: new Date(),
  });
  const allocId = nextId("alloc");
  await db
    .insert(schema.giftAllocations)
    .values({ id: allocId, giftId: id, subAmount: amount });
  giftIds.push(id);
  allocIds.push(allocId);
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

async function seedOpp(opts: {
  stage:
    | "in_conversation"
    | "conditional_commitment"
    | "written_commitment"
    | "cash_in";
  awardedAmount?: string | null;
  wasPledge?: boolean;
  lossType?: "dormant" | "lost" | null;
}): Promise<string> {
  const id = nextId("opp");
  await db.insert(schema.opportunitiesAndPledges).values({
    id,
    name: `Opp ${id}`,
    organizationId: ORG_ID,
    stage: opts.stage,
    awardedAmount: opts.awardedAmount ?? null,
    wasPledge: opts.wasPledge ?? false,
    lossType: opts.lossType ?? null,
  });
  oppIds.push(id);
  return id;
}
async function readOpp(id: string) {
  const [row] = await db
    .select()
    .from(schema.opportunitiesAndPledges)
    .where(eqFn(schema.opportunitiesAndPledges.id, id));
  return row;
}

// OPEN gift_amount_allocation_review rows for a gift (resolved_at IS NULL). The
// partial-unique index guarantees at most one, so this proves the flag-vs-upsert
// behavior of adjustSingleAllocationOrFlag.
async function readOpenReviews(giftId: string) {
  const rows = await db
    .select()
    .from(schema.giftAmountAllocationReview)
    .where(eqFn(schema.giftAmountAllocationReview.giftId, giftId));
  return rows.filter((r) => r.resolvedAt == null);
}

async function readAlloc(id: string) {
  const [row] = await db
    .select()
    .from(schema.giftAllocations)
    .where(eqFn(schema.giftAllocations.id, id));
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
    opportunitiesAndPledges: dbMod.opportunitiesAndPledges,
    stagedPayments: dbMod.stagedPayments,
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    giftAmountAllocationReview: dbMod.giftAmountAllocationReview,
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
  await db.insert(schema.organizations).values({
    id: ORG2_ID,
    name: `Reconciliation Approve Test Org2 ${RUN}`,
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
  // Opportunities are referenced by gifts (paymentOnPledgeId) and by the org;
  // delete them after the gifts above and before the org below.
  if (oppIds.length)
    await db
      .delete(schema.opportunitiesAndPledges)
      .where(inArrayFn(schema.opportunitiesAndPledges.id, oppIds));
  await db
    .delete(schema.organizations)
    .where(inArrayFn(schema.organizations.id, [ORG_ID, ORG2_ID]));
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

describe.skipIf(!HAS_DB)("Reconciliation approve — create gift (integration)", () => {
  it("mints a new gift for the chosen donor and stamps the Stripe GROSS (createdGiftId on the QB anchor, matchedGiftId on the charge)", async () => {
    const stagedId = await seedStaged("100.00");
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
      stripeChargeId: chargeId,
    });
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
    expect(res.json.outcome).toBe("create_gift");
    expect(res.json.createdGift).toBe(true);
    expect(res.json.createdPledge).toBe(false);
    expect(res.json.opportunityId).toBeNull();
    const newGiftId = res.json.giftId as string;
    expect(newGiftId).toBeTruthy();
    giftIds.push(newGiftId);

    // The minted gift carries the chosen donor and the Stripe-GROSS provenance;
    // no prior human figure was snapshotted.
    const gift = await readGift(newGiftId);
    expect(gift.organizationId).toBe(ORG_ID);
    expect(gift.amount).toBe("100.00");
    expect(gift.finalAmountSource).toBe("stripe");
    expect(gift.finalAmountStripeChargeId).toBe(chargeId);
    expect(gift.finalAmountQbStagedPaymentId).toBeNull();
    expect(gift.originalHumanCrmAmount).toBeNull();
    expect(gift.processorFee).toBe("3.00");

    // The QB anchor OWNS the mint (createdGiftId, not auto-applied); the charge
    // is matchedGiftId-linked precise evidence; the payout is confirmed.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("reconciled");
    expect(staged.createdGiftId).toBe(newGiftId);
    expect(staged.matchedGiftId).toBeNull();
    expect(staged.autoApplied).toBe(false);
    expect(staged.matchStatus).toBe("matched");
    expect(staged.organizationId).toBe(ORG_ID);

    const charge = await readCharge(chargeId);
    expect(charge.status).toBe("reconciled");
    expect(charge.matchedGiftId).toBe(newGiftId);
    expect(charge.createdGiftId).toBeNull();

    const payout = await readPayout(payoutId);
    expect(payout.qbReconciliationStatus).toBe("confirmed_reconciled");
    expect(payout.matchedQbStagedPaymentId).toBe(stagedId);
  }, 30_000);

  it("mints a QB-only gift (no Stripe) stamped from the QB staged amount", async () => {
    const stagedId = await seedStaged("250.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
    });
    expect(res.status).toBe(201);
    const newGiftId = res.json.giftId as string;
    expect(newGiftId).toBeTruthy();
    giftIds.push(newGiftId);

    const gift = await readGift(newGiftId);
    expect(gift.amount).toBe("250.00");
    expect(gift.finalAmountSource).toBe("quickbooks");
    expect(gift.finalAmountQbStagedPaymentId).toBe(stagedId);
    expect(gift.finalAmountStripeChargeId).toBeNull();
    expect(gift.originalHumanCrmAmount).toBeNull();

    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("reconciled");
    expect(staged.createdGiftId).toBe(newGiftId);
    expect(staged.autoApplied).toBe(false);
  }, 30_000);

  it("rejects a mint with no donor (Donor XOR)", async () => {
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("validation_error");

    // Nothing mutated.
    expect((await readStaged(stagedId)).status).toBe("pending");
  }, 30_000);

  it("requires the Stripe charge when an unreconciled charge exists (stripe_charge_required)", async () => {
    const stagedId = await seedStaged("100.00");
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("consistency_gate");
    const codes = (res.json.details?.issues ?? []).map((i: any) => i.code);
    expect(codes).toContain("stripe_charge_required");

    // Nothing minted or mutated.
    expect((await readStaged(stagedId)).status).toBe("pending");
    expect((await readCharge(chargeId)).status).toBe("pending");
  }, 30_000);

  it("is not idempotent — re-approving an already-reconciled row is rejected (not_approvable)", async () => {
    const stagedId = await seedStaged("100.00");

    const first = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
    });
    expect(first.status).toBe(201);
    giftIds.push(first.json.giftId as string);

    const second = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
    });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("not_approvable");

    // Still tied to the FIRST minted gift only.
    const staged = await readStaged(stagedId);
    expect(staged.createdGiftId).toBe(first.json.giftId);
  }, 30_000);
});

describe.skipIf(!HAS_DB)("Reconciliation approve — opportunity targets (integration)", () => {
  it("create_gift_from_opportunity ties the minted gift to the opp (paymentOnPledgeId), derives the donor from the opp, and the opp derives cash_in when fully paid", async () => {
    // A pledge awaiting its (full) payment.
    const oppId = await seedOpp({
      stage: "written_commitment",
      wasPledge: true,
      awardedAmount: "100.00",
    });
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift_from_opportunity",
      opportunityId: oppId,
    });
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
    expect(res.json.outcome).toBe("create_gift_from_opportunity");
    expect(res.json.createdGift).toBe(true);
    expect(res.json.createdPledge).toBe(false);
    expect(res.json.opportunityId).toBe(oppId);
    const giftId = res.json.giftId as string;
    expect(giftId).toBeTruthy();
    giftIds.push(giftId);

    // The gift is tied to the opp and inherits the opp's donor (NOT a body donor).
    const gift = await readGift(giftId);
    expect(gift.paymentOnPledgeId).toBe(oppId);
    expect(gift.organizationId).toBe(ORG_ID);
    expect(gift.amount).toBe("100.00");
    expect(gift.finalAmountSource).toBe("quickbooks");
    expect(gift.finalAmountQbStagedPaymentId).toBe(stagedId);

    // The QB anchor owns the mint.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("reconciled");
    expect(staged.createdGiftId).toBe(giftId);

    // Fully paid (100 >= awarded 100) ⇒ the opp derives to cash_in (stage advances).
    const opp = await readOpp(oppId);
    expect(opp.status).toBe("cash_in");
    expect(opp.stage).toBe("cash_in");
    expect(opp.wasPledge).toBe(true);
  }, 30_000);

  it("create_gift_from_opportunity against a partially-paid pledge leaves it a pledge (paid < awarded)", async () => {
    const oppId = await seedOpp({
      stage: "written_commitment",
      wasPledge: true,
      awardedAmount: "500.00",
    });
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift_from_opportunity",
      opportunityId: oppId,
    });
    expect(res.status).toBe(201);
    giftIds.push(res.json.giftId as string);

    const opp = await readOpp(oppId);
    expect(opp.status).toBe("pledge");
    expect(opp.stage).toBe("written_commitment");
    expect(opp.awardedAmount).toBe("500.00");
  }, 30_000);

  it("convert_to_pledge_and_first_payment latches an OPEN opp into a pledge, sets awarded from the evidence, and books the first payment", async () => {
    const oppId = await seedOpp({
      stage: "in_conversation",
      wasPledge: false,
      awardedAmount: null,
    });
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "convert_to_pledge_and_first_payment",
      opportunityId: oppId,
    });
    expect(res.status).toBe(201);
    expect(res.json.outcome).toBe("convert_to_pledge_and_first_payment");
    expect(res.json.createdPledge).toBe(true);
    const giftId = res.json.giftId as string;
    giftIds.push(giftId);

    const gift = await readGift(giftId);
    expect(gift.paymentOnPledgeId).toBe(oppId);
    expect(gift.organizationId).toBe(ORG_ID);

    // Latched into a pledge: was_pledge derived true, awarded filled from the
    // evidence (was null), and a single full payment derives it to cash_in.
    const opp = await readOpp(oppId);
    expect(opp.wasPledge).toBe(true);
    expect(opp.awardedAmount).toBe("100.00");
    expect(opp.status).toBe("cash_in");
    expect(opp.stage).toBe("cash_in");
  }, 30_000);

  it("convert_to_pledge_and_first_payment preserves a real awarded amount (partial first payment stays a pledge)", async () => {
    const oppId = await seedOpp({
      stage: "in_conversation",
      wasPledge: false,
      awardedAmount: "500.00",
    });
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "convert_to_pledge_and_first_payment",
      opportunityId: oppId,
    });
    expect(res.status).toBe(201);
    giftIds.push(res.json.giftId as string);

    const opp = await readOpp(oppId);
    expect(opp.awardedAmount).toBe("500.00");
    expect(opp.stage).toBe("written_commitment");
    expect(opp.status).toBe("pledge");
    expect(opp.wasPledge).toBe(true);
  }, 30_000);

  it("convert_to_pledge_and_first_payment rejects an opp already latched as a pledge (already_pledge) and mutates nothing", async () => {
    const oppId = await seedOpp({
      stage: "written_commitment",
      wasPledge: true,
      awardedAmount: "100.00",
    });
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "convert_to_pledge_and_first_payment",
      opportunityId: oppId,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("already_pledge");

    // Nothing minted or mutated.
    expect((await readStaged(stagedId)).status).toBe("pending");
    const opp = await readOpp(oppId);
    expect(opp.stage).toBe("written_commitment");
    expect(opp.wasPledge).toBe(true);
  }, 30_000);

  it("convert_to_pledge_and_first_payment rejects an opp with a loss_type override (already_pledge)", async () => {
    const oppId = await seedOpp({
      stage: "in_conversation",
      wasPledge: false,
      lossType: "dormant",
    });
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "convert_to_pledge_and_first_payment",
      opportunityId: oppId,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("already_pledge");
    expect((await readStaged(stagedId)).status).toBe("pending");
  }, 30_000);

  it("create_gift_from_opportunity stamps the Stripe GROSS when a charge is selected (charge matchedGiftId, payout confirmed_reconciled)", async () => {
    const oppId = await seedOpp({
      stage: "written_commitment",
      wasPledge: true,
      awardedAmount: "100.00",
    });
    const stagedId = await seedStaged("100.00");
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift_from_opportunity",
      opportunityId: oppId,
      stripeChargeId: chargeId,
    });
    expect(res.status).toBe(201);
    const giftId = res.json.giftId as string;
    giftIds.push(giftId);

    const gift = await readGift(giftId);
    expect(gift.paymentOnPledgeId).toBe(oppId);
    expect(gift.finalAmountSource).toBe("stripe");
    expect(gift.finalAmountStripeChargeId).toBe(chargeId);
    expect(gift.finalAmountQbStagedPaymentId).toBeNull();
    expect(gift.processorFee).toBe("3.00");

    const charge = await readCharge(chargeId);
    expect(charge.status).toBe("reconciled");
    expect(charge.matchedGiftId).toBe(giftId);

    const payout = await readPayout(payoutId);
    expect(payout.qbReconciliationStatus).toBe("confirmed_reconciled");

    const staged = await readStaged(stagedId);
    expect(staged.createdGiftId).toBe(giftId);
  }, 30_000);

  it("create_gift IGNORES a stray opportunityId — mints for the body donor, does NOT attach to the opp or re-derive it", async () => {
    // A plain create_gift carrying a leftover/stale opportunityId must keep
    // create_gift semantics (donor from body; no opportunity), never hijack the
    // donor from the opp or attach the payment to it.
    const oppId = await seedOpp({
      stage: "in_conversation",
      wasPledge: false,
      awardedAmount: null,
    });
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
      opportunityId: oppId,
    });
    expect(res.status).toBe(201);
    expect(res.json.outcome).toBe("create_gift");
    expect(res.json.opportunityId).toBeNull();
    const giftId = res.json.giftId as string;
    giftIds.push(giftId);

    // The gift is a plain donor gift — NOT tied to the opportunity.
    const gift = await readGift(giftId);
    expect(gift.organizationId).toBe(ORG_ID);
    expect(gift.paymentOnPledgeId).toBeNull();

    // The opportunity is completely untouched (no stage advance, no derivation).
    const opp = await readOpp(oppId);
    expect(opp.stage).toBe("in_conversation");
    expect(opp.wasPledge).toBe(false);
  }, 30_000);

  it("create_gift_from_opportunity requires an opportunityId (validation_error)", async () => {
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift_from_opportunity",
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("validation_error");

    // Nothing minted or mutated.
    expect((await readStaged(stagedId)).status).toBe("pending");
  }, 30_000);
});

describe.skipIf(!HAS_DB)("Reconciliation graph — read-only proposer (integration)", () => {
  it("returns the QB anchor as evidence.qb and the Stripe charge as attached evidence (gross), with exactly the donor/gift/opportunity nodes", async () => {
    const stagedId = await seedStaged("100.00");
    const payoutId = await seedPayout(stagedId);
    await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await apiGet(`/api/reconciliation/cards/${stagedId}/graph`);
    expect(res.status).toBe(200);

    // QB is the REQUIRED anchor (evidence.qb), never a node.
    expect(res.json.stagedPaymentId).toBe(stagedId);
    expect(res.json.evidence.qb.stagedPaymentId).toBe(stagedId);
    expect(res.json.evidence.qb.amount).toBe("100.00");

    // Stripe is attached EVIDENCE carrying the per-payout gross — the figure that
    // takes precedence over the QB amount when a charge backs the same money.
    expect(res.json.evidence.stripe).not.toBeNull();
    expect(res.json.evidence.stripe.payoutId).toBe(payoutId);
    expect(res.json.evidence.stripe.grossAmount).toBe("100.00");
    expect(res.json.evidence.stripe.chargeCount).toBeGreaterThanOrEqual(1);

    // The graph carries exactly the three resolvable nodes; QB is the anchor, not a node.
    const nodeTypes = (res.json.nodes as Array<{ nodeType: string }>)
      .map((n) => n.nodeType)
      .sort();
    expect(nodeTypes).toEqual(["donor", "gift", "opportunity"]);
  }, 30_000);

  it("derives a determined donor node from a single confirmed donor match, and none when the QB row has no donor", async () => {
    // payerName is deliberately gibberish so the QB name-matcher finds no second
    // donor — isolating the saved (confirmed) donor pick.
    const matchedStaged = await seedStaged("100.00", {
      payerName: `zzznomatch_${RUN}`,
      organizationId: ORG_ID,
      matchStatus: "matched",
    });
    const matchedRes = await apiGet(
      `/api/reconciliation/cards/${matchedStaged}/graph`,
    );
    expect(matchedRes.status).toBe(200);
    const donorNode = (matchedRes.json.nodes as Array<any>).find(
      (n) => n.nodeType === "donor",
    );
    expect(donorNode.state).toBe("determined");
    expect(donorNode.selectedId).toBe(ORG_ID);
    expect(donorNode.locked).toBe(true);

    const bareStaged = await seedStaged("100.00", {
      payerName: `zzznomatch_${RUN}`,
    });
    const bareRes = await apiGet(`/api/reconciliation/cards/${bareStaged}/graph`);
    const bareDonor = (bareRes.json.nodes as Array<any>).find(
      (n) => n.nodeType === "donor",
    );
    expect(bareDonor.state).toBe("none");
    expect(bareDonor.selectedId).toBeNull();
  }, 30_000);

  it("404s for an unknown staged payment id", async () => {
    const res = await apiGet(
      `/api/reconciliation/cards/sp_missing_${RUN}/graph`,
    );
    expect(res.status).toBe(404);
  }, 30_000);
});

describe.skipIf(!HAS_DB)("Reconciliation search — scoped + cross-filtering (integration)", () => {
  it("400s with no stagedPaymentId, and 400s for an unknown nodeType", async () => {
    const stagedId = await seedStaged("100.00");

    const noStaged = await apiGet(`/api/reconciliation/search/donor?q=x`);
    expect(noStaged.status).toBe(400);
    expect(noStaged.json.error).toBe("validation_error");

    const badType = await apiGet(
      `/api/reconciliation/search/nonsense?stagedPaymentId=${stagedId}`,
    );
    expect(badType.status).toBe(400);
    expect(badType.json.error).toBe("validation_error");
  }, 30_000);

  it("donor search finds the org by name (trigram)", async () => {
    const stagedId = await seedStaged("100.00");
    const res = await apiGet(
      `/api/reconciliation/search/donor?stagedPaymentId=${stagedId}` +
        `&q=${encodeURIComponent("Reconciliation Approve Test Org")}`,
    );
    expect(res.status).toBe(200);
    const ids = (res.json.data as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(ORG_ID);
  }, 30_000);

  it("gift search (donor-scoped) includes an active org gift in the amount band and EXCLUDES an archived one", async () => {
    const activeGiftId = await seedGift("100.00");
    const archivedGiftId = await seedArchivedGift("100.00");
    const stagedId = await seedStaged("100.00");

    const res = await apiGet(
      `/api/reconciliation/search/gift?stagedPaymentId=${stagedId}&donorId=${ORG_ID}`,
    );
    expect(res.status).toBe(200);
    const ids = (res.json.data as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(activeGiftId);
    expect(ids).not.toContain(archivedGiftId);
  }, 30_000);
});

describe.skipIf(!HAS_DB)("Reconciliation cards — queue visibility (integration)", () => {
  it("default queue shows pending and hides reconciled; queue=reconciled is the inverse", async () => {
    const marker = `QV_${RUN}_${Math.random().toString(36).slice(2, 8)}`;
    const pendingId = await seedStaged("100.00", { payerName: marker });
    const reconciledId = await seedStaged("100.00", {
      payerName: marker,
      status: "reconciled",
    });

    const live = await apiGet(
      `/api/reconciliation/cards?q=${encodeURIComponent(marker)}&limit=50`,
    );
    expect(live.status).toBe(200);
    const liveIds = (live.json.data as Array<{ stagedPaymentId: string }>).map(
      (c) => c.stagedPaymentId,
    );
    expect(liveIds).toContain(pendingId);
    expect(liveIds).not.toContain(reconciledId);

    const done = await apiGet(
      `/api/reconciliation/cards?queue=reconciled&q=${encodeURIComponent(marker)}&limit=50`,
    );
    expect(done.status).toBe(200);
    const doneIds = (done.json.data as Array<{ stagedPaymentId: string }>).map(
      (c) => c.stagedPaymentId,
    );
    expect(doneIds).toContain(reconciledId);
    expect(doneIds).not.toContain(pendingId);
  }, 30_000);
});

describe.skipIf(!HAS_DB)("Reconciliation approve — single-source-of-truth invariants (integration)", () => {
  it("reconciling an existing gift NEVER archives the gift and NEVER sets processor_payout on the staged row", async () => {
    const giftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00");
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId,
      stripeChargeId: chargeId,
    });
    expect(res.status).toBe(200);

    // The CRM gift stays live (evidence-tied, never archived); the staged row is
    // reconciled WITHOUT the retired processor_payout exclusion.
    const gift = await readGift(giftId);
    expect(gift.archivedAt).toBeNull();
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("reconciled");
    expect(staged.exclusionReason).not.toBe("processor_payout");
  }, 30_000);

  it("stamps the Stripe GROSS as the gift's final amount, NOT the coarser QB staged amount (Stripe precedence)", async () => {
    // The gift's prior (human) figure 105.00 sits within the fee-band of the
    // Stripe gross 100.00; the QB deposit is a coarser net 90.00. Only Stripe
    // precedence (gross wins when a charge exists) explains a final amount of
    // 100.00 — neither the QB 90.00 nor the prior 105.00.
    const giftId = await seedGiftWithAllocations("105.00", ["105.00"]);
    const allocId = allocIds[allocIds.length - 1] as string;
    const stagedId = await seedStaged("90.00");
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId,
      stripeChargeId: chargeId,
    });
    expect(res.status).toBe(200);

    const gift = await readGift(giftId);
    expect(gift.amount).toBe("100.00"); // Stripe GROSS, not QB 90.00 or prior 105.00
    expect(gift.finalAmountSource).toBe("stripe");
    expect(gift.finalAmountStripeChargeId).toBe(chargeId);
    expect(gift.finalAmountQbStagedPaymentId).toBeNull();
    // The pre-stamp human figure is snapshotted, never lost.
    expect(gift.originalHumanCrmAmount).toBe("105.00");
    // The lone allocation is rescaled to the new final amount (no review flag).
    expect((await readAlloc(allocId)).subAmount).toBe("100.00");
    expect(await readOpenReviews(giftId)).toHaveLength(0);
    // The QB staged row stays as reconciled evidence at its own coarse figure.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("reconciled");
    expect(staged.amount).toBe("90.00");
  }, 30_000);
});

describe.skipIf(!HAS_DB)("Allocation rescale vs flag — adjustSingleAllocationOrFlag (integration)", () => {
  it("rescales the lone allocation to the new amount and raises NO review flag", async () => {
    const giftId = await seedGiftWithAllocations("100.00", ["100.00"]);
    const allocId = allocIds[allocIds.length - 1] as string;
    const { adjustSingleAllocationOrFlag } = await import("../lib/giftFinalAmount");

    const result = await db.transaction((tx) =>
      adjustSingleAllocationOrFlag(tx, giftId, "100.00", "105.00", "stripe"),
    );
    expect(result.rescaled).toBe(true);
    expect(result.flagged).toBe(false);
    expect((await readAlloc(allocId)).subAmount).toBe("105.00");
    expect(await readOpenReviews(giftId)).toHaveLength(0);
  }, 30_000);

  it("flags a zero-allocation gift (no_allocation) instead of guessing a split", async () => {
    const giftId = await seedGiftWithAllocations("100.00", []);
    const { adjustSingleAllocationOrFlag } = await import("../lib/giftFinalAmount");

    const result = await db.transaction((tx) =>
      adjustSingleAllocationOrFlag(tx, giftId, "100.00", "120.00", "quickbooks"),
    );
    expect(result.rescaled).toBe(false);
    expect(result.flagged).toBe(true);
    const open = await readOpenReviews(giftId);
    expect(open).toHaveLength(1);
    expect(open[0]?.reason).toBe("no_allocation");
    expect(open[0]?.allocationCount).toBe(0);
    expect(open[0]?.source).toBe("quickbooks");
  }, 30_000);

  it("flags a multi-allocation mismatch and keeps exactly ONE open review row across re-runs (upsert)", async () => {
    const giftId = await seedGiftWithAllocations("100.00", ["60.00", "40.00"]);
    const { adjustSingleAllocationOrFlag } = await import("../lib/giftFinalAmount");

    const first = await db.transaction((tx) =>
      adjustSingleAllocationOrFlag(tx, giftId, "100.00", "150.00", "stripe"),
    );
    expect(first.flagged).toBe(true);
    expect(first.rescaled).toBe(false);
    let open = await readOpenReviews(giftId);
    expect(open).toHaveLength(1);
    expect(open[0]?.reason).toBe("multi_allocation_mismatch");
    expect(open[0]?.allocationCount).toBe(2);
    expect(open[0]?.newAmount).toBe("150.00");

    // Re-running reconciliation must UPSERT the same open row, never pile up duplicates.
    const second = await db.transaction((tx) =>
      adjustSingleAllocationOrFlag(tx, giftId, "100.00", "160.00", "stripe"),
    );
    expect(second.flagged).toBe(true);
    open = await readOpenReviews(giftId);
    expect(open).toHaveLength(1);
    expect(open[0]?.newAmount).toBe("160.00");
  }, 30_000);
});

describe.skipIf(!HAS_DB)(
  "Reconciliation approve — switch gift donor (integration)",
  () => {
    it("re-points the gift donor to the chosen donor when switchGiftDonor is set", async () => {
      const giftId = await seedGift("100.00");
      const stagedId = await seedStaged("100.00");

      const res = await api(
        `/api/reconciliation/cards/${stagedId}/approve`,
        {
          outcome: "link_existing_gift",
          giftId,
          organizationId: ORG2_ID,
          switchGiftDonor: true,
        },
      );
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);

      // The gift's donor is re-pointed to the chosen donor (Donor XOR preserved).
      const gift = await readGift(giftId);
      expect(gift.organizationId).toBe(ORG2_ID);
      expect(gift.individualGiverPersonId).toBeNull();
      expect(gift.householdId).toBeNull();

      // The QB staged row becomes reconciled evidence tied to the gift, with the
      // switched donor adopted.
      const staged = await readStaged(stagedId);
      expect(staged.status).toBe("reconciled");
      expect(staged.matchedGiftId).toBe(giftId);
      expect(staged.organizationId).toBe(ORG2_ID);
    }, 30_000);

    it("blocks the switch when the gift is a payment on a pledge owned by a different donor (gift_pledge_donor_conflict)", async () => {
      const pledgeId = await seedOpp({ stage: "written_commitment" });
      const giftId = await seedGiftOnPledge("100.00", pledgeId);
      const stagedId = await seedStaged("100.00");

      const res = await api(
        `/api/reconciliation/cards/${stagedId}/approve`,
        {
          outcome: "link_existing_gift",
          giftId,
          organizationId: ORG2_ID,
          switchGiftDonor: true,
        },
      );
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("gift_pledge_donor_conflict");

      // Nothing mutated: gift donor unchanged, staged row still pending.
      const gift = await readGift(giftId);
      expect(gift.organizationId).toBe(ORG_ID);
      const staged = await readStaged(stagedId);
      expect(staged.status).toBe("pending");
    }, 30_000);

    it("rejects a switch with no donor selected (validation_error)", async () => {
      const giftId = await seedGift("100.00");
      const stagedId = await seedStaged("100.00");

      const res = await api(
        `/api/reconciliation/cards/${stagedId}/approve`,
        { outcome: "link_existing_gift", giftId, switchGiftDonor: true },
      );
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("validation_error");

      // Untouched.
      const gift = await readGift(giftId);
      expect(gift.organizationId).toBe(ORG_ID);
      const staged = await readStaged(stagedId);
      expect(staged.status).toBe("pending");
    }, 30_000);
  },
);
