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
import {
  proposeSettlementLink,
  confirmSettlementLink,
} from "../lib/settlementWriter";
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
 *   - the list returns BOTH anchor kinds, and OMITS a QB row that is tied to a
 *     Stripe payout (matched / proposed / conflict), already grouped, or
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
    req: { appUser?: { id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID };
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
  unitGroups: Db["unitGroups"];
  unitGroupMembers: Db["unitGroupMembers"];
  paymentApplications: Db["paymentApplications"];
  reconciliationBundleDrafts: Db["reconciliationBundleDrafts"];
  settlementLinks: Db["settlementLinks"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

const draftIds: string[] = [];
const payoutIds: string[] = [];
const chargeIds: string[] = [];
const stagedIds: string[] = [];
const unitGroupIds: string[] = [];
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
  status: string;
  matched?: string;
  proposed?: string;
  conflict?: string;
  conflictGift?: string;
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
  // settlement_links is the authoritative payout↔deposit store; the legacy
  // pointer columns are dropped. Express the fixture's intended tie directly as
  // the settlement link the status maps to. FK cascade on payout_id cleans it up.
  const link =
    opts.status === "unmatched"
      ? null
      : opts.status.startsWith("confirmed_")
        ? confirmSettlementLink({
            depositStagedPaymentId: (opts.matched ??
              opts.proposed ??
              opts.conflict)!,
            conflictGiftId: opts.conflictGift ?? null,
            confirmedByUserId: null,
            confirmedAt: new Date(),
          })
        : proposeSettlementLink(
            (opts.proposed ?? opts.conflict)!,
            opts.conflictGift ?? null,
          );
  if (link) {
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
  }
  return id;
}

async function seedCharge(
  payoutId: string,
  opts: {
    matchedGiftId?: string;
    exclusionReason?: string | null;
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

async function seedStaged(opts: {
  group?: string | null;
  exclusionReason?: string | null;
  amount?: string;
  payerName?: string;
  createdGiftId?: string | null;
  matchedGiftId?: string | null;
  fundingSource?: string | null;
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "payment",
    qbEntityId: id,
    qbLineId: "",
    amount: opts.amount ?? "75.00",
    dateReceived: futureDate(),
    payerName: opts.payerName ?? `Zztest Anchor Payer ${RUN}`,
    exclusionReason: (opts.exclusionReason ?? null) as never,
    // A deposit's inferred origin. Clear non-Stripe origins (check/cash/wire/…)
    // are dropped from the "Needs payout tie" anchor column; stripe/donorbox/NULL
    // stay visible.
    fundingSource: (opts.fundingSource ?? null) as never,
  });
  stagedIds.push(id);
  // A booked QB deposit/payment carries the gift it was minted into / matched
  // to via the authoritative `payment_applications` ledger (the deprecated
  // staged link columns are no longer written). A real conflict_approved
  // deposit is always linked (that link is where qbConflictGiftId came from),
  // so tests that confirm-keep must wire it.
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
  // Grouping is now first-class: membership lives in unit_groups /
  // unit_group_members (evidence_source='quickbooks', source_id=staged id), not
  // on staged_payments. A grouped row must be OMITTED from anchor eligibility.
  if (opts.group) {
    await db
      .insert(schema.unitGroups)
      .values({ id: opts.group, createdByUserId: TEST_USER_ID })
      .onConflictDoNothing();
    unitGroupIds.push(opts.group);
    await db.insert(schema.unitGroupMembers).values({
      id: `ugm_${id}`,
      groupId: opts.group,
      evidenceSource: "quickbooks",
      sourceId: id,
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
    unitGroups: dbMod.unitGroups,
    unitGroupMembers: dbMod.unitGroupMembers,
    paymentApplications: dbMod.paymentApplications,
    reconciliationBundleDrafts: dbMod.reconciliationBundleDrafts,
    settlementLinks: dbMod.settlementLinks,
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
  // Release gift→charge/staged final-amount pointers (RESTRICT FK) before deleting
  // the evidence rows; reset source to `human` to keep the source↔pointer XOR.
  if (allGiftIds.length)
    await db
      .update(schema.giftsAndPayments)
      .set({
        finalAmountSource: "human",
        finalAmountStripeChargeId: null,
        finalAmountQbStagedPaymentId: null,
      })
      .where(inArrayFn(schema.giftsAndPayments.id, allGiftIds));
  // Release staged → gift pointers so gifts can be deleted.
  if (stagedIds.length)
    await db
      .update(schema.stagedPayments)
      .set({
        matchedGiftId: null,
        createdGiftId: null,
        groupReconciledGiftId: null,
      })
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
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
  // unit_group_members cascade off unit_groups; delete the groups this run made.
  if (unitGroupIds.length)
    await db
      .delete(schema.unitGroups)
      .where(inArrayFn(schema.unitGroups.id, unitGroupIds));
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
  it("lists both sources in needs_review and omits tied/grouped/non-anchor QB rows", async () => {
    // Eligible anchors (should appear).
    const pEligible = await seedPayout({ status: "unmatched" });
    await seedCharge(pEligible);
    const sStandalone = await seedStaged({});

    // QB rows tied to a payout (via a settlement link) → OMITTED; their payouts
    // are the anchor instead. A `confirmed` (matched/settled) tie omits its staged
    // row too, but the payout itself is settled — not needs_review.
    const sMatched = await seedStaged({});
    const pMatched = await seedPayout({
      status: "confirmed_reconciled",
      matched: sMatched,
    });
    const sProposed = await seedStaged({});
    const pProposed = await seedPayout({
      status: "proposed",
      proposed: sProposed,
    });
    const sConflict = await seedStaged({});
    const pConflict = await seedPayout({
      status: "conflict_approved",
      conflict: sConflict,
    });

    // Already grouped, and derived-excluded rows (incl. processor_payout) → OMITTED.
    const sGrouped = await seedStaged({
      group: `grp_${RUN}`,
    });
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

    // Present (proposed/conflict payout ties + a standalone deposit).
    expect(map.has(`stripe_payout:${pEligible}`)).toBe(true);
    expect(map.has(`qb_staged_payment:${sStandalone}`)).toBe(true);
    expect(map.has(`stripe_payout:${pProposed}`)).toBe(true);
    expect(map.has(`stripe_payout:${pConflict}`)).toBe(true);

    // Present: plausibly-Stripe and unknown-origin standalone deposits.
    expect(map.has(`qb_staged_payment:${sStripeSource}`)).toBe(true);
    expect(map.has(`qb_staged_payment:${sDonorbox}`)).toBe(true);
    expect(map.has(`qb_staged_payment:${sUnknownSource}`)).toBe(true);

    // Omitted. Every staged row tied to a payout drops out (its payout is the
    // anchor). A `confirmed` (settled) payout is not needs_review work either.
    expect(map.has(`stripe_payout:${pMatched}`)).toBe(false);
    expect(map.has(`qb_staged_payment:${sMatched}`)).toBe(false);
    expect(map.has(`qb_staged_payment:${sProposed}`)).toBe(false);
    expect(map.has(`qb_staged_payment:${sConflict}`)).toBe(false);
    expect(map.has(`qb_staged_payment:${sGrouped}`)).toBe(false);
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

  it("emits the proposed counterpart inline on a proposed Stripe payout; QB anchors stay orphan with no proposal", async () => {
    // A proposed payout↔deposit tie. The payout is the anchor (the deposit is
    // omitted); the card must be able to render the proposed match + approve/
    // reject WITHOUT first assembling the full draft, so the anchor row carries
    // the counterpart facts inline.
    const sDep = await seedStaged({
      amount: "80.00",
      payerName: `Zztest Proposed Dep ${RUN}`,
    });
    const pProp = await seedPayout({ status: "proposed", proposed: sDep });
    const sOrphan = await seedStaged({});

    const map = await listAnchors("all");

    const row = map.get(`stripe_payout:${pProp}`);
    expect(row).toBeTruthy();
    expect(row.batchStatus).toBe("proposed");
    expect(row.proposedMatch).toBeTruthy();
    expect(row.proposedMatch.counterpartType).toBe("qb_staged_payment");
    expect(row.proposedMatch.counterpartId).toBe(sDep);
    expect(Number(row.proposedMatch.amount)).toBeCloseTo(80, 2);
    expect(row.proposedMatch.date).toBeTruthy();
    // No draft assembled yet → readiness is a null hint (confirm re-derives).
    expect(row.readiness).toBeNull();

    // The tied deposit is NOT its own anchor (reconciles through the payout).
    expect(map.has(`qb_staged_payment:${sDep}`)).toBe(false);

    // A standalone QB deposit is always an orphan anchor with no proposal — the
    // payout is always the canonical settlement anchor.
    const orphan = map.get(`qb_staged_payment:${sOrphan}`);
    expect(orphan.batchStatus).toBe("orphan");
    expect(orphan.proposedMatch).toBeNull();
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

describe.skipIf(!HAS_DB)("Reject a proposed settlement tie (integration)", () => {
  it("deletes a proposed link (no-op when none), and 409s on a confirmed link", async () => {
    const sDep = await seedStaged({});
    const pProp = await seedPayout({ status: "proposed", proposed: sDep });
    // A pending charge keeps the payout as real work once the tie is dropped.
    await seedCharge(pProp);

    let map = await listAnchors("all");
    expect(map.get(`stripe_payout:${pProp}`).batchStatus).toBe("proposed");

    const rej = await post(
      `/api/reconciliation/settlement-links/${pProp}/reject`,
    );
    expect(rej.status).toBe(200);
    expect(rej.json.rejected).toBe(true);

    // Link gone → payout is an orphan again and the deposit re-surfaces as its
    // own standalone anchor.
    map = await listAnchors("all");
    const after = map.get(`stripe_payout:${pProp}`);
    expect(after.batchStatus).toBe("orphan");
    expect(after.proposedMatch).toBeNull();
    expect(map.has(`qb_staged_payment:${sDep}`)).toBe(true);

    // Idempotent: rejecting with no proposed link is a no-op success.
    const again = await post(
      `/api/reconciliation/settlement-links/${pProp}/reject`,
    );
    expect(again.status).toBe(200);
    expect(again.json.rejected).toBe(false);

    // A CONFIRMED tie is reverted, never rejected here → 409.
    const sConf = await seedStaged({});
    const pConf = await seedPayout({
      status: "confirmed_reconciled",
      matched: sConf,
    });
    const conf = await post(
      `/api/reconciliation/settlement-links/${pConf}/reject`,
    );
    expect(conf.status).toBe(409);
  });
});

describe.skipIf(!HAS_DB)("Payout search resolve target (integration)", () => {
  it("finds an orphan payout by id text + amount band, omitting tied payouts", async () => {
    const pOrphan = await seedPayout({ status: "unmatched" });
    const sTied = await seedStaged({});
    const pTied = await seedPayout({ status: "proposed", proposed: sTied });

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

  it("a conflict-tied QB id also canonicalizes to its payout", async () => {
    const staged = await seedStaged({});
    const payout = await seedPayout({
      status: "conflict_approved",
      conflict: staged,
    });
    await seedCharge(payout);

    const fromQb = await assemble("qb_staged_payment", staged);
    expect(fromQb.json.anchorType).toBe("stripe_payout");
    expect(fromQb.json.anchorId).toBe(payout);
  });

  it("assembling a conflict_approved payout directly surfaces a confirmable conflict tie", async () => {
    // The QB deposit was already approved into a gift (conflict); the canonical
    // anchor is the payout. Assembling it directly must surface the conflict tie
    // as confirm_tie with the conflict deposit id — otherwise a conflict anchor
    // can never be reconciled through the workbench.
    const keptGift = await seedGift();
    const staged = await seedStaged({
      createdGiftId: keptGift,
    });
    const payout = await seedPayout({
      status: "conflict_approved",
      conflict: staged,
      conflictGift: keptGift,
    });
    await seedCharge(payout);

    const a = await assemble("stripe_payout", payout);
    expect(a.json.anchorType).toBe("stripe_payout");
    expect(a.json.anchorId).toBe(payout);
    expect(a.json.tie).toBeTruthy();
    expect(a.json.tie.status).toBe("conflict_approved");
    expect(a.json.tie.action).toBe("confirm_tie");
    expect(a.json.tie.depositStagedPaymentId).toBe(staged);
  });

  it("refuses to derive a standalone QB draft once a payout ties it (proposed)", async () => {
    const staged = await seedStaged({});
    // Assemble standalone FIRST — a pure-QB draft persists.
    const a = await assemble("qb_staged_payment", staged);
    expect(a.json.anchorType).toBe("qb_staged_payment");

    // A Stripe payout now claims the same deposit.
    await seedPayout({ status: "proposed", proposed: staged });

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

  it("refuses to confirm a standalone QB draft once a payout ties it (conflict)", async () => {
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

    // A conflict tie appears AFTER the draft was derived.
    await seedPayout({ status: "conflict_approved", conflict: staged });

    const confirm = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/confirm`,
      { expectedRevision: derived.json.revision, allowWarnings: true },
    );
    trackConfirm(confirm.json);
    expect(confirm.status).toBe(409);
    expect(confirm.json.error).toBe("anchor_superseded");
    // The money was NOT booked as pure-QB.
    expect((await readStaged(staged))?.status).toBe("pending");
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

describe.skipIf(!HAS_DB)("Conflict-approved payout double-book gate", () => {
  it("blocks minting a pending charge on top of a kept conflict gift", async () => {
    const keptGift = await seedGift();
    const deposit = await seedStaged({ createdGiftId: keptGift });
    const payout = await seedPayout({
      status: "conflict_approved",
      conflict: deposit,
      conflictGift: keptGift,
    });
    const charge = await seedCharge(payout);

    // Confirming a conflict_approved payout KEEPS the coarse QB gift as the single
    // source of truth. The default auto-resolution would mint a per-charge gift on
    // top of it (double-book), so the bundle must NOT be ready and the charge row
    // must carry the gate blocker until the reviewer defers/excludes it.
    const a = await assemble("stripe_payout", payout);
    expect(a.json.tie?.status).toBe("conflict_approved");
    expect(a.json.summary?.ready).toBe(false);
    expect(a.json.summary?.blockerCount).toBeGreaterThanOrEqual(1);

    const chargeRow = (a.json.rows ?? []).find((r: any) => r.rowKey === charge);
    expect(chargeRow?.gift?.kind).toBe("mint");
    expect(chargeRow?.ready).toBe(false);
    expect(
      (chargeRow?.warnings ?? []).some(
        (w: any) => w.code === "conflict_keep_no_new_gift" && w.severity === "blocker",
      ),
    ).toBe(true);
  });

  it("lets the reviewer defer the charge to research and confirm the kept tie", async () => {
    const keptGift = await seedGift();
    const deposit = await seedStaged({ createdGiftId: keptGift });
    const payout = await seedPayout({
      status: "conflict_approved",
      conflict: deposit,
      conflictGift: keptGift,
    });
    const charge = await seedCharge(payout);

    const a = await assemble("stripe_payout", payout);
    const derived = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/derive`,
      { rows: [{ rowKey: charge, giftKind: "research" }] },
    );
    expect(derived.status).toBe(200);
    expect(derived.json.summary.ready).toBe(true);
    expect(derived.json.summary.blockerCount).toBe(0);

    const confirm = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/confirm`,
      { expectedRevision: derived.json.revision, allowWarnings: true },
    );
    expect(confirm.status).toBe(200);
    // The kept QB gift is the only gift; the deferred charge mints nothing.
    expect(confirm.json.giftsCreated).toBe(0);
  });

  it("blocks confirming when a charge is already booked into a DIFFERENT gift than the kept QB gift", async () => {
    const keptGift = await seedGift();
    const foreignGift = await seedGift();
    const deposit = await seedStaged({});
    const payout = await seedPayout({
      status: "conflict_approved",
      conflict: deposit,
      conflictGift: keptGift,
    });
    // The charge is already reconciled into a gift that is NOT the kept QB gift —
    // a pre-existing double-book. Confirming the keep must NOT silently bless it.
    const charge = await seedCharge(payout, { matchedGiftId: foreignGift });

    const a = await assemble("stripe_payout", payout);
    expect(a.json.tie?.status).toBe("conflict_approved");
    expect(a.json.summary?.ready).toBe(false);
    expect(a.json.summary?.blockerCount).toBeGreaterThanOrEqual(1);

    const chargeRow = (a.json.rows ?? []).find((r: any) => r.rowKey === charge);
    // Committed rows surface their existing gift link as a reflected match.
    expect(chargeRow?.gift?.giftId).toBe(foreignGift);
    expect(
      (chargeRow?.warnings ?? []).some(
        (w: any) =>
          w.code === "conflict_keep_foreign_gift" && w.severity === "blocker",
      ),
    ).toBe(true);

    // The confirm route must reject the not-ready bundle (no double-book blessed).
    const confirm = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/confirm`,
      { expectedRevision: a.json.revision, allowWarnings: true },
    );
    expect(confirm.status).toBe(409);
  });

  it("allows confirming when the charge is already booked into the SAME kept QB gift", async () => {
    const keptGift = await seedGift();
    const deposit = await seedStaged({ createdGiftId: keptGift });
    const payout = await seedPayout({
      status: "conflict_approved",
      conflict: deposit,
      conflictGift: keptGift,
    });
    // The charge is reconciled into the very gift the keep preserves — the
    // legitimate non-double-booked state, so the bundle stays confirmable.
    const charge = await seedCharge(payout, { matchedGiftId: keptGift });

    const a = await assemble("stripe_payout", payout);
    expect(a.json.tie?.status).toBe("conflict_approved");

    const chargeRow = (a.json.rows ?? []).find((r: any) => r.rowKey === charge);
    // Committed into the kept gift: reflected as a match to that same gift, with
    // no foreign-gift blocker (and ready=true proves it wasn't treated as a mint).
    expect(chargeRow?.gift?.giftId).toBe(keptGift);
    expect(
      (chargeRow?.warnings ?? []).some(
        (w: any) => w.code === "conflict_keep_foreign_gift",
      ),
    ).toBe(false);
    expect(a.json.summary?.ready).toBe(true);
    expect(a.json.summary?.blockerCount).toBe(0);

    const confirm = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/confirm`,
      { expectedRevision: a.json.revision, allowWarnings: true },
    );
    expect(confirm.status).toBe(200);
    // The kept QB gift is the only gift; the already-committed charge mints nothing.
    expect(confirm.json.giftsCreated).toBe(0);
  });

  it("blocks confirming a conflict_approved payout by refusing a per-charge mint on the kept gift", async () => {
    // A well-formed conflict: the QB deposit was already approved into a kept gift,
    // which the keep preserves as the single source of truth. Minting a NEW
    // per-charge gift on top of that kept gift would double-book the same money, so
    // the tie must block any mint/match row (the reviewer defers or excludes it).
    const keptGift = await seedGift();
    const deposit = await seedStaged({
      createdGiftId: keptGift,
    });
    const payout = await seedPayout({
      status: "conflict_approved",
      conflict: deposit,
      conflictGift: keptGift,
    });
    const charge = await seedCharge(payout);

    const a = await assemble("stripe_payout", payout);
    expect(a.json.tie?.status).toBe("conflict_approved");

    const derived = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/derive`,
      {
        rows: [
          {
            rowKey: charge,
            giftKind: "mint",
            donorKind: "existing",
            donorId: ORG_ID,
            donorRecordKind: "organization",
          },
        ],
      },
    );
    expect(derived.status).toBe(200);
    expect(
      (derived.json.rows ?? [])
        .find((r: any) => r.rowKey === charge)
        ?.warnings?.some(
          (w: any) =>
            w.code === "conflict_keep_no_new_gift" && w.severity === "blocker",
        ),
    ).toBe(true);
    expect(derived.json.summary.ready).toBe(false);
    expect(derived.json.summary.blockerCount).toBeGreaterThanOrEqual(1);

    const confirm = await post(
      `/api/reconciliation/bundle-proposals/${a.draftId}/confirm`,
      { expectedRevision: derived.json.revision, allowWarnings: true },
    );
    expect(confirm.status).toBe(409);
  });

  it("degrades a malformed conflict_approved payout with no recorded gift to a plain proposed tie", async () => {
    // The authoritative settlement_links model cannot represent "conflict without a
    // kept gift": conflict_approved is DERIVED as (proposed link AND a non-null
    // conflict gift). A legacy/malformed conflict enum with no recorded gift
    // therefore reads as a plain proposed tie — there is no booked gift to
    // double-book, so a per-charge mint is correct rather than blocked. Prod census
    // for this state is zero; this pins the intentional Phase-4 degrade semantics.
    const deposit = await seedStaged({});
    const payout = await seedPayout({
      status: "conflict_approved",
      conflict: deposit,
    });
    await seedCharge(payout);

    const a = await assemble("stripe_payout", payout);
    expect(a.json.tie?.status).toBe("proposed");
  });
});
