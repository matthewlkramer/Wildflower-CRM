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
  qbCountedRowsForPayment,
  qbDemotedRowsForPayment,
  qbSoleGiftIdForPayment,
  qbMintedGiftIdForPayment,
  qbPaymentIdForGift,
  seedStripeApplication,
  stripeCountedRowForCharge,
  stripeGiftIdForCharge,
  stripeMintedGiftIdForCharge,
} from "./paymentApplicationsTestUtil";
import { chargeStatusSql, stagedStatusSql } from "../lib/derivedStatus";
import { getTableColumns } from "drizzle-orm";
import { deriveGiftQbTieLiveExpr } from "../lib/giftQbTie";
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
    /** Seed a counted QB cash-application ledger row linking this payment to
     * the gift (the SOLE gift-link source — the legacy staged gift-link
     * columns are @deprecated and never written/read). */
    linkedGiftId?: string | null;
    /** Seed a counted ledger row that MINTED the gift (created_the_gift). */
    mintedGiftId?: string | null;
    /** Seed a group-resolution link: counted ledger row + match_confirmed_at
     * (group/split resolutions always carry the confirm stamp, so the row
     * derives match_confirmed even when auto_applied). */
    groupLinkedGiftId?: string | null;
    // Status is DERIVED from facts: no ledger row ⇒ pending; a counted ledger
    // row with autoApplied=true (and no matchConfirmedAt) ⇒ match_proposed; a
    // counted ledger row otherwise ⇒ match_confirmed.
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
    ...(opts.groupLinkedGiftId != null
      ? { matchConfirmedAt: new Date() }
      : {}),
  });
  stagedIds.push(id);
  const ledgerGiftId =
    opts.linkedGiftId ?? opts.mintedGiftId ?? opts.groupLinkedGiftId;
  if (ledgerGiftId != null) {
    await db.insert(schema.paymentApplications).values({
      id: nextId("pa"),
      paymentId: id,
      giftId: ledgerGiftId,
      amountApplied: amount,
      evidenceSource: "quickbooks",
      linkRole: "counted",
      lifecycle: "confirmed",
      matchMethod: opts.autoApplied ? "system" : "human",
      createdTheGift: opts.mintedGiftId != null,
      ...(opts.autoApplied ? {} : { confirmedAt: new Date() }),
    });
  }
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
  // The approve route finds tied payouts through the pairing fact on the QBO
  // row (staged_payments.settled_stripe_payout_id, 0168) — the settlement-link
  // lifecycle is retired. Stamp the pairing directly.
  await db
    .update(schema.stagedPayments)
    .set({ settledStripePayoutId: id })
    .where(eqFn(schema.stagedPayments.id, stagedPaymentId));
  return id;
}

// A charge's gift tie is a counted stripe `payment_applications` ledger row
// (the pointer columns are retired and never written).
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
  });
  if (opts.matchedGiftId) {
    await seedStripeApplication({
      stripeChargeId: id,
      giftId: opts.matchedGiftId,
      amountApplied: opts.grossAmount,
    });
  }
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
    .select({
      ...getTableColumns(schema.giftsAndPayments),
      quickbooksTieStatus: deriveGiftQbTieLiveExpr(),
    })
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
async function readPairedPayoutId(stagedId: string): Promise<string | null> {
  const [row] = await db
    .select({ settledStripePayoutId: schema.stagedPayments.settledStripePayoutId })
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, stagedId));
  return row?.settledStripePayoutId ?? null;
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
  it("links a plain QB row (no payout pairing) to the gift — counted ledger row, row confirmed", async () => {
    const giftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00");

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId,
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    expect((await readStaged(stagedId)).status).toBe("match_confirmed");
    expect(await qbSoleGiftIdForPayment(stagedId)).toBe(giftId);
  }, 30_000);

  it("a payout-paired lump (settled fact, 0168) dead-ends on the link path — money books from the charge card", async () => {
    const giftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00");
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId,
      stripeChargeId: chargeId,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("not_approvable");

    // Nothing mutated: the pairing fact stands, no money was booked.
    expect(await readPairedPayoutId(stagedId)).toBe(payoutId);
    expect((await readCharge(chargeId)).status).toBe("pending");
    expect(await stripeGiftIdForCharge(chargeId)).toBeNull();
    expect(await qbSoleGiftIdForPayment(stagedId)).toBeNull();
  }, 30_000);
});

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
      expect(await qbSoleGiftIdForPayment(incumbentId)).toBe(giftId);
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
      expect(await qbSoleGiftIdForPayment(incumbentId)).toBe(giftId);
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

      // The incumbent is returned to the pending/unmatched queue, fully
      // unlinked — its counted ledger rows are gone.
      const incumbent = await readStaged(incumbentId);
      expect(incumbent.status).toBe("pending");
      expect(await qbCountedRowsForPayment(incumbentId)).toHaveLength(0);
      expect(incumbent.matchConfirmedAt).toBeNull();

      // The new payment now holds the gift as permanent reconciled evidence.
      const staged = await readStaged(stagedId);
      expect(staged.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(stagedId)).toBe(giftId);
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

      // The blocked re-target mutated nothing: the ledger still holds gift A
      // (an unconfirmed auto-match derives match_proposed).
      const after = await readStaged(paymentId);
      expect(await qbSoleGiftIdForPayment(paymentId)).toBe(giftA);
      expect(after.status).toBe("match_proposed");
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
  },
);

describe.skipIf(!HAS_DB)("Reconciliation approve — create gift (integration)", () => {

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
    // QB amount provenance lives on the counted ledger row.
    expect(await qbPaymentIdForGift(newGiftId)).toBe(stagedId);

    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbMintedGiftIdForPayment(stagedId)).toBe(newGiftId);
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
    expect(await qbMintedGiftIdForPayment(stagedId)).toBe(first.json.giftId);
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
      linkedGiftId: giftId,
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

    // The auto-proposed row reconciles cleanly — no 409 not_approvable. §4.3
    // supersede: the charge's counted Stripe row covers the gift, so the QB
    // row lands demoted (corroborating, amount kept).
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbSoleGiftIdForPayment(stagedId)).toBeNull();
    const demoted = await qbDemotedRowsForPayment(stagedId);
    expect(demoted).toHaveLength(1);
    expect(demoted[0].giftId).toBe(giftId);

    const charge = await readCharge(chargeId);
    expect(charge.status).toBe("match_confirmed");
    expect(await stripeGiftIdForCharge(chargeId)).toBe(giftId);
  }, 30_000);

  it("rejects minting a NEW gift on an auto-proposed row that already points at a gift (gift_already_linked, no double-count)", async () => {
    const giftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00", {
      autoApplied: true,
      matchStatus: "matched",
      linkedGiftId: giftId,
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
    expect(await qbSoleGiftIdForPayment(stagedId)).toBe(giftId);
    expect(await qbMintedGiftIdForPayment(stagedId)).toBeNull();
  }, 30_000);

  it("rejects minting a NEW gift on a row already tied to a GROUPED gift (not_approvable, no double-count)", async () => {
    // A group-reconciled link derives match_confirmed (it is not part of the
    // proposed arm), so the status gate blocks the mint before the
    // gift_already_linked guard is even reached.
    const giftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00", {
      autoApplied: true,
      matchStatus: "matched",
      groupLinkedGiftId: giftId,
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
    expect(await qbSoleGiftIdForPayment(stagedId)).toBe(giftId);
    expect(await qbMintedGiftIdForPayment(stagedId)).toBeNull();
  }, 30_000);

  it("re-targeting a confirmed (`match_confirmed`) direct match is guarded: 409 payment_already_applied until moveOwnApplication, then re-points", async () => {
    const giftId = await seedGift("100.00");
    const otherGiftId = await seedGift("100.00");
    const stagedId = await seedStaged("100.00", {
      matchStatus: "matched",
      linkedGiftId: giftId,
    });

    // Without the explicit confirmation the re-target must NOT silently
    // re-point — the confirmed row's counted ledger application to gift A
    // requires the reviewer's explicit moveOwnApplication.
    const blocked = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId: otherGiftId,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe("consistency_gate");
    const issues = (
      blocked.json as {
        details?: { issues?: Array<{ code: string }> };
      }
    ).details?.issues;
    expect(issues?.some((i) => i.code === "payment_already_applied")).toBe(
      true,
    );

    // Untouched.
    let staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbSoleGiftIdForPayment(stagedId)).toBe(giftId);

    // The human-confirmed move re-points the confirmed row onto the new gift.
    const moved = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId: otherGiftId,
      moveOwnApplication: true,
    });
    expect(moved.status).toBe(200);
    expect(moved.json.ok).toBe(true);

    staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbSoleGiftIdForPayment(stagedId)).toBe(otherGiftId);
  }, 30_000);

  it("still dead-ends a settlement-only confirmed row on the link path (not_approvable)", async () => {
    const otherGiftId = await seedGift("100.00");
    // Settlement-only confirm: the row is match_confirmed with NO gift link at
    // all — its status derives solely from a CONFIRMED settlement link.
    const stagedId = await seedStaged("100.00", {
      matchStatus: "matched",
    });
    const payoutId = await seedPayout(stagedId);

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "link_existing_gift",
      giftId: otherGiftId,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("not_approvable");

    // Untouched — no gift link appeared.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbCountedRowsForPayment(stagedId)).toHaveLength(0);
  }, 30_000);

  it("still dead-ends a settlement-only confirmed row on the MINT path when NO charge is selected (not_approvable, guidance message)", async () => {
    const stagedId = await seedStaged("100.00", { matchStatus: "matched" });
    const payoutId = await seedPayout(stagedId);

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("not_approvable");
    expect(res.json.message).toContain("Stripe charge card");

    // Untouched — no gift link appeared.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbCountedRowsForPayment(stagedId)).toHaveLength(0);
  }, 30_000);

  it("charge-anchored escape hatch: records a payment on a pledge from a settlement-only confirmed deposit when a pending charge IS selected (201; charge owns the mint, QB lump untouched)", async () => {
    // A pledge awaiting its (full) payment.
    const oppId = await seedOpp({
      stage: "written_commitment",
      writtenPledge: true,
      awardedAmount: "100.00",
    });
    // Settlement-only confirmed deposit with a still-pending charge on the
    // confirmed payout (the Legrand shape: multi-charge payout confirmed
    // settlement-only, one charge's money not yet booked).
    const stagedId = await seedStaged("100.00", { matchStatus: "matched" });
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift_from_opportunity",
      opportunityId: oppId,
      stripeChargeId: chargeId,
    });
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
    const giftId = res.json.giftId as string;
    expect(giftId).toBeTruthy();
    giftIds.push(giftId);

    // Gift: tied to the pledge, donor derived from the opp, amount = Stripe
    // GROSS; ledger row records the charge link (finalAmountStripeChargeId @deprecated).
    const gift = await readGift(giftId);
    expect(gift.opportunityId).toBe(oppId);
    expect(gift.organizationId).toBe(ORG_ID);
    expect(gift.amount).toBe("100.00");
    expect(await stripeGiftIdForCharge(chargeId)).toBe(giftId);

    // The CHARGE owns the mint (a counted ledger row with created_the_gift,
    // protected) and is resolved.
    const charge = await readCharge(chargeId);
    expect(await stripeMintedGiftIdForCharge(chargeId)).toBe(giftId);
    expect(charge.status).toBe("match_confirmed");

    // The QB lump stays untouched: settlement-only confirmed, NO gift link.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbCountedRowsForPayment(stagedId)).toHaveLength(0);

    // Fully-paid pledge derives cash_in post-commit (invariant #3).
    const opp = await readOpp(oppId);
    expect(opp.status).toBe("cash_in");
  }, 30_000);

  it("charge-anchored escape hatch rejects a charge from a DIFFERENT payout (stripe_charge_wrong_payout, nothing mutated)", async () => {
    const stagedId = await seedStaged("100.00", { matchStatus: "matched" });
    const payoutId = await seedPayout(stagedId);
    // A pending charge that belongs to some OTHER deposit's payout.
    const otherPayoutId = await seedPayout(await seedStaged("100.00"));
    const foreignChargeId = await seedCharge({
      payoutId: otherPayoutId,
      grossAmount: "100.00",
    });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
      stripeChargeId: foreignChargeId,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("stripe_charge_wrong_payout");

    // Nothing mutated on either side.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbCountedRowsForPayment(stagedId)).toHaveLength(0);
    const charge = await readCharge(foreignChargeId);
    expect(charge.status).toBe("pending");
  }, 30_000);

  it("charge-anchored escape hatch does NOT open for a SPLIT-resolved row (counted ledger rows, no gift links) — 409, no mint", async () => {
    // A split-resolved deposit also derives match_confirmed with all three
    // gift-link columns NULL — but its money is ALREADY booked through counted
    // payment_applications rows. The hatch must stay closed (a mint here would
    // double-count), even when a pending charge sits on a merely-PROPOSED
    // settlement link for the same deposit.
    const splitGift = await seedGift("100.00");
    const stagedId = await seedStaged("100.00", { matchStatus: "matched" });
    // Proposed (NOT confirmed) settlement link + a pending charge on its payout.
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });
    // The split's counted cash-application ledger row books the money.
    await db.insert(schema.paymentApplications).values({
      id: nextId("pa"),
      paymentId: stagedId,
      giftId: splitGift,
      amountApplied: "100.00",
      evidenceSource: "quickbooks",
      matchMethod: "human",
      linkRole: "counted",
      lifecycle: "confirmed",
    });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
      stripeChargeId: chargeId,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("not_approvable");

    // Nothing minted: staged stays split-resolved (its counted ledger rows
    // are the split bookings, no mint appeared); the charge stays pending.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    const charge = await readCharge(chargeId);
    expect(charge.status).toBe("pending");
  }, 30_000);

  it("still dead-ends a settlement-only confirmed row on the MINT path when NO charge is selected (not_approvable, guidance message)", async () => {
    const stagedId = await seedStaged("100.00", { matchStatus: "matched" });
    const payoutId = await seedPayout(stagedId);

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("not_approvable");
    expect(res.json.message).toContain("Stripe charge card");

    // Untouched — no gift link appeared.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbCountedRowsForPayment(stagedId)).toHaveLength(0);
  }, 30_000);

  it("charge-anchored escape hatch: records a payment on a pledge from a settlement-only confirmed deposit when a pending charge IS selected (201; charge owns the mint, QB lump untouched)", async () => {
    // A pledge awaiting its (full) payment.
    const oppId = await seedOpp({
      stage: "written_commitment",
      writtenPledge: true,
      awardedAmount: "100.00",
    });
    // Settlement-only confirmed deposit with a still-pending charge on the
    // confirmed payout (the Legrand shape: multi-charge payout confirmed
    // settlement-only, one charge's money not yet booked).
    const stagedId = await seedStaged("100.00", { matchStatus: "matched" });
    const payoutId = await seedPayout(stagedId);
    const chargeId = await seedCharge({ payoutId, grossAmount: "100.00" });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift_from_opportunity",
      opportunityId: oppId,
      stripeChargeId: chargeId,
    });
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
    const giftId = res.json.giftId as string;
    expect(giftId).toBeTruthy();
    giftIds.push(giftId);

    // Gift: tied to the pledge, donor derived from the opp, amount = Stripe
    // GROSS; ledger row records the charge link (finalAmountStripeChargeId @deprecated).
    const gift = await readGift(giftId);
    expect(gift.opportunityId).toBe(oppId);
    expect(gift.organizationId).toBe(ORG_ID);
    expect(gift.amount).toBe("100.00");
    expect(await stripeGiftIdForCharge(chargeId)).toBe(giftId);

    // The CHARGE owns the mint (a counted ledger row with created_the_gift,
    // protected) and is resolved.
    const charge = await readCharge(chargeId);
    expect(await stripeMintedGiftIdForCharge(chargeId)).toBe(giftId);
    expect(charge.status).toBe("match_confirmed");

    // The QB lump stays untouched: settlement-only confirmed, NO gift link.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbCountedRowsForPayment(stagedId)).toHaveLength(0);

    // Fully-paid pledge derives cash_in post-commit (invariant #3).
    const opp = await readOpp(oppId);
    expect(opp.status).toBe("cash_in");
  }, 30_000);

  it("charge-anchored escape hatch rejects a charge from a DIFFERENT payout (stripe_charge_wrong_payout, nothing mutated)", async () => {
    const stagedId = await seedStaged("100.00", { matchStatus: "matched" });
    const payoutId = await seedPayout(stagedId);
    // A pending charge that belongs to some OTHER deposit's payout.
    const otherPayoutId = await seedPayout(await seedStaged("100.00"));
    const foreignChargeId = await seedCharge({
      payoutId: otherPayoutId,
      grossAmount: "100.00",
    });

    const res = await api(`/api/reconciliation/cards/${stagedId}/approve`, {
      outcome: "create_gift",
      organizationId: ORG_ID,
      stripeChargeId: foreignChargeId,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("stripe_charge_wrong_payout");

    // Nothing mutated on either side.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbCountedRowsForPayment(stagedId)).toHaveLength(0);
    const charge = await readCharge(foreignChargeId);
    expect(charge.status).toBe("pending");
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
    // QB amount provenance lives on the counted ledger row.
    expect(await qbPaymentIdForGift(giftId)).toBe(stagedId);

    // The QB anchor owns the mint.
    const staged = await readStaged(stagedId);
    expect(staged.status).toBe("match_confirmed");
    expect(await qbMintedGiftIdForPayment(stagedId)).toBe(giftId);

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
    // Distinctive amount: this file seeds/mints 100+ gifts at exactly 100.00
    // for the same per-run org, and the search orders by ABS(amount - anchor)
    // with arbitrary tie order — at the default limit=25 the seeded gift can
    // nondeterministically fall out of the page. A unique amount makes the
    // two seeded gifts the only distance-0 candidates (deterministic top-2).
    const activeGiftId = await seedGift("103.17");
    const archivedGiftId = await seedArchivedGift("103.17");
    const stagedId = await seedStaged("103.17");

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
      linkedGiftId: doneGiftId,
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
      expect(await qbSoleGiftIdForPayment(stagedId)).toBe(giftId);
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
