import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPaymentApplicationsForStagedIds } from "./paymentApplicationsTestUtil";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  proposeSettlementLink,
  confirmSettlementLink,
} from "../lib/settlementWriter";

/**
 * DB-backed coverage for the unified reconciler's DEFAULT work-queue filter
 * (GET /api/reconciliation/cards with no `queue` param).
 *
 * Rule under test: a LEGACY `approved` staged row (already linked/minted a gift
 * via the old /staged-payments flow) should "stay approved" and drop OUT of the
 * work queue — UNLESS it still has Stripe to tie in. Concretely an `approved`
 * row is excluded from the default queue iff it has a gift link
 * (matchedGiftId OR createdGiftId) AND no Stripe payout matched/proposed to it.
 * `pending` rows, approved rows with NO gift, and approved rows that still carry
 * Stripe evidence remain real work. A `reconciled` row is normally terminal
 * (explicit `reconciled` queue only) EXCEPT a settlement-confirmed deposit whose
 * backing Stripe charges are not all booked yet — that one stays in the default
 * queue (as its unbooked charge cards) until every charge is credited.
 *
 * Same seam as the other reconciliation suites: only `requireAuth` is mocked to
 * inject a seeded admin; the queue SQL is the real production code. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `recon_q_user_${Date.now()}`,
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

const RUN = `reconq_${Date.now()}`;
const MARKER = `${RUN}_payer`;
const REALM_ID = `${RUN}_realm`;
const ORG_ID = `${RUN}_org`;
const ACCOUNT_ID = `${RUN}_acct`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  giftAllocations: Db["giftAllocations"];
  paymentApplications: Db["paymentApplications"];
  settlementLinks: Db["settlementLinks"];
};
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

const stagedIds: string[] = [];
const giftIds: string[] = [];
const splitIds: string[] = [];
const payoutIds: string[] = [];
const chargeIds: string[] = [];
const allocationIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

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

async function seedGift(
  amount: string,
  dateReceived: string | null = null,
): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
    details: "Queue-filter test gift",
    dateReceived,
  });
  giftIds.push(id);
  return id;
}

async function seedStaged(opts: {
  label: string;
  matchedGiftId?: string | null;
  createdGiftId?: string | null;
  groupReconciledGiftId?: string | null;
  amount?: string;
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    amount: opts.amount ?? "100.00",
    dateReceived: "2026-03-15",
    payerName: `${MARKER} ${opts.label}`,
    organizationId: ORG_ID,
    matchStatus: "matched",
    matchedGiftId: opts.matchedGiftId ?? null,
    createdGiftId: opts.createdGiftId ?? null,
    groupReconciledGiftId: opts.groupReconciledGiftId ?? null,
  });
  stagedIds.push(id);
  return id;
}

// Link a staged payment to a pre-existing gift as part of a SPLIT: the staged
// row carries NONE of the matched/created/group id columns — its resolution
// lives entirely in counted payment_applications ledger rows (what the split
// route writes).
async function seedSplit(
  stagedPaymentId: string,
  giftId: string,
  subAmount: string,
): Promise<string> {
  const id = nextId("split");
  await db.insert(schema.paymentApplications).values({
    id,
    paymentId: stagedPaymentId,
    giftId,
    amountApplied: subAmount,
    evidenceSource: "quickbooks",
  });
  splitIds.push(id);
  return id;
}

async function seedPayoutFor(
  stagedPaymentId: string,
  link: "proposed" | "matched" = "proposed",
): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: "100.00",
    netTotal: "97.00",
    arrivalDate: "2026-03-15",
  });
  payoutIds.push(id);
  // settlement_links is the authoritative payout↔deposit store; the legacy
  // pointer columns are dropped. Build the intended tie directly. FK cascade
  // on payout_id cleans it up.
  const fields =
    link === "matched"
      ? confirmSettlementLink({
          depositStagedPaymentId: stagedPaymentId,
          conflictGiftId: null,
          confirmedByUserId: null,
          confirmedAt: new Date(),
        })
      : proposeSettlementLink(stagedPaymentId, null);
  await db.insert(schema.settlementLinks).values({
    id: `sl_${id}`,
    payoutId: id,
    depositStagedPaymentId: fields.depositStagedPaymentId,
    conflictGiftId: fields.conflictGiftId,
    lifecycle: fields.lifecycle,
    provenance: fields.provenance,
    confirmedByUserId: fields.confirmedByUserId,
    confirmedAt: fields.confirmedAt,
  });
  return id;
}

async function seedCharge(opts: {
  payoutId: string;
  gross: string;
  fee: string;
  net: string;
  payerName: string;
  organizationId?: string | null;
  matchStatus?: "matched" | "unmatched";
  matchedGiftId?: string | null;
  createdGiftId?: string | null;
  exclusionReason?: "failed_charge" | "other";
}): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: opts.payoutId,
    grossAmount: opts.gross,
    feeAmount: opts.fee,
    netAmount: opts.net,
    dateReceived: "2026-03-15",
    payerName: opts.payerName,
    exclusionReason: opts.exclusionReason ?? null,
    matchStatus: opts.matchStatus ?? "unmatched",
    organizationId: opts.organizationId ?? null,
    matchedGiftId: opts.matchedGiftId ?? null,
    createdGiftId: opts.createdGiftId ?? null,
  });
  chargeIds.push(id);
  return id;
}

type Card = {
  stagedPaymentId: string;
  stripeChargeId?: string | null;
  amount?: string | null;
  payerName?: string | null;
  stripeChargeDonorName?: string | null;
  stripePayoutId?: string | null;
  stripeGrossAmount?: string | null;
  stripeNetAmount?: string | null;
  stripeFeeAmount?: string | null;
  resolvedGiftId?: string | null;
  isSourceGroup?: boolean;
  ready?: boolean;
};

// Fetch the raw card objects the endpoint returns for our run's marker.
async function cards(queue?: string): Promise<Card[]> {
  const q = `q=${encodeURIComponent(MARKER)}&limit=100`;
  const path = `/api/reconciliation/cards?${q}${queue ? `&queue=${queue}` : ""}`;
  const res = await apiGet(path);
  expect(res.status).toBe(200);
  return res.json.data as Card[];
}

// Total reported by the endpoint's pagination for our marker (lockstep check).
async function cardTotal(queue?: string): Promise<number> {
  const q = `q=${encodeURIComponent(MARKER)}&limit=100`;
  const path = `/api/reconciliation/cards?${q}${queue ? `&queue=${queue}` : ""}`;
  const res = await apiGet(path);
  expect(res.status).toBe(200);
  return res.json.pagination.total as number;
}

// Collect the stagedPaymentIds the cards endpoint returns for our run's marker.
async function cardIds(queue?: string): Promise<Set<string>> {
  const q = `q=${encodeURIComponent(MARKER)}&limit=100`;
  const path = `/api/reconciliation/cards?${q}${queue ? `&queue=${queue}` : ""}`;
  const res = await apiGet(path);
  expect(res.status).toBe(200);
  return new Set<string>((res.json.data as Array<{ stagedPaymentId: string }>).map((c) => c.stagedPaymentId));
}

// Read the `ready` (one-click/bulk-approvable) flag for a single card.
async function readyFor(stagedPaymentId: string): Promise<boolean> {
  const q = `q=${encodeURIComponent(MARKER)}&limit=100`;
  const res = await apiGet(`/api/reconciliation/cards?${q}`);
  expect(res.status).toBe(200);
  const card = (res.json.data as Array<{ stagedPaymentId: string; ready: boolean }>).find(
    (c) => c.stagedPaymentId === stagedPaymentId,
  );
  expect(card, `card ${stagedPaymentId} should be in the queue`).toBeTruthy();
  return card!.ready;
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
    stagedPayments: dbMod.stagedPayments,
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    giftAllocations: dbMod.giftAllocations,
    paymentApplications: dbMod.paymentApplications,
    settlementLinks: dbMod.settlementLinks,
  };
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Reconciliation Queue Test Org ${RUN}`,
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
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  if (splitIds.length)
    await db
      .delete(schema.paymentApplications)
      .where(inArrayFn(schema.paymentApplications.id, splitIds));
  await clearPaymentApplicationsForStagedIds(stagedIds);
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (allocationIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.id, allocationIds));
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn("[reconciliation-cards-queue] skipped: no live DATABASE_URL");
  }
});

describe.skipIf(!HAS_DB)("Reconciliation default queue — legacy approved rows (integration)", () => {
  it("excludes approved+gift+no-stripe but keeps pending and approved-with-work", async () => {
    const giftA = await seedGift("100.00");
    const giftB = await seedGift("100.00");
    const giftC = await seedGift("100.00");
    const giftD = await seedGift("100.00");

    const pendingId = await seedStaged({ label: "pending" });
    // The reported bug: approved, linked to a pre-existing gift, no Stripe.
    const approvedMatchedId = await seedStaged({
      label: "approved-matched-nostripe",
      matchedGiftId: giftA,
    });
    // Legacy minted gift, no Stripe.
    const approvedCreatedId = await seedStaged({
      label: "approved-created-nostripe",
      createdGiftId: giftB,
    });
    // Approved with a gift but Stripe still to tie in → real work.
    const approvedStripeId = await seedStaged({
      label: "approved-matched-stripe",
      matchedGiftId: giftC,
    });
    await seedPayoutFor(approvedStripeId);
    // Same as above but the payout is linked via the MATCHED column (not
    // proposed) → still real work; locks both legs of "matched OR proposed".
    const approvedStripeMatchedId = await seedStaged({
      label: "approved-matched-stripe-matched",
      matchedGiftId: giftD,
    });
    await seedPayoutFor(approvedStripeMatchedId, "matched");
    // Approved with NO gift link → anomaly, still review.
    const approvedNoGiftId = await seedStaged({
      label: "approved-nogift",
    });
    // Terminal at both planes: the deposit minted its own gift.
    const reconciledId = await seedStaged({
      label: "reconciled",
      createdGiftId: await seedGift("100.00"),
    });

    const def = await cardIds();
    expect(def.has(pendingId)).toBe(true);
    expect(def.has(approvedStripeId)).toBe(true);
    expect(def.has(approvedStripeMatchedId)).toBe(true);
    expect(def.has(approvedNoGiftId)).toBe(true);
    // "Stay approved" — dropped from the work queue.
    expect(def.has(approvedMatchedId)).toBe(false);
    expect(def.has(approvedCreatedId)).toBe(false);
    expect(def.has(reconciledId)).toBe(false);

    // The done bucket = derived match_confirmed: every booked resolution shows
    // there (a matched row included — provenance no longer splits the bucket).
    const done = await cardIds("done");
    expect(done.has(reconciledId)).toBe(true);
    expect(done.has(pendingId)).toBe(false);
    expect(done.has(approvedMatchedId)).toBe(true);
  }, 30_000);

  it("excludes an approved SPLIT payment and a group-reconciled row (resolution not in the id columns)", async () => {
    // The reported bug (Frey Foundation): a payment split across two existing
    // gifts kept showing as unlinked money. A split carries NONE of
    // matchedGiftId / createdGiftId / groupReconciledGiftId — its resolution
    // lives entirely in counted payment_applications rows — so the old
    // predicate (which only checked matched/created) wrongly re-admitted it to
    // the live queue.
    const splitGiftA = await seedGift("60.00");
    const splitGiftB = await seedGift("40.00");
    const splitId = await seedStaged({
      label: "approved-split-nostripe",
      amount: "100.00",
    });
    await seedSplit(splitId, splitGiftA, "60.00");
    await seedSplit(splitId, splitGiftB, "40.00");

    // A split that STILL has Stripe to tie in remains real work — the
    // settlement_link re-admits it (mirrors the matched+stripe leg above).
    const splitGiftC = await seedGift("100.00");
    const splitStripeId = await seedStaged({
      label: "approved-split-stripe",
      amount: "100.00",
    });
    await seedSplit(splitStripeId, splitGiftC, "100.00");
    await seedPayoutFor(splitStripeId);

    // A group-reconciled member row (groupReconciledGiftId set, no matched/
    // created) is likewise resolved and must drop out of the live queue.
    const groupGift = await seedGift("100.00");
    const groupReconciledId = await seedStaged({
      label: "approved-groupreconciled-nostripe",
      groupReconciledGiftId: groupGift,
    });

    const def = await cardIds();
    // Split + group-reconciled resolutions are DONE — out of the live queue.
    expect(def.has(splitId)).toBe(false);
    expect(def.has(groupReconciledId)).toBe(false);
    // ...unless Stripe is still pending on it.
    expect(def.has(splitStripeId)).toBe(true);
  }, 30_000);
});

describe.skipIf(!HAS_DB)("Reconciliation readiness — date proximity (integration)", () => {
  it("auto-readies a pending single-donor card only when a fee-band gift's date is within the window", async () => {
    // In-window: a same-donor fee-band gift dated 5 days from the payment is the
    // single confident proposal → the card is one-click/bulk approvable.
    await seedGift("100.00", "2026-03-20");
    const inStaged = await seedStaged({
      label: "ready-date-in-window",
      amount: "100.00",
    });
    // Out-of-window: same donor + fee band, but the only candidate gift is dated
    // far outside ~90 days, so no confident proposal exists → not ready.
    await seedGift("200.00", "2026-09-01");
    const outStaged = await seedStaged({
      label: "ready-date-out-window",
      amount: "200.00",
    });
    // Unknown date: a gift with no date_received can't be proven in-window, so
    // the strict clause keeps it out of the auto-ready pool → not ready.
    await seedGift("300.00", null);
    const nullStaged = await seedStaged({
      label: "ready-date-null",
      amount: "300.00",
    });

    expect(await readyFor(inStaged)).toBe(true);
    expect(await readyFor(outStaged)).toBe(false);
    expect(await readyFor(nullStaged)).toBe(false);
  }, 30_000);
});

describe.skipIf(!HAS_DB)(
  "Reconciliation per-charge expansion — Stripe payout (integration)",
  () => {
    it("expands a Stripe-backed deposit into one card per unresolved charge", async () => {
      // A QB deposit settled by a Stripe payout carrying TWO distinct charges.
      const depositId = await seedStaged({
        label: "stripe-deposit-2charges",
        amount: "500.00",
      });
      const payoutId = await seedPayoutFor(depositId, "matched");
      const chA = await seedCharge({
        payoutId,
        gross: "300.00",
        fee: "9.00",
        net: "291.00",
        payerName: "Vanguard Charitable",
        organizationId: ORG_ID,
      });
      const chB = await seedCharge({
        payoutId,
        gross: "200.00",
        fee: "6.00",
        net: "194.00",
        payerName: "Fidelity Charitable",
        organizationId: ORG_ID,
      });

      const list = await cards();
      const expanded = list.filter((c) => c.stagedPaymentId === depositId);
      // One card per charge — never a single bundled deposit card.
      expect(expanded.length).toBe(2);
      const byCharge = new Map(expanded.map((c) => [c.stripeChargeId, c]));
      expect(byCharge.has(chA)).toBe(true);
      expect(byCharge.has(chB)).toBe(true);

      const cardA = byCharge.get(chA)!;
      // The charge's donor is surfaced (never "Stripe"), with its own
      // payout id + gross/net/fee.
      expect(cardA.stripeChargeDonorName).toBe("Reconciliation Queue Test Org " + RUN);
      expect(cardA.stripePayoutId).toBe(payoutId);
      expect(cardA.stripeGrossAmount).toBe("300.00");
      expect(cardA.stripeNetAmount).toBe("291.00");
      expect(cardA.stripeFeeAmount).toBe("9.00");
      expect(cardA.resolvedGiftId ?? null).toBeNull();
      expect(cardA.isSourceGroup ?? false).toBe(false);
      // Charge cards are never bulk-approvable (per-charge action only).
      expect(cardA.ready ?? false).toBe(false);

      // Pagination total counts the expanded charge cards (lockstep).
      const total = await cardTotal();
      const otherMarkerCards = list.filter(
        (c) => c.stagedPaymentId !== depositId,
      ).length;
      expect(total).toBe(otherMarkerCards + 2);
    }, 30_000);

    it("drops a charge once it resolves to a gift; settles the deposit when all do", async () => {
      const depositId = await seedStaged({
        label: "stripe-deposit-resolving",
        amount: "400.00",
      });
      const payoutId = await seedPayoutFor(depositId, "matched");
      const giftForCharge = await seedGift("250.00", "2026-03-15");
      // One charge already tied to a gift → resolved → filtered out.
      await seedCharge({
        payoutId,
        gross: "250.00",
        fee: "7.50",
        net: "242.50",
        payerName: "Resolved Charge Donor",
        organizationId: ORG_ID,
        matchStatus: "matched",
        matchedGiftId: giftForCharge,
      });
      // One charge still open → the only card the deposit produces.
      const openCharge = await seedCharge({
        payoutId,
        gross: "150.00",
        fee: "4.50",
        net: "145.50",
        payerName: "Open Charge Donor",
        organizationId: ORG_ID,
      });

      const list = await cards();
      const expanded = list.filter((c) => c.stagedPaymentId === depositId);
      expect(expanded.length).toBe(1);
      expect(expanded[0]!.stripeChargeId).toBe(openCharge);
    }, 30_000);

    it("keeps a settlement-confirmed (reconciled) deposit in the work queue until its charges are booked", async () => {
      // Plane 1 (payout↔deposit) confirmed: the new one-click settlement approve
      // ties the link and marks the QB deposit lump `reconciled`. Plane 2 (per
      // charge → gift) is NOT done: a backing charge is still uncredited. The
      // deposit must stay in the default gift-report queue as its unbooked charge
      // card, or the money would be invisible and unbookable (silent under-credit).
      const depositId = await seedStaged({
        label: "reconciled-settlement-open-charge",
        amount: "180.00",
      });
      const payoutId = await seedPayoutFor(depositId, "matched");
      const openCharge = await seedCharge({
        payoutId,
        gross: "180.00",
        fee: "5.40",
        net: "174.60",
        payerName: "Reconciled Settlement Open Charge",
        organizationId: ORG_ID,
      });

      const before = await cards();
      const expanded = before.filter((c) => c.stagedPaymentId === depositId);
      expect(expanded.length).toBe(1);
      expect(expanded[0]!.stripeChargeId).toBe(openCharge);
      // Charge cards are never bulk-approvable (per-charge action only).
      expect(expanded[0]!.ready ?? false).toBe(false);

      // Book the charge → the deposit has no unresolved charges left → it drops
      // out of the work queue (now terminal at both planes).
      const giftForCharge = await seedGift("180.00", "2026-03-15");
      await db
        .update(schema.stripeStagedCharges)
        .set({ matchStatus: "matched", matchedGiftId: giftForCharge })
        .where(eqFn(schema.stripeStagedCharges.id, openCharge));

      const after = await cardIds();
      expect(after.has(depositId)).toBe(false);
    }, 30_000);

    it("drops a reconciled deposit that already booked its OWN coarse gift, even with uncredited charges (no double-count)", async () => {
      // A Stripe-payout deposit reconciled by CREATING a single coarse
      // deposit-level gift (the whole payout net booked as one gift). Its backing
      // charges are NOT individually credited. Because the coarse gift is already
      // the single counted record for this money (design §4.3 "one count across
      // the settlement boundary": with no per-charge counted units the coarse
      // deposit gift stays the counted record), the deposit must NOT be re-expanded
      // into per-charge cards — doing so surfaced it as unbooked and fanned it into
      // several "same QB deposit" cards each proposing a fresh, double-counting gift.
      const coarseGift = await seedGift("174.60", "2026-03-15");
      const depositId = await seedStaged({
        label: "reconciled-coarse-gift-open-charges",
        createdGiftId: coarseGift,
        amount: "180.00",
      });
      const payoutId = await seedPayoutFor(depositId, "matched");
      // Two uncredited backing charges — the exact shape that used to fan out.
      await seedCharge({
        payoutId,
        gross: "100.00",
        fee: "3.00",
        net: "97.00",
        payerName: "Coarse Gift Charge One",
        organizationId: ORG_ID,
      });
      await seedCharge({
        payoutId,
        gross: "80.00",
        fee: "2.40",
        net: "77.60",
        payerName: "Coarse Gift Charge Two",
        organizationId: ORG_ID,
      });

      // Absent from the live gift-report queue (no per-charge expansion).
      const live = await cardIds();
      expect(live.has(depositId)).toBe(false);

      // Still visible as terminal work in the done bucket.
      const done = await cardIds("done");
      expect(done.has(depositId)).toBe(true);
    }, 30_000);

    it("drops a fully-resolved deposit whose only unlinked charge is EXCLUDED (failed payment attempt)", async () => {
      // The reported bug (Dukes): a Stripe-source switch reconciled the real
      // charge to the gift and auto-excluded the incumbent FAILED charge
      // (excluded/failed_charge, no gift link — correctly, it's not money).
      // The old filter kept any charge without a gift link, so the deposit
      // stayed in the live queue forever, anchored on the excluded charge and
      // proposing "create gift" for money that was already fully booked.
      const gift = await seedGift("156.00", "2026-03-15");
      const depositId = await seedStaged({
        label: "approved-excluded-failed-charge",
        matchedGiftId: gift,
        amount: "156.00",
      });
      const payoutId = await seedPayoutFor(depositId, "matched");
      // The failed attempt: excluded, never linked to a gift.
      await seedCharge({
        payoutId,
        gross: "156.00",
        fee: "4.83",
        net: "151.17",
        payerName: "Failed Attempt Donor",
        organizationId: ORG_ID,
        exclusionReason: "failed_charge",
      });
      // The real charge: reconciled to the same gift.
      await seedCharge({
        payoutId,
        gross: "156.00",
        fee: "4.83",
        net: "151.17",
        payerName: "Real Charge Donor",
        organizationId: ORG_ID,
        matchStatus: "matched",
        matchedGiftId: gift,
      });

      // Fully resolved at both planes → gone from the live queue.
      const live = await cardIds();
      expect(live.has(depositId)).toBe(false);
    }, 30_000);

    it("does NOT re-admit a reconciled deposit whose only giftless charge is excluded", async () => {
      // Same hole in the reconciled re-admit branch: an excluded charge has no
      // gift link but is terminal — it must not count as "unbooked work".
      const gift = await seedGift("90.00", "2026-03-15");
      const depositId = await seedStaged({
        label: "reconciled-excluded-only-open",
        amount: "90.00",
      });
      const payoutId = await seedPayoutFor(depositId, "matched");
      await seedCharge({
        payoutId,
        gross: "90.00",
        fee: "2.70",
        net: "87.30",
        payerName: "Reconciled Excluded Failed",
        organizationId: ORG_ID,
        exclusionReason: "failed_charge",
      });
      await seedCharge({
        payoutId,
        gross: "90.00",
        fee: "2.70",
        net: "87.30",
        payerName: "Reconciled Excluded Booked",
        organizationId: ORG_ID,
        matchStatus: "matched",
        matchedGiftId: gift,
      });

      const live = await cardIds();
      expect(live.has(depositId)).toBe(false);
    }, 30_000);

    it("drops a fully-resolved deposit whose only unlinked charge is a manual exclusion (human dismissal)", async () => {
      // Same class of bug one reason over: a human-dismissed charge (manual
      // exclusion) is terminal without a gift link and must not pin the
      // deposit either.
      const gift = await seedGift("120.00", "2026-03-15");
      const depositId = await seedStaged({
        label: "approved-rejected-charge",
        matchedGiftId: gift,
        amount: "120.00",
      });
      const payoutId = await seedPayoutFor(depositId, "matched");
      await seedCharge({
        payoutId,
        gross: "120.00",
        fee: "3.60",
        net: "116.40",
        payerName: "Rejected Charge Donor",
        organizationId: ORG_ID,
        exclusionReason: "other",
      });
      await seedCharge({
        payoutId,
        gross: "120.00",
        fee: "3.60",
        net: "116.40",
        payerName: "Rejected Suite Booked Charge",
        organizationId: ORG_ID,
        matchStatus: "matched",
        matchedGiftId: gift,
      });

      const live = await cardIds();
      expect(live.has(depositId)).toBe(false);
    }, 30_000);

    it("keeps a pending deposit visible as a plain deposit card when ALL its charges are excluded", async () => {
      // The deposit itself is still unbooked pending money — with every backing
      // charge excluded the lateral yields no rows, so the LEFT JOIN keeps the
      // row once with NULL charge columns (a plain deposit card), not zero rows.
      const depositId = await seedStaged({
        label: "pending-all-charges-excluded",
        amount: "75.00",
      });
      // A PROPOSED (not confirmed) payout tie: a confirmed settlement link
      // would itself derive the deposit match_confirmed — the pending-with-
      // excluded-charges state only exists while the tie is still proposed.
      const payoutId = await seedPayoutFor(depositId);
      await seedCharge({
        payoutId,
        gross: "75.00",
        fee: "2.25",
        net: "72.75",
        payerName: "All Excluded Charge",
        organizationId: ORG_ID,
        exclusionReason: "failed_charge",
      });

      const list = await cards();
      const mine = list.filter((c) => c.stagedPaymentId === depositId);
      expect(mine.length).toBe(1);
      expect(mine[0]!.stripeChargeId ?? null).toBeNull();
    }, 30_000);
  },
);

