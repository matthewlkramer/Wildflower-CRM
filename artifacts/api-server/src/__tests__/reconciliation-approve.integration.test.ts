import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  clearPaymentApplicationsForGiftIds,
  clearPaymentApplicationsForStagedIds,
} from "./paymentApplicationsTestUtil";
import { payoutStatusFromLink } from "../lib/settlementLink";
import { proposeSettlementLink } from "../lib/settlementWriter";
import { chargeStatusSql, stagedStatusSql } from "../lib/derivedStatus";
import { getTableColumns } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the unified "complete-match" reconciler approve route
 * (POST /api/reconciliation/cards/:stagedPaymentId/approve), E3
 * `link_existing_gift` outcome.
 *
 * The focus is the Stripe-evidence linkage invariant: when a Stripe charge is
 * selected, the approved charge row must be tied to the gift ROW-LOCALLY
 * (`matchedGiftId` = giftId, derived status `match_confirmed`, matchStatus
 * `matched`) so the
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
  settlementLinks: Db["settlementLinks"];
  giftAmountAllocationReview: Db["giftAmountAllocationReview"];
  paymentApplications: Db["paymentApplications"];
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
    organizationId?: string | null;
    matchStatus?: "matched" | "suggested" | "unmatched";
    matchedGiftId?: string | null;
    createdGiftId?: string | null;
    groupReconciledGiftId?: string | null;
    // Status is DERIVED from facts: no links ⇒ pending; a gift link with
    // autoApplied=true (and no matchConfirmedAt) ⇒ match_proposed; a gift link
    // otherwise ⇒ match_confirmed.
    autoApplied?: boolean;
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
    ...(opts.autoApplied !== undefined ? { autoApplied: opts.autoApplied } : {}),
    ...(opts.organizationId !== undefined
      ? { organizationId: opts.organizationId }
      : {}),
    ...(opts.matchStatus !== undefined ? { matchStatus: opts.matchStatus } : {}),
    ...(opts.matchedGiftId !== undefined
      ? { matchedGiftId: opts.matchedGiftId }
      : {}),
    ...(opts.createdGiftId !== undefined
      ? { createdGiftId: opts.createdGiftId }
      : {}),
    ...(opts.groupReconciledGiftId !== undefined
      ? { groupReconciledGiftId: opts.groupReconciledGiftId }
      : {}),
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
    opportunityId: pledgeId,
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
  });
  payoutIds.push(id);
  // The approve route finds tied payouts via settlement_links (the authoritative
  // reconciliation store; the legacy pointer columns are dropped). Seed a
  // proposed link pointing at this deposit; FK cascade on payout_id cleans it up
  // when the payout is deleted in afterAll.
  const link = proposeSettlementLink(stagedPaymentId, null);
  await db.insert(schema.settlementLinks).values({
    id: `sl_${id}`,
    payoutId: id,
    depositStagedPaymentId: link.depositStagedPaymentId,
    conflictGiftId: link.conflictGiftId,
    lifecycle: link.lifecycle,
    provenance: link.provenance,
    confirmedByUserId: link.confirmedByUserId,
    confirmedAt: link.confirmedAt,
  });
  return id;
}

async function seedCharge(opts: {
  payoutId: string;
  grossAmount: string;
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
    matchedGiftId: opts.matchedGiftId ?? null,
  });
  chargeIds.push(id);
  return id;
}

async function readStaged(id: string) {
  // Full row + the DERIVED status (there is no stored status column).
  const [row] = await db
    .select({ ...getTableColumns(schema.stagedPayments), status: stagedStatusSql })
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
  // Full row + the DERIVED status (there is no stored status column).
  const [row] = await db
    .select({
      ...getTableColumns(schema.stripeStagedCharges),
      status: chargeStatusSql,
    })
    .from(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, id));
  return row;
}
async function readLink(payoutId: string) {
  const [row] = await db
    .select()
    .from(schema.settlementLinks)
    .where(eqFn(schema.settlementLinks.payoutId, payoutId));
  return row;
}

async function seedOpp(opts: {
  stage:
    | "in_conversation"
    | "conditional_commitment"
    | "written_commitment"
    | "cash_in"
    | "complete";
  status?: "open" | "pledge" | "cash_in" | "dormant" | "lost";
  awardedAmount?: string | null;
  writtenPledge?: boolean;
  lossType?: "dormant" | "lost" | null;
}): Promise<string> {
  const id = nextId("opp");
  await db.insert(schema.opportunitiesAndPledges).values({
    id,
    name: `Opp ${id}`,
    organizationId: ORG_ID,
    stage: opts.stage,
    ...(opts.status ? { status: opts.status } : {}),
    awardedAmount: opts.awardedAmount ?? null,
    writtenPledge: opts.writtenPledge ?? false,
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
    settlementLinks: dbMod.settlementLinks,
    giftAmountAllocationReview: dbMod.giftAmountAllocationReview,
    paymentApplications: dbMod.paymentApplications,
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
  // Clear the cash-application ledger BEFORE deleting charges/gifts. Stripe
  // evidence rows anchor on (stripe_charge_id, gift_id) with a NULL payment_id,
  // so clearing by staged id alone misses them — and the charge's ON DELETE SET
  // NULL would then trip the stripe-evidence CHECK. Clearing by gift id catches
  // every row this suite created (all reference a gift).
  await clearPaymentApplicationsForGiftIds(giftIds);
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  await clearPaymentApplicationsForStagedIds(stagedIds);
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  // Delete allocations by gift id, not just the ids the test tracked: every
  // minted gift auto-seeds a starter allocation (invariant #7) whose id the
  // suite never captures, and that orphan would otherwise block the gift delete
  // (gift_allocations.gift_id FK is RESTRICT).
  if (giftIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
  if (allocIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.id, allocIds));
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  // Opportunities are referenced by gifts (opportunityId) and by the org;
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
    expect(charge.status).toBe("match_confirmed");
    expect(charge.matchedGiftId).toBe(giftId);
    expect(charge.createdGiftId).toBeNull();
    expect(charge.matchStatus).toBe("matched");
    expect(charge.matchConfirmedByUserId).toBe(TEST_USER_ID);

    // QB staged row + payout become permanent reconciled evidence.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(staged.matchedGiftId).toBe(giftId);

    const link = await readLink(payoutId);
    expect(payoutStatusFromLink(link ?? null)).toBe("confirmed_reconciled");
    expect(link?.depositStagedPaymentId).toBe(stagedId);

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

describe.skipIf(!HAS_DB)(
  "Reconciliation approve — switch Stripe source (integration)",
  () => {
    // Stamp a gift so it is already sourced from an OLD Stripe charge, and
    // reconcile that charge to the gift, mirroring a prior link. This is the
    // state the switch override must safely re-point away from.
    async function sourceGiftFromCharge(giftId: string, oldChargeId: string) {
      await db
        .update(schema.giftsAndPayments)
        .set({
          finalAmountSource: "stripe",
          finalAmountStripeChargeId: oldChargeId,
        })
        .where(eqFn(schema.giftsAndPayments.id, giftId));
      await db
        .update(schema.stripeStagedCharges)
        .set({
          matchedGiftId: giftId,
          matchStatus: "matched",
          matchConfirmedByUserId: TEST_USER_ID,
        })
        .where(eqFn(schema.stripeStagedCharges.id, oldChargeId));
    }

    it("hard-blocks without the flag, surfacing the current backing charge in the 409 details", async () => {
      const giftId = await seedGift("100.00");
      const oldPayoutId = await seedPayout(await seedStaged("100.00"));
      const oldChargeId = await seedCharge({
        payoutId: oldPayoutId,
        grossAmount: "100.00",
      });
      await sourceGiftFromCharge(giftId, oldChargeId);

      const stagedId = await seedStaged("100.00");
      const payoutId = await seedPayout(stagedId);
      const newChargeId = await seedCharge({
        payoutId,
        grossAmount: "100.00",
      });

      const res = await api(
        `/api/reconciliation/cards/${stagedId}/approve`,
        {
          outcome: "link_existing_gift",
          giftId,
          stripeChargeId: newChargeId,
        },
      );
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("consistency_gate");
      const issue = (res.json.details?.issues ?? []).find(
        (i: any) => i.code === "gift_already_stripe_sourced",
      );
      expect(issue).toBeTruthy();
      expect(issue.details?.currentStripeCharge?.id).toBe(oldChargeId);
      expect(issue.details?.targetStripeChargeId).toBe(newChargeId);

      // Nothing mutated: the old charge still backs the gift.
      expect((await readGift(giftId)).finalAmountStripeChargeId).toBe(
        oldChargeId,
      );
      expect((await readCharge(newChargeId)).status).toBe("pending");
      expect((await readStaged(stagedId)).status).toBe("pending");
    }, 30_000);

    it("with switchStripeSource orphans the old charge and re-sources the gift to the new one", async () => {
      const giftId = await seedGift("100.00");
      const oldPayoutId = await seedPayout(await seedStaged("100.00"));
      const oldChargeId = await seedCharge({
        payoutId: oldPayoutId,
        grossAmount: "100.00",
      });
      await sourceGiftFromCharge(giftId, oldChargeId);

      const stagedId = await seedStaged("100.00");
      const payoutId = await seedPayout(stagedId);
      const newChargeId = await seedCharge({
        payoutId,
        grossAmount: "100.00",
      });

      const res = await api(
        `/api/reconciliation/cards/${stagedId}/approve`,
        {
          outcome: "link_existing_gift",
          giftId,
          stripeChargeId: newChargeId,
          switchStripeSource: true,
        },
      );
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);

      // The gift is now sourced from the NEW charge.
      const gift = await readGift(giftId);
      expect(gift.finalAmountSource).toBe("stripe");
      expect(gift.finalAmountStripeChargeId).toBe(newChargeId);

      // New charge carries the gift linkage.
      const newCharge = await readCharge(newChargeId);
      expect(newCharge.status).toBe("match_confirmed");
      expect(newCharge.matchedGiftId).toBe(giftId);

      // Old charge is orphaned back to the unmatched-money queue.
      const oldCharge = await readCharge(oldChargeId);
      expect(oldCharge.status).toBe("pending");
      expect(oldCharge.matchedGiftId).toBeNull();
      expect(oldCharge.matchStatus).toBe("unmatched");
    }, 30_000);

    it("a FAILED old charge lands in the excluded bucket after the swap, not back in pending", async () => {
      // The Dukes dead-end: the gift's Stripe source is a charge whose raw
      // Stripe status is 'failed' (the donor's card declined; a retry charge
      // succeeded later). After the swap the failed charge must NOT return to
      // the pending queue where it would look like real unmatched money — it
      // lands excluded/failed_charge, mirroring the single-charge revert.
      const giftId = await seedGift("100.00");
      const oldPayoutId = await seedPayout(await seedStaged("100.00"));
      const oldChargeId = await seedCharge({
        payoutId: oldPayoutId,
        grossAmount: "100.00",
      });
      await db
        .update(schema.stripeStagedCharges)
        .set({ rawCharge: { status: "failed" } })
        .where(eqFn(schema.stripeStagedCharges.id, oldChargeId));
      await sourceGiftFromCharge(giftId, oldChargeId);

      const stagedId = await seedStaged("100.00");
      const payoutId = await seedPayout(stagedId);
      const newChargeId = await seedCharge({
        payoutId,
        grossAmount: "100.00",
      });

      const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
        outcome: "link_existing_gift",
        giftId,
        stripeChargeId: newChargeId,
        switchStripeSource: true,
      });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);

      // Gift re-sourced to the NEW charge …
      expect((await readGift(giftId)).finalAmountStripeChargeId).toBe(
        newChargeId,
      );
      // … and the failed old charge is excluded, never pending again.
      const oldCharge = await readCharge(oldChargeId);
      expect(oldCharge.status).toBe("excluded");
      expect(oldCharge.exclusionReason).toBe("failed_charge");
      expect(oldCharge.matchedGiftId).toBeNull();
    }, 30_000);
  },
);

describe.skipIf(!HAS_DB)(
  "Reconciliation approve — displace linked QB payment (integration)",
  () => {
    // Establish an INCUMBENT: link a plain QB staged payment (no Stripe charges)
    // to the gift through the real approve route so the cash-application ledger
    // row + matchedGiftId linkage exist exactly as production creates them.
    async function bookIncumbentLink(
      giftId: string,
      amount: string,
    ): Promise<string> {
      const incumbentId = await seedStaged(amount, { payerName: "Incumbent" });
      const res = await api(
        `/api/reconciliation/cards/${incumbentId}/approve`,
        { outcome: "link_existing_gift", giftId },
      );
      expect(res.status).toBe(200);
      expect((await readStaged(incumbentId)).matchedGiftId).toBe(giftId);
      return incumbentId;
    }

    it("hard-blocks without the flag, surfacing the incumbent payment in the 409 details", async () => {
      const giftId = await seedGift("100.00");
      const incumbentId = await bookIncumbentLink(giftId, "100.00");

      const stagedId = await seedStaged("100.00");
      const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
        outcome: "link_existing_gift",
        giftId,
      });
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("consistency_gate");
      const issue = (res.json.details?.issues ?? []).find(
        (i: any) => i.code === "gift_already_qb_linked",
      );
      expect(issue).toBeTruthy();
      expect(issue.details?.currentQbPayment?.id).toBe(incumbentId);
      expect(issue.details?.targetStagedPaymentId).toBe(stagedId);

      // Nothing mutated: the incumbent still holds the gift; the new row is
      // still pending.
      expect((await readStaged(incumbentId)).status).toBe("match_confirmed");
      expect((await readStaged(incumbentId)).matchedGiftId).toBe(giftId);
      expect((await readStaged(stagedId)).status).toBe("pending");
    }, 30_000);

    it("with displaceLinkedPayment disconnects the incumbent (back to pending) and links the new one", async () => {
      const giftId = await seedGift("100.00");
      const incumbentId = await bookIncumbentLink(giftId, "100.00");

      const stagedId = await seedStaged("100.00");
      const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
        outcome: "link_existing_gift",
        giftId,
        displaceLinkedPayment: true,
      });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);

      // The incumbent is returned to the pending/unmatched queue, fully unlinked.
      const incumbent = await readStaged(incumbentId);
      expect(incumbent.status).toBe("pending");
      expect(incumbent.matchedGiftId).toBeNull();
      expect(incumbent.createdGiftId).toBeNull();
      expect(incumbent.groupReconciledGiftId).toBeNull();
      expect(incumbent.matchConfirmedAt).toBeNull();

      // The new payment now holds the gift as permanent reconciled evidence.
      const staged = await readStaged(stagedId);
      expect(staged.status).toBe("match_confirmed");
      expect(staged.matchedGiftId).toBe(giftId);
    }, 30_000);

    // Reproduce the QB worker autoApply end-state: the payment is left APPROVED
    // (still approvable) while holding a COUNTED cash-application to gift A —
    // the wrong one of two identical donations (the Kirby/Rue $156.48 pair).
    async function seedWorkerAutoMatch(
      giftA: string,
      amount: string,
    ): Promise<string> {
      const paymentId = await seedStaged(amount, { payerName: "Dionne Kirby" });
      await db
        .update(schema.stagedPayments)
        .set({
          matchStatus: "matched",
          matchedGiftId: giftA,
          autoApplied: true,
        })
        .where(eqFn(schema.stagedPayments.id, paymentId));
      await db.insert(schema.paymentApplications).values({
        id: nextId("pa"),
        paymentId,
        giftId: giftA,
        amountApplied: amount,
        evidenceSource: "quickbooks",
        matchMethod: "system",
        linkRole: "counted",
        lifecycle: "confirmed",
      });
      return paymentId;
    }

    it("re-targeting a payment already applied to another gift blocks with a recoverable gate issue (not a raw 500)", async () => {
      // A movable worker auto-match (ledger gift agrees with matchedGiftId, no
      // minted/group link) must surface the RECOVERABLE gate issue carrying the
      // current gift's details, so the workbench can offer the confirm dialog —
      // never escape to the global 500 handler.
      const giftA = await seedGift("100.00");
      const paymentId = await seedWorkerAutoMatch(giftA, "100.00");

      const giftB = await seedGift("100.00");
      const res = await api(`/api/reconciliation/cards/${paymentId}/approve`, {
        outcome: "link_existing_gift",
        giftId: giftB,
      });
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("consistency_gate");
      const issue = (res.json.details?.issues ?? []).find(
        (i: any) => i.code === "payment_already_applied",
      );
      expect(issue).toBeTruthy();
      expect(issue.details?.currentAppliedGift?.id).toBe(giftA);
      expect(issue.details?.targetGiftId).toBe(giftB);

      // The blocked re-target mutated nothing: the payment still holds gift A
      // (an unconfirmed auto-match derives match_proposed).
      const after = await readStaged(paymentId);
      expect(after.matchedGiftId).toBe(giftA);
      expect(after.status).toBe("match_proposed");
    }, 30_000);

    it("a NON-movable own application (ledger disagrees with matchedGiftId) still 409s as handled, never a 500", async () => {
      // When the row's matchedGiftId does NOT agree with the ledger (drift, or a
      // split/group unwind half-done), the move is not offered. Under derived
      // status the counted ledger row alone makes the row `match_confirmed`, so
      // the approve gate rejects it up-front as not approvable — a handled 409
      // (nothing mutated), never an escape to the global 500 handler.
      const giftA = await seedGift("100.00");
      const paymentId = await seedWorkerAutoMatch(giftA, "100.00");
      // Break the agreement: the row itself no longer points at gift A.
      await db
        .update(schema.stagedPayments)
        .set({ matchedGiftId: null })
        .where(eqFn(schema.stagedPayments.id, paymentId));

      const giftB = await seedGift("100.00");
      const res = await api(`/api/reconciliation/cards/${paymentId}/approve`, {
        outcome: "link_existing_gift",
        giftId: giftB,
        moveOwnApplication: true,
      });
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("not_approvable");
      expect(typeof res.json.message).toBe("string");
      // The blocked approve mutated nothing: the ledger still holds gift A.
      const after = await readStaged(paymentId);
      expect(after.matchedGiftId).toBeNull();
      expect(after.status).toBe("match_confirmed");
    }, 30_000);

    it("with moveOwnApplication moves the payment off the wrong gift and applies it to the right one", async () => {
      const giftA = await seedGift("156.48");
      const paymentId = await seedWorkerAutoMatch(giftA, "156.48");

      const giftB = await seedGift("156.48");
      const res = await api(`/api/reconciliation/cards/${paymentId}/approve`, {
        outcome: "link_existing_gift",
        giftId: giftB,
        moveOwnApplication: true,
      });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);

      // The payment now holds gift B as permanent reconciled evidence.
      const after = await readStaged(paymentId);
      expect(after.status).toBe("match_confirmed");
      expect(after.matchedGiftId).toBe(giftB);

      // The cash-application ledger moved with it: the old COUNTED row to gift A
      // is gone; exactly one counted row ties this payment's money to gift B.
      const paRows = await db
        .select()
        .from(schema.paymentApplications)
        .where(eqFn(schema.paymentApplications.paymentId, paymentId));
      const counted = paRows.filter((r) => r.linkRole === "counted");
      expect(counted).toHaveLength(1);
      expect(counted[0].giftId).toBe(giftB);

      // QB tie status recomputed on BOTH sides: the target gift gained the QB
      // evidence; the old gift lost its only QB evidence (no longer tied).
      expect((await readGift(giftB)).quickbooksTieStatus).toBe("tied");
      expect((await readGift(giftA)).quickbooksTieStatus).not.toBe("tied");
    }, 30_000);

    it("composes with the Stripe source switch: one confirmation resolves BOTH conflicts", async () => {
      const giftId = await seedGift("100.00");
      // Incumbent QB link on the gift (creates the ledger row) …
      const incumbentId = await bookIncumbentLink(giftId, "100.00");
      // … and additionally re-point the gift's final amount at an OLD Stripe
      // charge so it is ALSO Stripe-sourced. Both conflicts now coexist.
      const oldPayoutId = await seedPayout(await seedStaged("100.00"));
      const oldChargeId = await seedCharge({
        payoutId: oldPayoutId,
        grossAmount: "100.00",
      });
      await db
        .update(schema.giftsAndPayments)
        .set({
          finalAmountSource: "stripe",
          finalAmountStripeChargeId: oldChargeId,
        })
        .where(eqFn(schema.giftsAndPayments.id, giftId));
      await db
        .update(schema.stripeStagedCharges)
        .set({
          matchedGiftId: giftId,
          matchStatus: "matched",
          matchConfirmedByUserId: TEST_USER_ID,
        })
        .where(eqFn(schema.stripeStagedCharges.id, oldChargeId));

      // A NEW Stripe-backed deposit targeting the same gift.
      const stagedId = await seedStaged("100.00");
      const payoutId = await seedPayout(stagedId);
      const newChargeId = await seedCharge({
        payoutId,
        grossAmount: "100.00",
      });

      // Without the flags the gate returns BOTH issues in one 409.
      const blocked = await api(
        `/api/reconciliation/cards/${stagedId}/approve`,
        { outcome: "link_existing_gift", giftId, stripeChargeId: newChargeId },
      );
      expect(blocked.status).toBe(409);
      const codes = (blocked.json.details?.issues ?? []).map(
        (i: any) => i.code,
      );
      expect(codes).toContain("gift_already_stripe_sourced");
      expect(codes).toContain("gift_already_qb_linked");

      // Both flags together resolve both in a single call.
      const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
        outcome: "link_existing_gift",
        giftId,
        stripeChargeId: newChargeId,
        switchStripeSource: true,
        displaceLinkedPayment: true,
      });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);

      // QB incumbent released; new payment linked.
      const incumbent = await readStaged(incumbentId);
      expect(incumbent.status).toBe("pending");
      expect(incumbent.matchedGiftId).toBeNull();
      expect((await readStaged(stagedId)).matchedGiftId).toBe(giftId);

      // Stripe source switched: gift now sourced from the new charge; old charge
      // orphaned back to the unmatched-money queue.
      const gift = await readGift(giftId);
      expect(gift.finalAmountStripeChargeId).toBe(newChargeId);
      const oldCharge = await readCharge(oldChargeId);
      expect(oldCharge.status).toBe("pending");
      expect(oldCharge.matchedGiftId).toBeNull();
    }, 30_000);
  },
);

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
    // processor_fee header column is dropped; the fee now lives on the linked charge
    // (derivedProcessorFee sums exactly this) — assert it at the source.
    expect((await readCharge(chargeId)).feeAmount).toBe("3.00");

    // The QB anchor OWNS the mint (createdGiftId, not auto-applied); the charge
    // is matchedGiftId-linked precise evidence; the payout is confirmed.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(staged.createdGiftId).toBe(newGiftId);
    expect(staged.matchedGiftId).toBeNull();
    expect(staged.autoApplied).toBe(false);
    expect(staged.matchStatus).toBe("matched");
    expect(staged.organizationId).toBe(ORG_ID);

    const charge = await readCharge(chargeId);
    expect(charge.status).toBe("match_confirmed");
    expect(charge.matchedGiftId).toBe(newGiftId);
    expect(charge.createdGiftId).toBeNull();

    const link = await readLink(payoutId);
    expect(payoutStatusFromLink(link ?? null)).toBe("confirmed_reconciled");
    expect(link?.depositStagedPaymentId).toBe(stagedId);
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
    expect(staged.status).toBe("match_confirmed");
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

// A row the QB worker auto-matched (gift link + autoApplied, never confirmed by
// a human) DERIVES `match_proposed` and is still legitimately OPEN for
// reconciliation in the unified reconciler — the approve route must not block it
// as "no longer pending".
describe.skipIf(!HAS_DB)("Reconciliation approve — auto-proposed (`match_proposed`) rows stay reconcilable (integration)", () => {
  it("links an auto-proposed row to its matched gift (the prod regression)", async () => {
    const giftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00", {
      autoApplied: true,
      matchStatus: "matched",
      matchedGiftId: giftId,
    });
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId,
      stripeChargeId: chargeId,
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    // The auto-proposed row reconciles cleanly — no 409 not_approvable.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(staged.matchedGiftId).toBe(giftId);

    const charge = await readCharge(chargeId);
    expect(charge.status).toBe("match_confirmed");
    expect(charge.matchedGiftId).toBe(giftId);
  }, 30_000);

  it("rejects minting a NEW gift on an auto-proposed row that already points at a gift (gift_already_linked, no double-count)", async () => {
    const giftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00", {
      autoApplied: true,
      matchStatus: "matched",
      matchedGiftId: giftId,
    });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("gift_already_linked");

    // Nothing minted; the row keeps its existing gift link and derived status.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_proposed");
    expect(staged.matchedGiftId).toBe(giftId);
    expect(staged.createdGiftId).toBeNull();
  }, 30_000);

  it("rejects minting a NEW gift on a row already tied to a GROUPED gift (not_approvable, no double-count)", async () => {
    // A group-reconciled link derives match_confirmed (it is not part of the
    // proposed arm), so the status gate blocks the mint before the
    // gift_already_linked guard is even reached.
    const giftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00", {
      autoApplied: true,
      matchStatus: "matched",
      groupReconciledGiftId: giftId,
    });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("not_approvable");

    // Nothing minted; the row keeps its grouped gift link and derived status.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(staged.groupReconciledGiftId).toBe(giftId);
    expect(staged.createdGiftId).toBeNull();
  }, 30_000);

  it("still blocks a terminal confirmed (`match_confirmed`) row (not_approvable)", async () => {
    const giftId = await seedGift("100.00");
    const otherGiftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00", {
      matchStatus: "matched",
      matchedGiftId: giftId,
    });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId: otherGiftId,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("not_approvable");

    // Untouched.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(staged.matchedGiftId).toBe(giftId);
  }, 30_000);
});

describe.skipIf(!HAS_DB)("Reconciliation approve — opportunity targets (integration)", () => {
  it("create_gift_from_opportunity ties the minted gift to the opp (opportunityId), derives the donor from the opp, and the opp derives cash_in when fully paid", async () => {
    // A pledge awaiting its (full) payment.
    const oppId = await seedOpp({
      stage: "written_commitment",
      writtenPledge: true,
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
    expect(gift.opportunityId).toBe(oppId);
    expect(gift.organizationId).toBe(ORG_ID);
    expect(gift.amount).toBe("100.00");
    expect(gift.finalAmountSource).toBe("quickbooks");
    expect(gift.finalAmountQbStagedPaymentId).toBe(stagedId);

    // The QB anchor owns the mint.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(staged.createdGiftId).toBe(giftId);

    // Fully paid (100 >= awarded 100) ⇒ status derives to cash_in and the funnel
    // stage advances to the terminal `complete` (won).
    const opp = await readOpp(oppId);
    expect(opp.status).toBe("cash_in");
    expect(opp.stage).toBe("complete");
    expect(opp.writtenPledge).toBe(true);
  }, 30_000);

  it("create_gift_from_opportunity against a partially-paid pledge leaves it a pledge (paid < awarded)", async () => {
    const oppId = await seedOpp({
      stage: "written_commitment",
      writtenPledge: true,
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
    // A written pledge is a won row: the funnel stage advances to `complete`
    // (status stays 'pledge' = "Waiting for payment" until fully paid).
    expect(opp.stage).toBe("complete");
    expect(opp.awardedAmount).toBe("500.00");
  }, 30_000);

  it("convert_to_pledge_and_first_payment latches an OPEN opp into a pledge, sets awarded from the evidence, and books the first payment", async () => {
    const oppId = await seedOpp({
      stage: "in_conversation",
      writtenPledge: false,
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
    expect(gift.opportunityId).toBe(oppId);
    expect(gift.organizationId).toBe(ORG_ID);

    // Latched into a pledge: written_pledge derived true, awarded filled from the
    // evidence (was null), and a single full payment derives status to cash_in
    // with the funnel stage advanced to the terminal `complete` (won).
    const opp = await readOpp(oppId);
    expect(opp.writtenPledge).toBe(true);
    expect(opp.awardedAmount).toBe("100.00");
    expect(opp.status).toBe("cash_in");
    expect(opp.stage).toBe("complete");
  }, 30_000);

  it("convert_to_pledge_and_first_payment preserves a real awarded amount (partial first payment stays a pledge)", async () => {
    const oppId = await seedOpp({
      stage: "in_conversation",
      writtenPledge: false,
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
    // A written pledge is a won row: the funnel stage advances to `complete`
    // (status stays 'pledge' = "Waiting for payment" until fully paid).
    expect(opp.stage).toBe("complete");
    expect(opp.status).toBe("pledge");
    expect(opp.writtenPledge).toBe(true);
  }, 30_000);

  it("convert_to_pledge_and_first_payment rejects an opp already latched as a pledge (already_pledge) and mutates nothing", async () => {
    const oppId = await seedOpp({
      stage: "written_commitment",
      writtenPledge: true,
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
    expect(opp.writtenPledge).toBe(true);
  }, 30_000);

  it("convert_to_pledge_and_first_payment rejects a won direct-gift opp (status cash_in, stage complete, writtenPledge false) and mutates nothing", async () => {
    const oppId = await seedOpp({
      stage: "complete",
      status: "cash_in",
      writtenPledge: false,
      awardedAmount: "100.00",
    });
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "convert_to_pledge_and_first_payment",
      opportunityId: oppId,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("already_pledge");

    // Nothing minted or mutated: a won direct gift must not be re-latched.
    expect((await readStaged(stagedId)).status).toBe("pending");
    const opp = await readOpp(oppId);
    expect(opp.stage).toBe("complete");
    expect(opp.writtenPledge).toBe(false);
  }, 30_000);

  it("convert_to_pledge_and_first_payment rejects an opp with a loss_type override (already_pledge)", async () => {
    const oppId = await seedOpp({
      stage: "in_conversation",
      writtenPledge: false,
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
      writtenPledge: true,
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
    expect(gift.opportunityId).toBe(oppId);
    expect(gift.finalAmountSource).toBe("stripe");
    expect(gift.finalAmountStripeChargeId).toBe(chargeId);
    expect(gift.finalAmountQbStagedPaymentId).toBeNull();

    const charge = await readCharge(chargeId);
    expect(charge.status).toBe("match_confirmed");
    expect(charge.matchedGiftId).toBe(giftId);
    // processor_fee header column is dropped; the fee now lives on the linked charge
    // (derivedProcessorFee sums exactly this).
    expect(charge.feeAmount).toBe("3.00");

    const link = await readLink(payoutId);
    expect(payoutStatusFromLink(link ?? null)).toBe("confirmed_reconciled");

    const staged = await readStaged(stagedId);
    expect(staged.createdGiftId).toBe(giftId);
  }, 30_000);

  it("create_gift IGNORES a stray opportunityId — mints for the body donor, does NOT attach to the opp or re-derive it", async () => {
    // A plain create_gift carrying a leftover/stale opportunityId must keep
    // create_gift semantics (donor from body; no opportunity), never hijack the
    // donor from the opp or attach the payment to it.
    const oppId = await seedOpp({
      stage: "in_conversation",
      writtenPledge: false,
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
    expect(gift.opportunityId).toBeNull();

    // The opportunity is completely untouched (no stage advance, no derivation).
    const opp = await readOpp(oppId);
    expect(opp.stage).toBe("in_conversation");
    expect(opp.writtenPledge).toBe(false);
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

  it("gift search FALLS BACK to opportunity candidates when no gift matches the text (unified search, the Melva case)", async () => {
    const stagedId = await seedStaged("100.00");
    const oppId = await seedOpp({
      stage: "written_commitment",
      awardedAmount: "100.00",
      writtenPledge: true,
    });

    // The opp's name (`Opp <run-unique id>`) matches no gift anywhere — the
    // money the fundraiser is hunting for lives only as a pledge/opportunity.
    const res = await apiGet(
      `/api/reconciliation/search/gift?stagedPaymentId=${stagedId}` +
        `&q=${encodeURIComponent(`Opp ${oppId}`)}`,
    );
    expect(res.status).toBe(200);
    const cands = res.json.data as Array<{ id: string; nodeType: string }>;
    // No gift candidate hijacks the result…
    expect(cands.some((c) => c.nodeType === "gift")).toBe(false);
    // …and the opportunity rides along as a LABELLED candidate the UI books
    // as a payment on that pledge (create_gift_from_opportunity).
    const opp = cands.find((c) => c.id === oppId);
    expect(opp).toBeDefined();
    expect(opp?.nodeType).toBe("opportunity");
  }, 30_000);
});

describe.skipIf(!HAS_DB)("Reconciliation cards — queue visibility (integration)", () => {
  it("default queue shows pending and hides match_confirmed; queue=done is the inverse", async () => {
    const marker = `QV_${RUN}_${Math.random().toString(36).slice(2, 8)}`;
    const pendingId = await seedStaged("100.00", { payerName: marker });
    // A confirmed gift link is the FACT that derives match_confirmed.
    const doneGiftId = await seedGift("100.00");
    const reconciledId = await seedStaged("100.00", {
      payerName: marker,
      matchStatus: "matched",
      matchedGiftId: doneGiftId,
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
      `/api/reconciliation/cards?queue=done&q=${encodeURIComponent(marker)}&limit=50`,
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
    expect(staged.status).toBe("match_confirmed");
    expect(staged.exclusionReason).not.toBe("processor_payout");
  }, 30_000);

  it("records Stripe as the gift's final-amount source (Stripe precedence), preserving the human amount", async () => {
    // The gift's prior (human) figure 98.50 sits inside the Stripe [net 97.00,
    // gross 100.00] window — a pure gross-vs-net gap, so it auto-resolves with no
    // override. The QB deposit is a coarser net 90.00. Post-#448 the Stripe stamp
    // records provenance (source + charge pointer) but NO LONGER overwrites the
    // human amount; the settled GROSS is DERIVED at read time. The QB+Stripe
    // settled-total derivation (counted-vs-corroborating dedupe) is deferred to
    // Phase 5, so this asserts provenance, not the derived total.
    const giftId = await seedGiftWithAllocations("98.50", ["98.50"]);
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
    // The human amount is preserved (no overwrite); Stripe precedence is recorded
    // via provenance (source + charge pointer), not by rewriting `amount`.
    expect(gift.amount).toBe("98.50");
    expect(gift.finalAmountSource).toBe("stripe");
    expect(gift.finalAmountStripeChargeId).toBe(chargeId);
    expect(gift.finalAmountQbStagedPaymentId).toBeNull();
    // No overwrite ⇒ nothing snapshotted, no allocation rescale, no review flag.
    expect(gift.originalHumanCrmAmount).toBeNull();
    expect((await readAlloc(allocId)).subAmount).toBe("98.50");
    expect(await readOpenReviews(giftId)).toHaveLength(0);
    // The QB staged row stays as reconciled evidence at its own coarse figure.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(staged.amount).toBe("90.00");
  }, 30_000);

  it("a gift ABOVE the Stripe gross is a REAL discrepancy → 409 without an override, 200 (Stripe provenance recorded, human amount preserved) with one", async () => {
    // gross 100.00, net 97.00; a human-recorded 105.00 sits ABOVE gross. A
    // processor fee can only LOWER the recorded amount, so this is not a pure
    // gross-vs-net gap and must not silently auto-resolve.
    const giftId = await seedGiftWithAllocations("105.00", ["105.00"]);
    const allocId = allocIds[allocIds.length - 1] as string;
    const stagedId = await seedStaged("90.00");
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    // No override → blocked by the consistency gate, gift untouched.
    const blocked = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId,
      stripeChargeId: chargeId,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe("consistency_gate");
    const codes = (blocked.json.details?.issues ?? []).map((i: any) => i.code);
    expect(codes).toContain("amount_out_of_band");
    expect((await readGift(giftId)).amount).toBe("105.00");

    // Explicit override reason → approved. The stamp records Stripe provenance
    // but (post-#448) does NOT overwrite the human amount — the 105-vs-100 gap
    // now surfaces in the DERIVED settled total (Phase 5), not by rewriting it.
    const ok = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId,
      stripeChargeId: chargeId,
      overrideAmountMismatchReason: "Donor added a tip on top of the charge",
    });
    expect(ok.status).toBe(200);
    const gift = await readGift(giftId);
    expect(gift.amount).toBe("105.00"); // human figure preserved, not overwritten
    expect(gift.finalAmountSource).toBe("stripe");
    expect(gift.finalAmountStripeChargeId).toBe(chargeId);
    expect(gift.originalHumanCrmAmount).toBeNull();
    expect((await readAlloc(allocId)).subAmount).toBe("105.00");
    expect(await readOpenReviews(giftId)).toHaveLength(0);
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
      expect(staged.status).toBe("match_confirmed");
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
