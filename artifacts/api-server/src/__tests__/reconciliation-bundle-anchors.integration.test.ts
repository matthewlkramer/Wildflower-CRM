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
import { getTableColumns } from "drizzle-orm";
import { stagedStatusSql } from "../lib/derivedStatus";
import {
  qbMintedGiftIdForPayment,
  qbSoleGiftIdForPayment,
  seedStripeApplication,
} from "./paymentApplicationsTestUtil";

/**
 * DB-backed coverage for the UNIFIED settlement-anchor surface of the reactive
 * bundle workbench:
 *   - GET  /api/reconciliation/bundle-anchors  (enumeration + dedup + queue)
 *   - POST /api/reconciliation/bundle-proposals (anchor canonicalization)
 *   - the pure-QB (standalone deposit) assemble → derive → confirm lifecycle.
 *
 * The point of the feature: ANY anchor flows through ONE workbench — Stripe
 * payouts AND standalone QuickBooks deposits/payments — without ever turning the
 * same money into two anchors. So these tests assert:
 *   - the list returns BOTH anchor kinds, and OMITS a QB row that is settled
 *     into a Stripe payout (the pairing fact) or
 *     derived `excluded` (exclusion_reason set, incl. processor_payout),
 *   - the `confirmed` queue and the `source` filter bucket correctly,
 *   - assembling from a TIED QB id canonicalizes to the payout's single draft
 *     (no duplicate draft / no double-book),
 *   - a STANDALONE QB deposit still mints / matches / excludes on confirm via the
 *     same money-write primitives (no parallel money path).
 *
 * Same seam as the sibling bundle-confirm suite: only `requireAuth` is mocked to
 * inject a seeded admin user; the SQL, the gates, and the guarded writes are real
 * production code. Skips automatically when no real DATABASE_URL is configured.
 *
 * Seeded anchors use far-FUTURE dates so they sort to the TOP of the (date-desc)
 * list — making both presence AND absence assertions reliable against the shared
 * dev DB regardless of how many real anchors already exist.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `recon_anchor_user_${Date.now()}`,
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

const RUN = `reconanchor_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  people: Db["people"];
  households: Db["households"];
  emails: Db["emails"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  stagedPayments: Db["stagedPayments"];
  paymentApplications: Db["paymentApplications"];
  reconciliationBundleDrafts: Db["reconciliationBundleDrafts"];
  sourceLinks: Db["sourceLinks"];
  sourceLinkId: Db["sourceLinkId"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

const draftIds: string[] = [];
const payoutIds: string[] = [];
const chargeIds: string[] = [];
const stagedIds: string[] = [];
const seededGiftIds: string[] = [];
const createdGiftIds: string[] = [];
const createdDonorIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;
// A far-future date keeps a fresh seed at the very top of the date-desc list.
const futureDate = () => `2099-12-${String((seq % 27) + 1).padStart(2, "0")}`;

async function post(
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

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function listAnchors(
  queue: "needs_review" | "confirmed" | "all",
  source?: "stripe_payout" | "qb_staged_payment",
): Promise<Map<string, any>> {
  const qs = new URLSearchParams({ queue, limit: "500" });
  if (source) qs.set("source", source);
  const { status, json } = await getJson(
    `/api/reconciliation/bundle-anchors?${qs.toString()}`,
  );
  expect(status).toBe(200);
  const map = new Map<string, any>();
  for (const r of json.data as any[]) map.set(`${r.anchorType}:${r.anchorId}`, r);
  return map;
}

async function seedPayout(opts: {
  status: "unmatched" | "confirmed_reconciled";
  matched?: string;
}): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: "100.00",
    netTotal: "96.80",
    arrivalDate: futureDate(),
    chargeCount: 1,
  });
  payoutIds.push(id);
  // The payout↔QBO-lump pairing is a plain fact on the QBO row
  // (staged_payments.settled_stripe_payout_id, 0168) — the settlement-link
  // lifecycle is retired. Stamp the pairing for a settled fixture.
  if (opts.status === "confirmed_reconciled" && opts.matched) {
    await db
      .update(schema.stagedPayments)
      .set({ settledStripePayoutId: id })
      .where(eqFn(schema.stagedPayments.id, opts.matched));
  }
  return id;
}

async function seedCharge(
  payoutId: string,
  opts: {
    matchedGiftId?: string;
    exclusionReason?: string | null;
    /** Confirmed charge-grain QB tie: this charge already claims that QB row. */
    linkedQbStagedPaymentId?: string | null;
  } = {},
): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: payoutId,
    grossAmount: "100.00",
    feeAmount: "3.20",
    netAmount: "96.80",
    dateReceived: futureDate(),
    payerName: `Zztest Anchor Charge ${RUN}`,
    payerEmail: `${RUN}-charge@example.invalid`,
    // Status is DERIVED from facts: an exclusion_reason reads `excluded`, a
    // counted stripe ledger row reads `match_confirmed`, otherwise `pending`
    // (the pointer columns are retired and never written).
    exclusionReason: (opts.exclusionReason ?? null) as never,
  });
  // The tie lives ONLY in the source_links ledger (the authority).
  if (opts.linkedQbStagedPaymentId) {
    await db.insert(schema.sourceLinks).values({
      id: schema.sourceLinkId("charge_qb_tie", id),
      linkType: "charge_qb_tie",
      stripeChargeId: id,
      qbStagedPaymentId: opts.linkedQbStagedPaymentId,
      lifecycle: "confirmed",
      provenance: "human",
    });
  }
  if (opts.matchedGiftId) {
    await seedStripeApplication({
      stripeChargeId: id,
      giftId: opts.matchedGiftId,
      amountApplied: "100.00",
    });
  }
  chargeIds.push(id);
  return id;
}

/** The charge's tie state from the source_links ledger (the sole authority). */
async function ledgerTies(chargeId: string): Promise<{
  linkedQb: string | null;
  feeQb: string | null;
}> {
  const rows = await db
    .select({
      linkType: schema.sourceLinks.linkType,
      lifecycle: schema.sourceLinks.lifecycle,
      qb: schema.sourceLinks.qbStagedPaymentId,
    })
    .from(schema.sourceLinks)
    .where(eqFn(schema.sourceLinks.stripeChargeId, chargeId));
  return {
    linkedQb:
      rows.find(
        (r) => r.linkType === "charge_qb_tie" && r.lifecycle === "confirmed",
      )?.qb ?? null,
    feeQb: rows.find((r) => r.linkType === "charge_fee_row")?.qb ?? null,
  };
}

async function seedStaged(opts: {
  exclusionReason?: string | null;
  amount?: string;
  payerName?: string;
  createdGiftId?: string | null;
  matchedGiftId?: string | null;
  fundingSource?: string | null;
  /** `deposit` makes the row a settlement lump (isSettlementLump). */
  entityType?: "payment" | "deposit";
  /** Marks a matcher auto-application (derives `match_proposed` when the
   * counted link exists but was never human-confirmed). */
  autoApplied?: boolean;
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: opts.entityType ?? "payment",
    qbEntityId: id,
    qbLineId: "",
    amount: opts.amount ?? "75.00",
    dateReceived: futureDate(),
    payerName: opts.payerName ?? `Zztest Anchor Payer ${RUN}`,
    exclusionReason: (opts.exclusionReason ?? null) as never,
    autoApplied: opts.autoApplied ?? false,
    // A deposit's inferred origin. Clear non-Stripe origins (check/cash/wire/…)
    // are dropped from the "Needs payout tie" anchor column; stripe/donorbox/NULL
    // stay visible.
    fundingSource: (opts.fundingSource ?? null) as never,
  });
  stagedIds.push(id);
  // A booked QB deposit/payment carries the gift it was minted into / matched
  // to via the authoritative `payment_applications` ledger (the deprecated
  // staged link columns are no longer written).
  const linkedGiftId = opts.createdGiftId ?? opts.matchedGiftId ?? null;
  if (linkedGiftId) {
    await db.insert(schema.paymentApplications).values({
      id: nextId("pa"),
      paymentId: id,
      giftId: linkedGiftId,
      amountApplied: opts.amount ?? "75.00",
      evidenceSource: "quickbooks",
      matchMethod: "system",
      createdTheGift: opts.createdGiftId != null,
    });
  }
  return id;
}

async function seedGift(): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    organizationId: ORG_ID,
    ownerUserId: TEST_USER_ID,
    amount: "75.00",
    dateReceived: futureDate(),
  });
  seededGiftIds.push(id);
  return id;
}

async function readStaged(id: string) {
  const [row] = await db
    .select({
      ...getTableColumns(schema.stagedPayments),
      status: stagedStatusSql,
    })
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

function trackConfirm(json: any): void {
  for (const r of json?.rows ?? []) {
    if (r.giftId) createdGiftIds.push(r.giftId);
    if (r.createdDonorId) createdDonorIds.push(r.createdDonorId);
  }
}

async function assemble(
  anchorType: "stripe_payout" | "qb_staged_payment",
  anchorId: string,
): Promise<{ draftId: string; revision: number; rowKey: string; json: any }> {
  const res = await post("/api/reconciliation/bundle-proposals", {
    anchorType,
    anchorId,
  });
  expect(res.status).toBe(200);
  draftIds.push(res.json.draftId);
  return {
    draftId: res.json.draftId as string,
    revision: res.json.revision as number,
    rowKey: res.json.rows?.[0]?.rowKey as string,
    json: res.json,
  };
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
    households: dbMod.households,
    emails: dbMod.emails,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    stagedPayments: dbMod.stagedPayments,
    paymentApplications: dbMod.paymentApplications,
    reconciliationBundleDrafts: dbMod.reconciliationBundleDrafts,
    sourceLinks: dbMod.sourceLinks,
    sourceLinkId: dbMod.sourceLinkId,
  };
  eqFn = drizzle.eq;
  andFn = drizzle.and;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Reconciliation Anchor Test Org ${RUN}`,
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

  const allGiftIds = [...createdGiftIds, ...seededGiftIds];
  if (allGiftIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, allGiftIds));
  // A QB mint books a cash-application ledger row (RESTRICT FK → gift).
  if (allGiftIds.length)
    await db
      .delete(schema.paymentApplications)
      .where(inArrayFn(schema.paymentApplications.giftId, allGiftIds));
  if (allGiftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, allGiftIds));
  if (draftIds.length)
    await db
      .delete(schema.reconciliationBundleDrafts)
      .where(inArrayFn(schema.reconciliationBundleDrafts.id, draftIds));
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
  if (createdDonorIds.length) {
    await db
      .delete(schema.emails)
      .where(inArrayFn(schema.emails.personId, createdDonorIds));
    await db
      .delete(schema.emails)
      .where(inArrayFn(schema.emails.organizationId, createdDonorIds));
    await db
      .delete(schema.people)
      .where(inArrayFn(schema.people.id, createdDonorIds));
    await db
      .delete(schema.households)
      .where(inArrayFn(schema.households.id, createdDonorIds));
    await db
      .delete(schema.organizations)
      .where(inArrayFn(schema.organizations.id, createdDonorIds));
  }
  // Sweep every org/person still owned by this run's user (ORG_ID plus any donor
  // minted during a confirm) so the user delete can't trip the owner_user_id FK.
  // TEST_USER_ID is unique per run, so this only ever touches this suite's rows.
  await db
    .delete(schema.people)
    .where(eqFn(schema.people.ownerUserId, TEST_USER_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.ownerUserId, TEST_USER_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[reconciliation-bundle-anchors] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("Unified bundle-anchor enumeration (integration)", () => {
  it("lists both sources in needs_review and omits tied/non-anchor QB rows", async () => {
    // Eligible anchors (should appear).
    const pEligible = await seedPayout({ status: "unmatched" });
    await seedCharge(pEligible);
    const sStandalone = await seedStaged({});

    // QB rows settled into a payout (the pairing fact) → OMITTED; their
    // payouts are the anchor instead — and a settled payout is not
    // needs_review work either.
    const sMatched = await seedStaged({});
    const pMatched = await seedPayout({
      status: "confirmed_reconciled",
      matched: sMatched,
    });

    // Derived-excluded rows (incl. processor_payout) → OMITTED.
    const sProcessorPayout = await seedStaged({
      exclusionReason: "processor_payout",
    });

    // Funding-source filter: a clear non-Stripe deposit (a check) drops out of
    // the standalone-QB anchor column; a `stripe`-sourced and a NULL-source
    // (unknown, no signal) deposit stay — a real Stripe gap is never hidden.
    const sCheck = await seedStaged({ fundingSource: "check" });
    const sStripeSource = await seedStaged({
      fundingSource: "stripe",
    });
    const sDonorbox = await seedStaged({
      fundingSource: "donorbox",
    });
    const sUnknownSource = await seedStaged({
      fundingSource: null,
    });

    const map = await listAnchors("needs_review");

    // Present (an unpaired payout + a standalone deposit).
    expect(map.has(`stripe_payout:${pEligible}`)).toBe(true);
    expect(map.has(`qb_staged_payment:${sStandalone}`)).toBe(true);

    // Present: plausibly-Stripe and unknown-origin standalone deposits.
    expect(map.has(`qb_staged_payment:${sStripeSource}`)).toBe(true);
    expect(map.has(`qb_staged_payment:${sDonorbox}`)).toBe(true);
    expect(map.has(`qb_staged_payment:${sUnknownSource}`)).toBe(true);

    // Omitted. Every staged row tied to a payout drops out (its payout is the
    // anchor). A `confirmed` (settled) payout is not needs_review work either.
    expect(map.has(`stripe_payout:${pMatched}`)).toBe(false);
    expect(map.has(`qb_staged_payment:${sMatched}`)).toBe(false);
    expect(map.has(`qb_staged_payment:${sProcessorPayout}`)).toBe(false);
    // Omitted: a clear non-Stripe origin (a check) is not a settlement anchor.
    expect(map.has(`qb_staged_payment:${sCheck}`)).toBe(false);

    // Normalized projection on the standalone QB anchor.
    const row = map.get(`qb_staged_payment:${sStandalone}`);
    expect(row.anchorType).toBe("qb_staged_payment");
    expect(Number(row.amount)).toBeCloseTo(75, 2);
    expect(row.statusLabel).toBe("pending");
    expect(row.chargeCount).toBeNull();
    expect(row.date).toBeTruthy();
  });

  it("emits the bank amount and per-charge exclusion reason so a failed charge reads as excluded, not a second gift", async () => {
    // A payout containing a failed-then-reversed payment: the charge-sum net
    // (net_total 96.80) differs from what actually hit the bank (amount 100.00
    // — the figure the QB deposit matches). One live charge still needs work;
    // one FAILED charge was auto-excluded at ingest and must carry its
    // exclusion reason so the card can grey it instead of rendering it like a
    // bookable gift.
    const p = await seedPayout({ status: "unmatched" });
    const chLive = await seedCharge(p);
    const chFailed = await seedCharge(p, {
      exclusionReason: "failed_charge",
    });

    const map = await listAnchors("needs_review");
    const row = map.get(`stripe_payout:${p}`);
    expect(row).toBeTruthy();

    // amount stays the charge-sum net (existing consumers eyeball-match it);
    // bankAmount is the NEW raw bank figure. A QB anchor never carries one.
    expect(Number(row.amount)).toBeCloseTo(96.8, 2);
    expect(Number(row.bankAmount)).toBeCloseTo(100, 2);
    const sQb = await seedStaged({});
    const qbRow = (await listAnchors("needs_review")).get(
      `qb_staged_payment:${sQb}`,
    );
    expect(qbRow.bankAmount).toBeNull();

    const byId = new Map<string, any>(
      (row.charges as any[]).map((c) => [c.id, c]),
    );
    const live = byId.get(chLive);
    expect(live.status).toBe("pending");
    expect(live.exclusionReason).toBeNull();
    const failed = byId.get(chFailed);
    expect(failed.status).toBe("excluded");
    expect(failed.exclusionReason).toBe("failed_charge");
  });

  it("omits an unmatched payout whose charges are ALL settled from needs_review (still under all)", async () => {
    // Regression: a recurring Stripe donor whose every charge is already booked
    // into a gift (`reconciled`) but whose payout was never tied to a QB deposit
    // (stays `unmatched`). The per-charge gifts are confirmed, so there is no work
    // left in this workbench — the payout must NOT linger in needs_review, or
    // confirmed money reappears in the settlement queue.
    const pSettled = await seedPayout({ status: "unmatched" });
    await seedCharge(pSettled, { matchedGiftId: await seedGift() });

    // A sibling unmatched payout that still has an OPEN (pending) charge — a gift
    // still needs minting there, so it MUST remain in needs_review.
    const pOpen = await seedPayout({ status: "unmatched" });
    await seedCharge(pOpen);

    const needs = await listAnchors("needs_review");
    expect(needs.has(`stripe_payout:${pSettled}`)).toBe(false);
    expect(needs.has(`stripe_payout:${pOpen}`)).toBe(true);

    // Fully-settled-but-untied money is still discoverable under `all`.
    const all = await listAnchors("all");
    expect(all.has(`stripe_payout:${pSettled}`)).toBe(true);
  });

  it("confirmed queue lists settled rows and omits pending ones", async () => {
    // "Settled" is derived match_confirmed: linked to / minted into a gift.
    const sApproved = await seedStaged({ matchedGiftId: await seedGift() });
    const sReconciled = await seedStaged({ createdGiftId: await seedGift() });
    const sPending = await seedStaged({});
    // A confirmed payout ties to its QB deposit via a confirmed settlement link.
    const sConfirmedDep = await seedStaged({ matchedGiftId: await seedGift() });
    const pConfirmed = await seedPayout({
      status: "confirmed_reconciled",
      matched: sConfirmedDep,
    });
    const pUnmatched = await seedPayout({ status: "unmatched" });

    const map = await listAnchors("confirmed");

    expect(map.has(`qb_staged_payment:${sApproved}`)).toBe(true);
    expect(map.has(`qb_staged_payment:${sReconciled}`)).toBe(true);
    expect(map.has(`stripe_payout:${pConfirmed}`)).toBe(true);

    expect(map.has(`qb_staged_payment:${sPending}`)).toBe(false);
    expect(map.has(`stripe_payout:${pUnmatched}`)).toBe(false);
  });

  it("the source filter returns only the requested anchor kind", async () => {
    const p = await seedPayout({ status: "unmatched" });
    await seedCharge(p);
    const s = await seedStaged({});

    const qbOnly = await listAnchors("needs_review", "qb_staged_payment");
    for (const r of qbOnly.values())
      expect(r.anchorType).toBe("qb_staged_payment");
    expect(qbOnly.has(`qb_staged_payment:${s}`)).toBe(true);
    expect(qbOnly.has(`stripe_payout:${p}`)).toBe(false);

    const stripeOnly = await listAnchors("needs_review", "stripe_payout");
    for (const r of stripeOnly.values())
      expect(r.anchorType).toBe("stripe_payout");
    expect(stripeOnly.has(`stripe_payout:${p}`)).toBe(true);
    expect(stripeOnly.has(`qb_staged_payment:${s}`)).toBe(false);
  });

  it("an unpaired payout and a standalone deposit are both orphan anchors with no proposal", async () => {
    // The proposed-counterpart surface is retired with the settlement
    // workflow — pairing is a deterministic fact, never a proposal. Both
    // sides of an unpaired amount surface as their own orphan anchors.
    const pOrphan = await seedPayout({ status: "unmatched" });
    await seedCharge(pOrphan);
    const sOrphan = await seedStaged({});

    const map = await listAnchors("all");

    const row = map.get(`stripe_payout:${pOrphan}`);
    expect(row).toBeTruthy();
    expect(row.batchStatus).toBe("orphan");
    expect(row.proposedMatch).toBeUndefined();
    // No draft assembled yet → readiness is a null hint (confirm re-derives).
    expect(row.readiness).toBeNull();

    const orphan = map.get(`qb_staged_payment:${sOrphan}`);
    expect(orphan.batchStatus).toBe("orphan");
    expect(orphan.proposedMatch).toBeUndefined();
    expect(orphan.readiness).toBeNull();
  });

  it("caches confirm-readiness from the assembled draft snapshot", async () => {
    const pReady = await seedPayout({ status: "unmatched" });
    await seedCharge(pReady);

    // Before assembling any draft, readiness is a null hint.
    let map = await listAnchors("all");
    expect(map.get(`stripe_payout:${pReady}`).readiness).toBeNull();

    // Assembling persists a bundle-draft snapshot; its summary now backs the
    // anchor's readiness badge.
    await assemble("stripe_payout", pReady);

    map = await listAnchors("all");
    const row = map.get(`stripe_payout:${pReady}`);
    expect(row.readiness).toBeTruthy();
    expect(typeof row.readiness.ready).toBe("boolean");
    expect(typeof row.readiness.warningCount).toBe("number");
    expect(typeof row.readiness.blockerCount).toBe("number");
  });
});

describe.skipIf(!HAS_DB)("Payout search resolve target (integration)", () => {
  it("finds an orphan payout by id text + amount band, omitting tied payouts", async () => {
    const pOrphan = await seedPayout({ status: "unmatched" });
    const sTied = await seedStaged({});
    const pTied = await seedPayout({
      status: "confirmed_reconciled",
      matched: sTied,
    });

    // By id text → returns exactly the orphan payout with its projected facts.
    const byId = await getJson(
      `/api/reconciliation/payout-search?q=${pOrphan}&limit=100`,
    );
    expect(byId.status).toBe(200);
    const cand = (byId.json.data as any[]).find((c) => c.id === pOrphan);
    expect(cand).toBeTruthy();
    expect(Number(cand.amount)).toBeCloseTo(96.8, 2);
    expect(cand.chargeCount).toBe(1);

    // A tied payout is never a resolve target (it already settles a deposit).
    const tied = await getJson(
      `/api/reconciliation/payout-search?q=${pTied}&limit=100`,
    );
    expect((tied.json.data as any[]).map((c) => c.id)).not.toContain(pTied);

    // Amount-band search (near the payout NET) also surfaces the orphan.
    const byAmt = await getJson(
      `/api/reconciliation/payout-search?amount=96.80&limit=100`,
    );
    expect((byAmt.json.data as any[]).map((c) => c.id)).toContain(pOrphan);
  });

  it("finds a payout by its charges' payer name; text overrides the amount band", async () => {
    // A payout has no name of its own — the donor names live on its charges.
    // The search must surface "the payout containing Jane's charge" by name.
    const pOrphan = await seedPayout({ status: "unmatched" });
    await seedCharge(pOrphan);
    const sTied = await seedStaged({});
    const pTied = await seedPayout({
      status: "confirmed_reconciled",
      matched: sTied,
    });
    await seedCharge(pTied);

    const payer = encodeURIComponent(`Zztest Anchor Charge ${RUN}`);

    // By charge payer name → the orphan surfaces; a tied payout stays excluded
    // even though its charge matches the same name.
    const byName = await getJson(
      `/api/reconciliation/payout-search?q=${payer}&limit=100`,
    );
    expect(byName.status).toBe(200);
    const ids = (byName.json.data as any[]).map((c) => c.id);
    expect(ids).toContain(pOrphan);
    expect(ids).not.toContain(pTied);

    // Text + far-off amount: the band must only RANK, not hard-filter — the
    // named payout (net 96.80) still returns against amount=5000. This is the
    // regression: a payout booked as several small per-donor QB rows has no
    // row near the deposit amount, and an ANDed band hid name matches.
    const byBoth = await getJson(
      `/api/reconciliation/payout-search?q=${payer}&amount=5000&limit=100`,
    );
    expect(byBoth.status).toBe(200);
    expect((byBoth.json.data as any[]).map((c) => c.id)).toContain(pOrphan);

    // Amount-only search keeps the hard band (it is the sole criterion).
    const byAmtOnly = await getJson(
      `/api/reconciliation/payout-search?amount=5000&limit=100`,
    );
    expect(byAmtOnly.status).toBe(200);
    expect((byAmtOnly.json.data as any[]).map((c) => c.id)).not.toContain(
      pOrphan,
    );
  });
});

describe.skipIf(!HAS_DB)("Resolve-confirm settlement tie (integration)", () => {
  it("confirms a picked ALREADY-BOOKED lump deposit linkage-only (repair path, no pending-only 409)", async () => {
    // The prod regression: a bookkeeper books the deposit BEFORE the payout
    // tie exists. The deposit derives `match_confirmed`, and the old
    // pending-only pre-gate rejected the pick with a misleading transient
    // "settlement changed — refresh and retry". The primitive's linkage-only
    // arm handles exactly this: record the tie, demote covered coarse rows.
    const gift = await seedGift();
    const dep = await seedStaged({
      entityType: "deposit",
      amount: "96.80",
      matchedGiftId: gift, // counted ledger row → derives match_confirmed
    });
    const po = await seedPayout({ status: "unmatched" });
    await seedCharge(po);

    const r = await post(
      `/api/reconciliation/settlement-links/${po}/confirm`,
      { depositStagedPaymentId: dep },
    );
    expect(r.status).toBe(200);
    expect(r.json.confirmed).toBe(true);
    expect(r.json.kind).toBe("confirmed_linkage_only");
    expect(r.json.depositStagedPaymentId).toBe(dep);

    // The pairing fact is recorded in one transaction.
    const [paired] = await db
      .select({ settledStripePayoutId: schema.stagedPayments.settledStripePayoutId })
      .from(schema.stagedPayments)
      .where(eqFn(schema.stagedPayments.id, dep));
    expect(paired!.settledStripePayoutId).toBe(po);

    // Idempotent re-confirm: already settled → success, never re-booked.
    const again = await post(
      `/api/reconciliation/settlement-links/${po}/confirm`,
      { depositStagedPaymentId: dep },
    );
    expect(again.status).toBe(200);
    expect(again.json.kind).toBe("already_confirmed");
  });

  it("still fully reconciles a picked PENDING lump deposit", async () => {
    const dep = await seedStaged({ entityType: "deposit", amount: "96.80" });
    const po = await seedPayout({ status: "unmatched" });
    await seedCharge(po);

    const r = await post(
      `/api/reconciliation/settlement-links/${po}/confirm`,
      { depositStagedPaymentId: dep },
    );
    expect(r.status).toBe(200);
    expect(r.json.confirmed).toBe(true);
    expect(r.json.kind).toBe("confirmed_reconciled");
  });

  it("rejects a matcher-proposed (never human-confirmed) deposit as PERMANENT deposit_unconfirmable", async () => {
    // `match_proposed` (auto-applied, unreviewed) stays unconfirmable — the
    // proposed booking must be resolved first. The code must be the permanent
    // `deposit_unconfirmable`, not the transient tie_transition retry toast.
    const gift = await seedGift();
    const dep = await seedStaged({
      entityType: "deposit",
      amount: "96.80",
      matchedGiftId: gift,
      autoApplied: true, // counted but never human-confirmed → match_proposed
    });
    const po = await seedPayout({ status: "unmatched" });
    await seedCharge(po);

    const r = await post(
      `/api/reconciliation/settlement-links/${po}/confirm`,
      { depositStagedPaymentId: dep },
    );
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("deposit_unconfirmable");
    // The toast surfaces this message verbatim — it must name the ACTUAL
    // blocker (an unreviewed auto-proposed match), not a generic "resolved
    // elsewhere" that leaves the reviewer guessing.
    expect(r.json.message).toMatch(/auto-proposed/i);
  });

  it("rejects an EXCLUDED picked deposit, naming the exclusion and its reason", async () => {
    // An excluded row was deliberately taken out of review — it can never back
    // a settlement. The 409 must say exactly that (and echo the humanized
    // exclusion reason) so the reviewer knows to un-exclude first, not retry.
    const dep = await seedStaged({
      entityType: "deposit",
      amount: "96.80",
      exclusionReason: "other_revenue",
    });
    const po = await seedPayout({ status: "unmatched" });
    await seedCharge(po);

    const r = await post(
      `/api/reconciliation/settlement-links/${po}/confirm`,
      { depositStagedPaymentId: dep },
    );
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("deposit_unconfirmable");
    expect(r.json.message).toMatch(/excluded/i);
    expect(r.json.message).toMatch(/other revenue/i);
  });

  it("overrideExclusion re-includes an EXCLUDED picked deposit in the same tx and confirms", async () => {
    // The deliberate two-click override: the picker labels the excluded row,
    // and a second click sends overrideExclusion. The confirm re-includes the
    // deposit exactly like the re-include primitive (clear the exclusion, pin
    // classification_source='manual' so the re-runnable classifier never
    // re-excludes it) and then settles normally — all in one transaction.
    const dep = await seedStaged({
      entityType: "deposit",
      amount: "96.80",
      exclusionReason: "other_revenue",
    });
    const po = await seedPayout({ status: "unmatched" });
    await seedCharge(po);

    const r = await post(
      `/api/reconciliation/settlement-links/${po}/confirm`,
      { depositStagedPaymentId: dep, overrideExclusion: true },
    );
    expect(r.status).toBe(200);
    expect(r.json.confirmed).toBe(true);
    expect(r.json.kind).toBe("confirmed_reconciled");
    expect(r.json.depositStagedPaymentId).toBe(dep);

    const [row] = await db
      .select()
      .from(schema.stagedPayments)
      .where(eqFn(schema.stagedPayments.id, dep));
    expect(row!.exclusionReason).toBeNull();
    expect(row!.classificationSource).toBe("manual");

    const [paired] = await db
      .select({ settledStripePayoutId: schema.stagedPayments.settledStripePayoutId })
      .from(schema.stagedPayments)
      .where(eqFn(schema.stagedPayments.id, dep));
    expect(paired!.settledStripePayoutId).toBe(po);
  });

  it("overrideExclusion NEVER bypasses a deposit settled against a different payout", async () => {
    // The override is scoped to exclusions only — a confirmed tie elsewhere is
    // claimed money, and overriding it would double-count. The flag must be
    // inert here: same permanent 409 as without it.
    const dep = await seedStaged({ entityType: "deposit", amount: "96.80" });
    await seedPayout({ status: "confirmed_reconciled", matched: dep });
    const po = await seedPayout({ status: "unmatched" });
    await seedCharge(po);

    const r = await post(
      `/api/reconciliation/settlement-links/${po}/confirm`,
      { depositStagedPaymentId: dep, overrideExclusion: true },
    );
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("deposit_unconfirmable");
    expect(r.json.message).toMatch(/different Stripe payout/i);
  });

  it("rejects picking a deposit already SETTLED against a different payout, saying so", async () => {
    // Exclusivity: a deposit backs at most one payout's settlement. A CONFIRMED
    // tie elsewhere is permanent — the message must name the conflict (not a
    // transient "refresh and retry") and the code must stay
    // deposit_unconfirmable so the UI renders the permanent-failure toast.
    const dep = await seedStaged({ entityType: "deposit", amount: "96.80" });
    await seedPayout({ status: "confirmed_reconciled", matched: dep });
    const po = await seedPayout({ status: "unmatched" });
    await seedCharge(po);

    const r = await post(
      `/api/reconciliation/settlement-links/${po}/confirm`,
      { depositStagedPaymentId: dep },
    );
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("deposit_unconfirmable");
    expect(r.json.message).toMatch(/different Stripe payout/i);
  });

});

describe.skipIf(!HAS_DB)("QB pick-list search labels unpickable rows (integration)", () => {
  it("returns excluded and already-settled deposits WITH a blocking label, never hidden", async () => {
    // Product rule: unpickable rows are LABELED, not hidden — a silently
    // missing row hides a mis-derived status from the user, while a labeled
    // row lets them spot (and report) the actual blocker. Enforcement stays
    // on the action endpoints (specific 409s).
    const payer = `Zztest QbPick ${RUN}`;
    const sPending = await seedStaged({ payerName: payer });
    const sBooked = await seedStaged({
      payerName: payer,
      matchedGiftId: await seedGift(),
    });
    const sExcluded = await seedStaged({
      payerName: payer,
      exclusionReason: "other_revenue",
    });
    const sSettled = await seedStaged({ payerName: payer });
    await seedPayout({ status: "confirmed_reconciled", matched: sSettled });
    // A row already claimed by a confirmed CHARGE-grain tie (an individually
    // booked payout's charge) — the manual "Find QuickBooks match" dialog
    // would otherwise offer it and only fail at confirm with a 409.
    const sChargeTied = await seedStaged({ payerName: payer });
    const poTied = await seedPayout({ status: "unmatched" });
    await seedCharge(poTied, { linkedQbStagedPaymentId: sChargeTied });

    const r = await getJson(
      `/api/reconciliation/qb-search?q=${encodeURIComponent(payer)}&limit=100`,
    );
    expect(r.status).toBe(200);
    const rows = r.json.data as any[];
    const byId = new Map(rows.map((c) => [c.id, c]));

    // ALL five rows come back — nothing is filtered out.
    expect(byId.has(sPending)).toBe(true);
    expect(byId.has(sBooked)).toBe(true);
    expect(byId.has(sExcluded)).toBe(true);
    expect(byId.has(sSettled)).toBe(true);
    expect(byId.has(sChargeTied)).toBe(true);

    // Pickable rows carry NO blocking label.
    expect(byId.get(sPending).conflictReason).toBeNull();
    expect(byId.get(sBooked).conflictReason).toBeNull();
    // The booked row still advertises its owning gift so the picker can gray it.
    expect(byId.get(sBooked).alreadyLinkedGiftId).toBeTruthy();

    // Blocked rows say exactly WHY they can't be picked.
    expect(byId.get(sExcluded).conflictReason).toMatch(/excluded/i);
    expect(byId.get(sExcluded).conflictReason).toMatch(/other revenue/i);
    expect(byId.get(sSettled).conflictReason).toMatch(
      /settled against another Stripe payout/i,
    );
    expect(byId.get(sChargeTied).conflictReason).toMatch(
      /tied to another Stripe charge/i,
    );

    // The machine-readable kind rides alongside the human label so the UI can
    // make ONLY the exclusion click-to-override (settled/tied stay hard-blocked).
    expect(byId.get(sPending).conflictKind).toBeNull();
    expect(byId.get(sBooked).conflictKind).toBeNull();
    expect(byId.get(sExcluded).conflictKind).toBe("excluded");
    expect(byId.get(sSettled).conflictKind).toBe("settled_elsewhere");
    expect(byId.get(sChargeTied).conflictKind).toBe("tied_to_charge");
  });
});

describe.skipIf(!HAS_DB)("Manual charge-tie exclusion override (integration)", () => {
  it("409s on an excluded QB row without the flag; with it, re-includes and ties in one tx", async () => {
    const po = await seedPayout({ status: "unmatched" });
    const chargeId = await seedCharge(po);
    // Amount must exactly match the charge's gross (100.00) — the assignment
    // is exact-amount, so the override only clears the exclusion blocker.
    const qb = await seedStaged({
      amount: "100.00",
      exclusionReason: "other_revenue",
    });

    // Without the flag the excluded row is rejected with the row-level issue.
    const blocked = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      { qbStagedPaymentIds: [qb] },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe("qb_rows_unavailable");

    // With the flag the row is re-included (exclusion cleared, manual pin)
    // and tied to the payout's charge in the same transaction.
    const r = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      { qbStagedPaymentIds: [qb], overrideExclusion: true },
    );
    expect(r.status).toBe(200);
    expect(r.json.confirmed).toBe(true);
    expect(r.json.tied).toBe(1);

    const [row] = await db
      .select()
      .from(schema.stagedPayments)
      .where(eqFn(schema.stagedPayments.id, qb));
    expect(row!.exclusionReason).toBeNull();
    expect(row!.classificationSource).toBe("manual");

    expect((await ledgerTies(chargeId)).linkedQb).toBe(qb);
  });
});

describe.skipIf(!HAS_DB)("Pinned charge-tie + amount-mismatch override (integration)", () => {
  it("409s amount_mismatch on a pinned mismatched row without the flag; nothing is written", async () => {
    const po = await seedPayout({ status: "unmatched" });
    const chargeId = await seedCharge(po); // gross 100.00 / net 96.80
    const qb = await seedStaged({ amount: "75.00" }); // matches neither

    const r = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      { qbStagedPaymentIds: [qb], chargeId },
    );
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("amount_mismatch");

    expect((await ledgerTies(chargeId)).linkedQb).toBeNull();
  });

  it("ties a mismatched row to the PINNED charge with overrideAmountMismatch", async () => {
    const po = await seedPayout({ status: "unmatched" });
    const chargeId = await seedCharge(po);
    const qb = await seedStaged({ amount: "75.00" });

    const r = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      { qbStagedPaymentIds: [qb], chargeId, overrideAmountMismatch: true },
    );
    expect(r.status).toBe(200);
    expect(r.json.confirmed).toBe(true);
    expect(r.json.tied).toBe(1);

    expect((await ledgerTies(chargeId)).linkedQb).toBe(qb);
    const [charge] = await db
      .select()
      .from(schema.stripeStagedCharges)
      .where(eqFn(schema.stripeStagedCharges.id, chargeId));
    expect(charge!.crossProcessorLinkedByUserId).toBe(TEST_USER_ID);
  });

  it("a pinned EXACT match still ties without any flag — and lands on the named charge", async () => {
    const po = await seedPayout({ status: "unmatched" });
    // Two same-amount charges: the pin decides which one gets the row.
    const chargeA = await seedCharge(po);
    const chargeB = await seedCharge(po);
    const qb = await seedStaged({ amount: "100.00" });

    const r = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      { qbStagedPaymentIds: [qb], chargeId: chargeB },
    );
    expect(r.status).toBe(200);
    expect(r.json.tied).toBe(1);

    expect((await ledgerTies(chargeB)).linkedQb).toBe(qb);
    expect((await ledgerTies(chargeA)).linkedQb).toBeNull();
  });

  it("excluded + mismatched needs BOTH flags: exclusion 409 first, then both flags tie and re-include", async () => {
    const po = await seedPayout({ status: "unmatched" });
    const chargeId = await seedCharge(po);
    const qb = await seedStaged({
      amount: "75.00",
      exclusionReason: "other_revenue",
    });

    // The amount flag alone does NOT sneak past the exclusion blocker.
    const stillExcluded = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      { qbStagedPaymentIds: [qb], chargeId, overrideAmountMismatch: true },
    );
    expect(stillExcluded.status).toBe(409);
    expect(stillExcluded.json.error).toBe("qb_rows_unavailable");

    const r = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      {
        qbStagedPaymentIds: [qb],
        chargeId,
        overrideExclusion: true,
        overrideAmountMismatch: true,
      },
    );
    expect(r.status).toBe(200);
    expect(r.json.tied).toBe(1);

    const [row] = await db
      .select()
      .from(schema.stagedPayments)
      .where(eqFn(schema.stagedPayments.id, qb));
    expect(row!.exclusionReason).toBeNull();
    expect(row!.classificationSource).toBe("manual");
    expect((await ledgerTies(chargeId)).linkedQb).toBe(qb);
  });

  it("rejects malformed pins: multiple rows with chargeId, or the amount flag without a pin (400)", async () => {
    const po = await seedPayout({ status: "unmatched" });
    const chargeId = await seedCharge(po);
    const qb1 = await seedStaged({ amount: "100.00" });
    const qb2 = await seedStaged({ amount: "100.00" });

    const multi = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      { qbStagedPaymentIds: [qb1, qb2], chargeId },
    );
    expect(multi.status).toBe(400);
    expect(multi.json.message).toMatch(/exactly one/i);

    const noPin = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      { qbStagedPaymentIds: [qb1], overrideAmountMismatch: true },
    );
    expect(noPin.status).toBe(400);
    expect(noPin.json.message).toMatch(/requires chargeId/i);
  });

  it("409s charge_unavailable when the pinned charge is already tied, 404 when it's another payout's", async () => {
    const qbClaimed = await seedStaged({ amount: "100.00" });
    const po = await seedPayout({ status: "unmatched" });
    const tiedCharge = await seedCharge(po, {
      linkedQbStagedPaymentId: qbClaimed,
    });
    const qb = await seedStaged({ amount: "75.00" });

    const taken = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      {
        qbStagedPaymentIds: [qb],
        chargeId: tiedCharge,
        overrideAmountMismatch: true,
      },
    );
    expect(taken.status).toBe(409);
    expect(taken.json.error).toBe("charge_unavailable");
    expect(taken.json.message).toMatch(/already carries/i);

    const poOther = await seedPayout({ status: "unmatched" });
    const otherCharge = await seedCharge(poOther);
    const wrongPayout = await post(
      `/api/reconciliation/payouts/${po}/charge-ties/confirm`,
      {
        qbStagedPaymentIds: [qb],
        chargeId: otherCharge,
        overrideAmountMismatch: true,
      },
    );
    expect(wrongPayout.status).toBe(404);
    expect(wrongPayout.json.error).toBe("not_found");
  });
});

describe.skipIf(!HAS_DB)("Revert confirmed charge↔QB tie (integration)", () => {
  it("clears the tie, the claimed fee row, and the provenance, and frees the QB row for re-picking", async () => {
    // The undo for a wrong confirm ("tied the wrong QB charge to a donor"):
    // plane-1 only — both derived statuses fall out of the cleared link, so
    // the QB row must come back PICKABLE in the manual search afterwards.
    const payer = `Zztest RevertTie ${RUN}`;
    const qb = await seedStaged({ amount: "100.00", payerName: payer });
    const feeQb = await seedStaged({ amount: "-3.20", payerName: payer });
    const po = await seedPayout({ status: "unmatched" });
    const chargeId = await seedCharge(po, { linkedQbStagedPaymentId: qb });
    // The confirm path also stamps the claimed sibling fee row + who/when —
    // seed those directly so the revert must clear ALL of it. Fee reads are
    // ledger-authoritative (source_links).
    await db
      .update(schema.stripeStagedCharges)
      .set({
        crossProcessorLinkedByUserId: TEST_USER_ID,
        crossProcessorLinkedAt: new Date(),
      })
      .where(eqFn(schema.stripeStagedCharges.id, chargeId));
    await db.insert(schema.sourceLinks).values({
      id: schema.sourceLinkId("charge_fee_row", chargeId),
      linkType: "charge_fee_row",
      stripeChargeId: chargeId,
      qbStagedPaymentId: feeQb,
      lifecycle: "confirmed",
      provenance: "human",
      confirmedByUserId: TEST_USER_ID,
      confirmedAt: new Date(),
    });

    // Sanity: while tied, the QB row is labeled unpickable in the search.
    const before = await getJson(
      `/api/reconciliation/qb-search?q=${encodeURIComponent(payer)}&limit=100`,
    );
    expect(before.status).toBe(200);
    const beforeRow = (before.json.data as any[]).find((r) => r.id === qb);
    expect(beforeRow?.conflictKind).toBe("tied_to_charge");

    const r = await post(
      `/api/reconciliation/charges/${chargeId}/qb-tie/revert`,
    );
    expect(r.status).toBe(200);
    expect(r.json.reverted).toBe(true);
    expect(r.json.chargeId).toBe(chargeId);
    expect(r.json.qbStagedPaymentId).toBe(qb);
    expect(r.json.feeQbStagedPaymentId).toBe(feeQb);

    const tiesAfter = await ledgerTies(chargeId);
    expect(tiesAfter.linkedQb).toBeNull();
    expect(tiesAfter.feeQb).toBeNull();
    const [charge] = await db
      .select()
      .from(schema.stripeStagedCharges)
      .where(eqFn(schema.stripeStagedCharges.id, chargeId));
    expect(charge!.crossProcessorLinkedByUserId).toBeNull();
    expect(charge!.crossProcessorLinkedAt).toBeNull();

    // The QB row is pickable again — no blocking label, no owning charge.
    const after = await getJson(
      `/api/reconciliation/qb-search?q=${encodeURIComponent(payer)}&limit=100`,
    );
    expect(after.status).toBe(200);
    const afterRow = (after.json.data as any[]).find((r) => r.id === qb);
    expect(afterRow?.conflictReason).toBeNull();
    expect(afterRow?.conflictKind).toBeNull();
  });

  it("404s on an unknown charge", async () => {
    const r = await post(
      `/api/reconciliation/charges/${RUN}_missing_charge/qb-tie/revert`,
    );
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("not_found");
  });

  it("409s not_confirmed on a charge with no confirmed tie (reject handles proposals)", async () => {
    const po = await seedPayout({ status: "unmatched" });
    const chargeId = await seedCharge(po);

    const r = await post(
      `/api/reconciliation/charges/${chargeId}/qb-tie/revert`,
    );
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("not_confirmed");
  });

  it("is idempotent-safe: a second revert of the same charge 409s instead of silently succeeding", async () => {
    // Two reviewers double-clicking / racing: the loser must get a clear
    // signal the state moved, not a fake success on an already-untied charge.
    const qb = await seedStaged({ amount: "100.00" });
    const po = await seedPayout({ status: "unmatched" });
    const chargeId = await seedCharge(po, { linkedQbStagedPaymentId: qb });

    const first = await post(
      `/api/reconciliation/charges/${chargeId}/qb-tie/revert`,
    );
    expect(first.status).toBe(200);

    const second = await post(
      `/api/reconciliation/charges/${chargeId}/qb-tie/revert`,
    );
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("not_confirmed");
  });
});

describe.skipIf(!HAS_DB)("Tied-anchor canonicalization (integration)", () => {
  it("assembling a matched-tied QB id yields the payout's single draft", async () => {
    const staged = await seedStaged({});
    const payout = await seedPayout({
      status: "confirmed_reconciled",
      matched: staged,
    });
    await seedCharge(payout);

    // Entry A: from the tied QB id → rewritten to the payout.
    const fromQb = await assemble("qb_staged_payment", staged);
    expect(fromQb.json.anchorType).toBe("stripe_payout");
    expect(fromQb.json.anchorId).toBe(payout);

    // Entry B: from the payout directly → SAME draft (no duplicate / no double-book).
    const fromPayout = await assemble("stripe_payout", payout);
    expect(fromPayout.draftId).toBe(fromQb.draftId);
  });

  it("assembling a payout settled into an already-booked deposit surfaces the tie with no action", async () => {
    // The QB deposit was already approved into a gift and later settled
    // against the payout (the pairing fact). Assembling the payout surfaces
    // the settled tie read-only \u2014 there is nothing left to confirm.
    const keptGift = await seedGift();
    const staged = await seedStaged({
      createdGiftId: keptGift,
    });
    const payout = await seedPayout({
      status: "confirmed_reconciled",
      matched: staged,
    });
    await seedCharge(payout);

    const a = await assemble("stripe_payout", payout);
    expect(a.json.anchorType).toBe("stripe_payout");
    expect(a.json.anchorId).toBe(payout);
    expect(a.json.tie).toBeTruthy();
    expect(a.json.tie.status).toBe("confirmed_reconciled");
    expect(a.json.tie.action).toBe("none");
    expect(a.json.tie.depositStagedPaymentId).toBe(staged);
  });

  it("refuses to derive a standalone QB draft once a payout settles into it", async () => {
    const staged = await seedStaged({});
    // Assemble standalone FIRST — a pure-QB draft persists.
    const a = await assemble("qb_staged_payment", staged);
    expect(a.json.anchorType).toBe("qb_staged_payment");

    // A Stripe payout now settles into the same deposit.
    await seedPayout({ status: "confirmed_reconciled", matched: staged });

    // Editing the stale QB draft is refused (must reconcile via the payout).
    const derived = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/derive`,
      {
        rows: [
          {
            rowKey: staged,
            giftKind: "mint",
            donorKind: "existing",
            donorId: ORG_ID,
            donorRecordKind: "organization",
          },
        ],
      },
    );
    expect(derived.status).toBe(409);
    expect(derived.json.error).toBe("anchor_superseded");
  });

  it("refuses to confirm a standalone QB draft once a payout settles into it after derive", async () => {
    const staged = await seedStaged({});
    const a = await assemble("qb_staged_payment", staged);
    expect(a.json.anchorType).toBe("qb_staged_payment");

    // Make the draft ready WHILE still standalone.
    const derived = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/derive`,
      {
        rows: [
          {
            rowKey: staged,
            giftKind: "mint",
            donorKind: "existing",
            donorId: ORG_ID,
            donorRecordKind: "organization",
          },
        ],
      },
    );
    expect(derived.status).toBe(200);
    expect(derived.json.summary.ready).toBe(true);

    // The pairing appears AFTER the draft was derived.
    await seedPayout({ status: "confirmed_reconciled", matched: staged });

    const confirm = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/confirm`,
      { expectedRevision: derived.json.revision, allowWarnings: true },
    );
    trackConfirm(confirm.json);
    expect(confirm.status).toBe(409);
    expect(confirm.json.error).toBe("anchor_superseded");
    // The money was NOT booked as pure-QB: no gift was minted on the row (the
    // row now reads match_confirmed from the settled pairing fact itself).
    expect(await qbMintedGiftIdForPayment(staged)).toBeNull();
    expect(await qbSoleGiftIdForPayment(staged)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("Standalone QB anchor confirm (integration)", () => {
  it("mints a gift from a standalone QB deposit to an existing donor", async () => {
    const staged = await seedStaged({});

    const a = await assemble("qb_staged_payment", staged);
    expect(a.json.anchorType).toBe("qb_staged_payment");
    expect(a.json.rows).toHaveLength(1);
    expect(a.rowKey).toBe(staged);

    const derived = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/derive`,
      {
        rows: [
          {
            rowKey: a.rowKey,
            giftKind: "mint",
            donorKind: "existing",
            donorId: ORG_ID,
            donorRecordKind: "organization",
          },
        ],
      },
    );
    expect(derived.status).toBe(200);
    expect(derived.json.summary.ready).toBe(true);

    const confirm = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/confirm`,
      { expectedRevision: derived.json.revision },
    );
    trackConfirm(confirm.json);
    expect(confirm.status).toBe(200);
    expect(confirm.json.giftsCreated).toBe(1);
    expect(confirm.json.rows[0].outcome).toBe("minted_gift");

    const giftId = confirm.json.rows[0].giftId as string;
    expect((await readGift(giftId))?.organizationId).toBe(ORG_ID);
    const sp = await readStaged(staged);
    expect(sp?.status).toBe("match_confirmed");
    expect(await qbMintedGiftIdForPayment(staged)).toBe(giftId);
  });

  it("matches a standalone QB deposit to an existing gift", async () => {
    const gift = await seedGift();
    const staged = await seedStaged({});

    const a = await assemble("qb_staged_payment", staged);
    const derived = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/derive`,
      { rows: [{ rowKey: a.rowKey, giftKind: "match", giftId: gift }] },
    );
    expect(derived.status).toBe(200);
    expect(derived.json.summary.ready).toBe(true);

    // The seeded gift's donor (ORG) intentionally differs from the staged
    // payer name, so the re-assemble raises a NON-blocking donor warning —
    // accept it with allowWarnings (ready is still true).
    const confirm = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/confirm`,
      { expectedRevision: derived.json.revision, allowWarnings: true },
    );
    expect(confirm.status).toBe(200);
    expect(confirm.json.giftsMatched).toBe(1);
    expect(confirm.json.rows[0].outcome).toBe("matched_gift");
    expect((await readStaged(staged))?.status).toBe("match_confirmed");
    expect(await qbSoleGiftIdForPayment(staged)).toBe(gift);
  });

  it("excludes a standalone QB deposit with a reason", async () => {
    const staged = await seedStaged({});

    const a = await assemble("qb_staged_payment", staged);
    const derived = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/derive`,
      { rows: [{ rowKey: a.rowKey, giftKind: "exclude", exclusionReason: "membership" }] },
    );
    expect(derived.status).toBe(200);
    expect(derived.json.summary.ready).toBe(true);

    const confirm = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/confirm`,
      { expectedRevision: derived.json.revision },
    );
    expect(confirm.status).toBe(200);
    expect(confirm.json.giftsCreated).toBe(0);
    expect(confirm.json.rows[0].outcome).toBe("excluded");
    const sp = await readStaged(staged);
    expect(sp?.status).toBe("excluded");
    expect(sp?.exclusionReason).toBe("membership");
  });
});

describe.skipIf(!HAS_DB)(
  "Bundle confirm-ties with a multi-charge payout (integration)",
  () => {
    it("succeeds without minting per-charge QB ties (deposit membership rides the settled pairing, not charge_qb_tie)", async () => {
      // A normal settlement-bundle shape: MANY charges settle into ONE QB
      // deposit lump. source_links enforces at most one confirmed
      // charge_qb_tie per QB row, so this route must never stamp per-charge
      // deposit ties — doing so for >1 charge would abort the transaction.
      const deposit = await seedStaged({ amount: "200.00" });
      const payout = await seedPayout({
        status: "confirmed_reconciled",
        matched: deposit,
      });
      const chargeA = await seedCharge(payout);
      const chargeB = await seedCharge(payout);

      const r = await post(
        `/api/reconciliation/bundles/${deposit}/confirm-ties`,
        {},
      );
      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(true);
      expect(r.json.chargesLinked).toBe(0);

      // No charge_qb_tie ledger rows were minted.
      const ties = await db
        .select({ id: schema.sourceLinks.id })
        .from(schema.sourceLinks)
        .where(
          andFn(
            eqFn(schema.sourceLinks.linkType, "charge_qb_tie"),
            inArrayFn(schema.sourceLinks.stripeChargeId, [chargeA, chargeB]),
          ),
        );
      expect(ties).toHaveLength(0);

      // Idempotent: re-running is a no-op 200.
      const again = await post(
        `/api/reconciliation/bundles/${deposit}/confirm-ties`,
        {},
      );
      expect(again.status).toBe(200);
      expect(again.json.chargesLinked).toBe(0);
    });
  },
);
