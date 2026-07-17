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
import { seedStripeApplication } from "./paymentApplicationsTestUtil";

/**
 * DB-backed coverage for GET /api/reconciliation/workbench-clusters — the ONE
 * unified cluster list behind the read-only reconciliation workbench.
 *
 * The money-safety contract under test:
 *   - the universe partitions into exactly three kinds, and a QB row that
 *     reconciles THROUGH a payout cluster (settlement-linked deposit, fee row,
 *     charge-tie row) NEVER appears as its own qb_standalone cluster,
 *   - a unit-group's representative carries the whole group (members hidden),
 *   - a gift with a counted QB/Stripe ledger row is NOT crm_only (but a
 *     Donorbox-only gift IS, flagged with the donorbox badge),
 *   - lens flags/counts (open, refunds, conflicts, excluded, completed) match
 *     the same derived-status precedence the queue pages use,
 *   - search narrows all three halves without crashing any of them.
 *
 * Same seam as the sibling bundle-anchor suite: only `requireAuth` is mocked;
 * the SQL is real production code. Skips without a real DATABASE_URL. Seeds use
 * far-FUTURE dates so they sort to the top of the date-desc list.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `wb_clusters_user_${Date.now()}`,
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

const RUN = `wbcluster_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ORG_NAME = `Workbench Cluster Test Org ${RUN}`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  people: Db["people"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  stagedPayments: Db["stagedPayments"];
  unitGroups: Db["unitGroups"];
  unitGroupMembers: Db["unitGroupMembers"];
  paymentApplications: Db["paymentApplications"];
  settlementLinks: Db["settlementLinks"];
  donorboxDonations: Db["donorboxDonations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

const payoutIds: string[] = [];
const chargeIds: string[] = [];
const stagedIds: string[] = [];
const unitGroupIds: string[] = [];
const giftIds: string[] = [];
const donorboxIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;
const futureDate = () => `2099-11-${String((seq % 27) + 1).padStart(2, "0")}`;

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

async function listClusters(
  lens: string,
  q?: string,
): Promise<{ map: Map<string, any>; json: any }> {
  const qs = new URLSearchParams({ lens, limit: "500" });
  if (q) qs.set("q", q);
  const { status, json } = await getJson(
    `/api/reconciliation/workbench-clusters?${qs.toString()}`,
  );
  expect(status).toBe(200);
  const map = new Map<string, any>();
  for (const r of json.data as any[]) map.set(r.id, r);
  return { map, json };
}

async function seedGift(opts: { amount?: string } = {}): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    organizationId: ORG_ID,
    ownerUserId: TEST_USER_ID,
    amount: opts.amount ?? "75.00",
    dateReceived: futureDate(),
  });
  giftIds.push(id);
  return id;
}

/** A gift that satisfies giftComplete via the coding_form path (no alloc/grant-letter needed). */
async function seedCompleteGift(opts: { amount?: string } = {}): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    organizationId: ORG_ID,
    ownerUserId: TEST_USER_ID,
    amount: opts.amount ?? "75.00",
    dateReceived: futureDate(),
    codingFormMemo: "complete-for-test",
  });
  giftIds.push(id);
  return id;
}

async function seedPayout(
  opts: {
    settledDeposit?: string;
    proposedDeposit?: string;
    conflictGiftId?: string;
    /** Bank-arrival amount; defaults to 100.00 (≠ netTotal ⇒ a settlement gap). */
    amount?: string;
    netTotal?: string | null;
  } = {},
): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: opts.amount ?? "100.00",
    netTotal: opts.netTotal === undefined ? "96.80" : opts.netTotal,
    grossTotal: "100.00",
    feeTotal: "3.20",
    arrivalDate: futureDate(),
    chargeCount: 1,
  });
  payoutIds.push(id);
  const link = opts.settledDeposit
    ? confirmSettlementLink({
        depositStagedPaymentId: opts.settledDeposit,
        conflictGiftId: null,
        confirmedByUserId: null,
        confirmedAt: new Date(),
      })
    : opts.proposedDeposit
      ? proposeSettlementLink(opts.proposedDeposit, opts.conflictGiftId ?? null)
      : null;
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
    linkedQbStagedPaymentId?: string | null;
    linkedFeeQbStagedPaymentId?: string | null;
    refundProposed?: boolean;
    payerName?: string;
    grossAmount?: string;
    /** Set an identified donor FK on the charge (simulates the Identify action). */
    organizationId?: string;
  } = {},
): Promise<string> {
  const id = nextId("ch");
  const gross = opts.grossAmount ?? "100.00";
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: payoutId,
    grossAmount: gross,
    feeAmount: "3.20",
    netAmount: "96.80",
    dateReceived: futureDate(),
    payerName: opts.payerName ?? `Zztest Cluster Charge ${RUN}`,
    payerEmail: `${RUN}-charge@example.invalid`,
    exclusionReason: (opts.exclusionReason ?? null) as never,
    linkedQbStagedPaymentId: opts.linkedQbStagedPaymentId ?? null,
    linkedFeeQbStagedPaymentId: opts.linkedFeeQbStagedPaymentId ?? null,
    refundPropagationStatus: (opts.refundProposed ? "proposed" : "none") as never,
    refundPropagationKind: (opts.refundProposed ? "full_refund" : null) as never,
    organizationId: opts.organizationId ?? null,
  });
  if (opts.matchedGiftId) {
    await seedStripeApplication({
      stripeChargeId: id,
      giftId: opts.matchedGiftId,
      amountApplied: gross,
    });
  }
  chargeIds.push(id);
  return id;
}

/**
 * Seed a counted QB payment_application against a deposit staged_payment.
 * Simulates a deposit-grain gift booking (coarse §4.3 link).
 */
async function seedDepositApplication(opts: {
  depositId: string;
  giftId: string;
  amountApplied: string;
}): Promise<string> {
  const id = nextId("pa");
  await db.insert(schema.paymentApplications).values({
    id,
    paymentId: opts.depositId,
    giftId: opts.giftId,
    amountApplied: opts.amountApplied,
    evidenceSource: "quickbooks",
    matchMethod: "system",
    createdTheGift: false,
  });
  return id;
}

async function seedStaged(
  opts: {
    group?: string | null;
    exclusionReason?: string | null;
    amount?: string;
    payerName?: string;
    matchedGiftId?: string | null;
    autoApplied?: boolean;
    entityType?: "payment" | "deposit";
    /** Wildflower entity attribution (e.g. a fiscally sponsored entity id). */
    entityId?: string | null;
    /** Deposit-line identity: share qbEntityId across lines of one deposit. */
    qbEntityId?: string;
    qbLineId?: string;
    /** QB line coding — drives the "QB says donation" marker check. */
    lineAccountNames?: string[];
    lineItemNames?: string[];
  } = {},
): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: opts.entityType ?? "payment",
    qbEntityId: opts.qbEntityId ?? id,
    qbLineId: opts.qbLineId ?? "",
    amount: opts.amount ?? "75.00",
    dateReceived: futureDate(),
    payerName: opts.payerName ?? `Zztest Cluster Payer ${RUN}`,
    exclusionReason: (opts.exclusionReason ?? null) as never,
    autoApplied: opts.autoApplied ?? false,
    entityId: opts.entityId ?? null,
    lineAccountNames: opts.lineAccountNames ?? null,
    lineItemNames: opts.lineItemNames ?? null,
  });
  stagedIds.push(id);
  if (opts.matchedGiftId) {
    await db.insert(schema.paymentApplications).values({
      id: nextId("pa"),
      paymentId: id,
      giftId: opts.matchedGiftId,
      amountApplied: opts.amount ?? "75.00",
      evidenceSource: "quickbooks",
      matchMethod: "system",
      createdTheGift: false,
    });
  }
  if (opts.group) {
    await db
      .insert(schema.unitGroups)
      .values({ id: opts.group, createdByUserId: TEST_USER_ID })
      .onConflictDoNothing();
    if (!unitGroupIds.includes(opts.group)) unitGroupIds.push(opts.group);
    await db.insert(schema.unitGroupMembers).values({
      id: `ugm_${id}`,
      groupId: opts.group,
      evidenceSource: "quickbooks",
      sourceId: id,
    });
  }
  return id;
}

async function seedDonorboxApplication(giftId: string): Promise<void> {
  const donationId = nextId("dbx");
  await db.insert(schema.donorboxDonations).values({
    id: donationId,
    donationType: "stripe",
    amount: "75.00",
  });
  donorboxIds.push(donationId);
  await db.insert(schema.paymentApplications).values({
    id: nextId("pa"),
    donorboxDonationId: donationId,
    giftId,
    amountApplied: "75.00",
    evidenceSource: "donorbox",
    matchMethod: "system",
    createdTheGift: false,
  });
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
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    stagedPayments: dbMod.stagedPayments,
    unitGroups: dbMod.unitGroups,
    unitGroupMembers: dbMod.unitGroupMembers,
    paymentApplications: dbMod.paymentApplications,
    settlementLinks: dbMod.settlementLinks,
    donorboxDonations: dbMod.donorboxDonations,
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
    name: ORG_NAME,
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

  if (giftIds.length) {
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
    await db
      .delete(schema.paymentApplications)
      .where(inArrayFn(schema.paymentApplications.giftId, giftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  if (unitGroupIds.length)
    await db
      .delete(schema.unitGroups)
      .where(inArrayFn(schema.unitGroups.id, unitGroupIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (donorboxIds.length)
    await db
      .delete(schema.donorboxDonations)
      .where(inArrayFn(schema.donorboxDonations.id, donorboxIds));
  await db
    .delete(schema.people)
    .where(eqFn(schema.people.ownerUserId, TEST_USER_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.ownerUserId, TEST_USER_ID));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[workbench-clusters] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("Workbench cluster list (integration)", () => {
  it("partitions into three kinds and hides through-cluster QB rows", async () => {
    // crm_only: an on-books gift with no counted QB/Stripe ledger row.
    const gCrm = await seedGift();
    // NOT crm_only: matched to a QB row (that row becomes a completed cluster).
    const gQb = await seedCompleteGift();
    const sQb = await seedStaged({ matchedGiftId: gQb });
    // Open payout with an unmatched charge + fee/tie QB rows hanging off it.
    const sFee = await seedStaged({ exclusionReason: "other" });
    const sTie = await seedStaged({});
    const pOpen = await seedPayout();
    await seedCharge(pOpen, {});
    await seedCharge(pOpen, {
      linkedQbStagedPaymentId: sTie,
      linkedFeeQbStagedPaymentId: sFee,
    });
    // Fully settled payout: confirmed settlement link + confirmed charge.
    const sDep = await seedStaged({ entityType: "deposit" });
    const gCharge = await seedCompleteGift();
    const pSettled = await seedPayout({ settledDeposit: sDep });
    await seedCharge(pSettled, { matchedGiftId: gCharge });

    const { map: open } = await listClusters("all_open");
    const { map: completed } = await listClusters("completed");

    // Open payout cluster: needs gift work AND has no settled deposit.
    const openPayout = open.get(`stripe_payout:${pOpen}`);
    expect(openPayout).toBeTruthy();
    expect(openPayout.lenses).toContain("needs_donor_or_gift");
    expect(openPayout.lenses).toContain("needs_accounting");
    expect(openPayout.status).toBe("unresolved");
    expect(openPayout.charges.length).toBe(2);
    const roles = openPayout.qbRecords.map((r: any) => r.role).sort();
    expect(roles).toEqual(["charge_tie", "fee"]);
    expect(
      openPayout.qbRecords.map((r: any) => r.stagedPaymentId).sort(),
    ).toEqual([sFee, sTie].sort());

    // Standalone QB rows that reconcile THROUGH a payout never appear alone.
    for (const hidden of [sDep, sFee, sTie]) {
      expect(open.has(`qb_standalone:${hidden}`)).toBe(false);
      expect(completed.has(`qb_standalone:${hidden}`)).toBe(false);
    }

    // crm_only: present, unlinked, needs accounting; QB-matched gift is not.
    const crm = open.get(`crm_only:${gCrm}`);
    expect(crm).toBeTruthy();
    expect(crm.status).toBe("unlinked");
    expect(crm.lenses).toContain("needs_accounting");
    expect(crm.gifts[0]?.donorName).toBe(ORG_NAME);
    expect(open.has(`crm_only:${gQb}`)).toBe(false);
    expect(completed.has(`crm_only:${gQb}`)).toBe(false);

    // The matched QB row is a COMPLETED cluster carrying its gift.
    const done = completed.get(`qb_standalone:${sQb}`);
    expect(done).toBeTruthy();
    expect(done.status).toBe("complete");
    expect(done.gifts.map((g: any) => g.giftId)).toEqual([gQb]);
    expect(done.gifts[0].linkedStagedPaymentIds).toEqual([sQb]);
    expect(open.has(`qb_standalone:${sQb}`)).toBe(false);

    // The settled payout is completed, with the deposit as a QB record.
    const settled = completed.get(`stripe_payout:${pSettled}`);
    expect(settled).toBeTruthy();
    expect(settled.status).toBe("complete");
    expect(settled.settlement?.lifecycle).toBe("confirmed");
    expect(settled.settlement?.depositStagedPaymentId).toBe(sDep);
    expect(
      settled.qbRecords.some(
        (r: any) => r.role === "deposit" && r.stagedPaymentId === sDep,
      ),
    ).toBe(true);
    expect(settled.gifts.map((g: any) => g.giftId)).toEqual([gCharge]);
    expect(open.has(`stripe_payout:${pSettled}`)).toBe(false);
  });

  it("a unit-group representative carries the whole group", async () => {
    const grp = `grp_${RUN}`;
    const gGroup = await seedGift();
    const m1 = await seedStaged({ group: grp, amount: "40.00" });
    const m2 = await seedStaged({
      group: grp,
      amount: "35.00",
      matchedGiftId: gGroup,
    });

    const { map: open } = await listClusters("all_open");
    const rep = open.get(`qb_standalone:${m1}`);
    expect(rep).toBeTruthy();
    expect(open.has(`qb_standalone:${m2}`)).toBe(false);
    expect(rep.group?.memberCount).toBe(2);
    expect(rep.group?.totalAmount).toBe("75.00");
    expect(rep.qbRecords.length).toBe(2);
    const memberRec = rep.qbRecords.find((r: any) => r.role === "group_member");
    expect(memberRec?.stagedPaymentId).toBe(m2);
    expect(memberRec?.status).toBe("match_confirmed");
    // The member's gift shows on the representative cluster.
    const gift = rep.gifts.find((g: any) => g.giftId === gGroup);
    expect(gift).toBeTruthy();
    expect(gift.linkedStagedPaymentIds).toEqual([m2]);
    // Still open: the representative itself is unmatched.
    expect(rep.lenses).toContain("needs_donor_or_gift");
    expect(rep.status).toBe("partial");
  });

  it("flags refunds, conflicts and excluded rows into their lenses", async () => {
    const pRefund = await seedPayout();
    await seedCharge(pRefund, { refundProposed: true });
    const sDep = await seedStaged({ entityType: "deposit" });
    const gConf = await seedGift();
    const pConflict = await seedPayout({
      proposedDeposit: sDep,
      conflictGiftId: gConf,
    });
    await seedCharge(pConflict, {});
    const sExcluded = await seedStaged({ exclusionReason: "other" });

    const [{ map: refunds }, { map: conflicts }, { map: excluded, json }, { map: open }] =
      await Promise.all([
        listClusters("refunds"),
        listClusters("conflicts"),
        listClusters("excluded"),
        listClusters("all_open"),
      ]);

    const r = refunds.get(`stripe_payout:${pRefund}`);
    expect(r).toBeTruthy();
    expect(r.status).toBe("refund");
    expect(r.charges.some((c: any) => c.refundProposed)).toBe(true);

    const c = conflicts.get(`stripe_payout:${pConflict}`);
    expect(c).toBeTruthy();
    expect(c.status).toBe("conflict");
    expect(c.settlement?.lifecycle).toBe("proposed");
    expect(c.settlement?.conflictGiftId).toBe(gConf);

    const x = excluded.get(`qb_standalone:${sExcluded}`);
    expect(x).toBeTruthy();
    expect(x.status).toBe("excluded");
    expect(open.has(`qb_standalone:${sExcluded}`)).toBe(false);

    // Counts + pagination agree with the lens the page was fetched under.
    expect(json.lensCounts.excluded).toBeGreaterThanOrEqual(1);
    expect(json.pagination.total).toBe(json.lensCounts.excluded);
  }, 60_000);

  it("an auto-applied unconfirmed match keeps the cluster open", async () => {
    const gMp = await seedGift();
    const sMp = await seedStaged({ matchedGiftId: gMp, autoApplied: true });

    const { map } = await listClusters("needs_donor_or_gift");
    const row = map.get(`qb_standalone:${sMp}`);
    expect(row).toBeTruthy();
    expect(row.status).toBe("unresolved");
    expect(row.qbRecords[0]?.status).toBe("match_proposed");
    const { map: completed } = await listClusters("completed");
    expect(completed.has(`qb_standalone:${sMp}`)).toBe(false);
  });

  it("a Donorbox-only gift stays crm_only with the badge", async () => {
    const gDbx = await seedGift();
    await seedDonorboxApplication(gDbx);

    const { map } = await listClusters("needs_accounting");
    const row = map.get(`crm_only:${gDbx}`);
    expect(row).toBeTruthy();
    expect(row.gifts[0]?.donorbox).toBe(true);
    expect(row.status).toBe("unlinked");
  });

  it("folds processor fee lines into their donation line's cluster", async () => {
    // Interleaved deposit (the dominant prod pattern): donation, its fee,
    // another donation, its fee — 1→2, 3→4.
    const depA = nextId("depA");
    const dA1 = await seedStaged({
      entityType: "deposit", qbEntityId: depA, qbLineId: "1", amount: "100.00",
    });
    const fA1 = await seedStaged({
      entityType: "deposit", qbEntityId: depA, qbLineId: "2", amount: "-5.00",
    });
    const dA2 = await seedStaged({
      entityType: "deposit", qbEntityId: depA, qbLineId: "3", amount: "50.00",
    });
    const fA2 = await seedStaged({
      entityType: "deposit", qbEntityId: depA, qbLineId: "4", amount: "-2.00",
    });

    const { map: open } = await listClusters("all_open");

    // Fee lines never anchor their own cluster, in ANY lens.
    for (const lens of ["all_open", "needs_donor_or_gift", "excluded", "completed"]) {
      const { map } = await listClusters(lens);
      expect(map.has(`qb_standalone:${fA1}`)).toBe(false);
      expect(map.has(`qb_standalone:${fA2}`)).toBe(false);
    }

    // Each donation line carries ITS fee: gross − fee = net, per line.
    const c1 = open.get(`qb_standalone:${dA1}`);
    expect(c1).toBeTruthy();
    const fees1 = c1.qbRecords.filter((r: any) => r.role === "fee");
    expect(fees1.map((r: any) => r.stagedPaymentId)).toEqual([fA1]);
    expect(c1.grossTotal).toBe("100.00");
    expect(c1.feeTotal).toBe("5.00");
    expect(c1.netTotal).toBe("95.00");
    // The folded fee is plumbing — it must not inflate the progress counts.
    expect(c1.totalCount).toBe(1);

    const c2 = open.get(`qb_standalone:${dA2}`);
    expect(c2).toBeTruthy();
    expect(c2.qbRecords.filter((r: any) => r.role === "fee")
      .map((r: any) => r.stagedPaymentId)).toEqual([fA2]);
    expect(c2.netTotal).toBe("48.00");
  });

  it("attaches a trailing lump fee to the nearest preceding donation line", async () => {
    const depB = nextId("depB");
    const dB1 = await seedStaged({
      entityType: "deposit", qbEntityId: depB, qbLineId: "1", amount: "25.00",
    });
    const dB2 = await seedStaged({
      entityType: "deposit", qbEntityId: depB, qbLineId: "2", amount: "75.00",
    });
    const fB = await seedStaged({
      entityType: "deposit", qbEntityId: depB, qbLineId: "3", amount: "-13.00",
    });

    const { map: open } = await listClusters("all_open");
    expect(open.has(`qb_standalone:${fB}`)).toBe(false);

    // Lump fee lands on the LAST preceding donation line, not the first.
    const c1 = open.get(`qb_standalone:${dB1}`);
    expect(c1).toBeTruthy();
    expect(c1.qbRecords.some((r: any) => r.role === "fee")).toBe(false);
    expect(c1.grossTotal).toBeNull();
    expect(c1.netTotal).toBe("25.00");

    const c2 = open.get(`qb_standalone:${dB2}`);
    expect(c2).toBeTruthy();
    expect(c2.qbRecords.filter((r: any) => r.role === "fee")
      .map((r: any) => r.stagedPaymentId)).toEqual([fB]);
    expect(c2.netTotal).toBe("62.00");
  });

  it("keeps an orphaned negative line (no positive sibling) visible", async () => {
    const depC = nextId("depC");
    const orphan = await seedStaged({
      entityType: "deposit", qbEntityId: depC, qbLineId: "1", amount: "-49.00",
    });
    const { map: open } = await listClusters("all_open");
    const row = open.get(`qb_standalone:${orphan}`);
    expect(row).toBeTruthy();
    expect(row.qbRecords.filter((r: any) => r.role === "fee")).toEqual([]);
  });

  it("parks fiscally-sponsored money without a gift OUT of the cluster list", async () => {
    // Pending + parked entity + no gift → reconciles in its own worklist,
    // not here (mirrors the queue workbench split).
    const sParked = await seedStaged({ entityId: "embracing_equity" });
    // Same entity WITH a gift link → normal money, reconciles here.
    const gSponsored = await seedCompleteGift();
    const sSponsoredDone = await seedStaged({
      entityId: "embracing_equity",
      matchedGiftId: gSponsored,
    });

    for (const lens of ["all_open", "needs_donor_or_gift", "excluded", "completed"]) {
      const { map } = await listClusters(lens);
      expect(map.has(`qb_standalone:${sParked}`)).toBe(false);
    }
    const { map: completed } = await listClusters("completed");
    expect(completed.has(`qb_standalone:${sSponsoredDone}`)).toBe(true);
  });

  it("flags payouts whose net disagrees with the bank amount as settlement gaps", async () => {
    // Default seed: amount 100.00 vs netTotal 96.80 ⇒ a gap by construction.
    const pGap = await seedPayout();
    await seedCharge(pGap, {});
    // Net matches the bank arrival exactly ⇒ no gap.
    const pClean = await seedPayout({ amount: "96.80" });
    await seedCharge(pClean, {});
    // No net reported at all ⇒ no gap computable ⇒ not flagged (mirrors gapOf).
    const pNoNet = await seedPayout({ netTotal: null });
    await seedCharge(pNoNet, {});

    const { map: gaps, json } = await listClusters("settlement_gaps");
    const g = gaps.get(`stripe_payout:${pGap}`);
    expect(g).toBeTruthy();
    expect(g.lenses).toContain("settlement_gaps");
    expect(g.gapAmount).toBe("-3.20");
    expect(gaps.has(`stripe_payout:${pClean}`)).toBe(false);
    expect(gaps.has(`stripe_payout:${pNoNet}`)).toBe(false);
    expect(json.pagination.total).toBe(json.lensCounts.settlement_gaps);

    // QB and CRM clusters never carry the gap lens.
    for (const row of gaps.values()) expect(row.kind).toBe("stripe_payout");
  });

  it("surfaces excluded QB rows whose coding says donation", async () => {
    // Excluded but coded to a 4000-series donation account → flagged.
    const sByAccount = await seedStaged({
      exclusionReason: "other",
      lineAccountNames: ["4000 Unrestricted Donations"],
    });
    // Excluded with a Donation item name → flagged.
    const sByItem = await seedStaged({
      exclusionReason: "other",
      lineItemNames: ["Donation - General Fund"],
    });
    // Excluded with non-donation coding → excluded only.
    const sPlain = await seedStaged({
      exclusionReason: "other",
      lineAccountNames: ["4020 Services - Earned Income"],
    });
    // NOT excluded, donation-coded → open work, never in this lens.
    const sOpen = await seedStaged({
      lineAccountNames: ["4000 Unrestricted Donations"],
    });

    const { map: says, json } = await listClusters("excluded_qb_says_donation");
    const a = says.get(`qb_standalone:${sByAccount}`);
    expect(a).toBeTruthy();
    expect(a.lenses).toContain("excluded_qb_says_donation");
    expect(a.lenses).toContain("excluded"); // still excluded — the lens is a subset
    expect(says.has(`qb_standalone:${sByItem}`)).toBe(true);
    expect(says.has(`qb_standalone:${sPlain}`)).toBe(false);
    expect(says.has(`qb_standalone:${sOpen}`)).toBe(false);
    expect(json.lensCounts.excluded_qb_says_donation).toBeGreaterThanOrEqual(2);
    expect(json.pagination.total).toBe(json.lensCounts.excluded_qb_says_donation);

    // The subset relationship holds in counts too.
    expect(json.lensCounts.excluded).toBeGreaterThanOrEqual(
      json.lensCounts.excluded_qb_says_donation,
    );
  });

  it("search narrows all three halves", async () => {
    const needle = `Xyzzy${RUN.slice(-6)}`;
    const sNeedle = await seedStaged({ payerName: `Needle ${needle} Payer` });
    const pOther = await seedPayout();
    await seedCharge(pOther, { payerName: `Unrelated Charge Payer ${RUN}` });

    const { map } = await listClusters("all_open", needle);
    expect(map.has(`qb_standalone:${sNeedle}`)).toBe(true);
    expect(map.has(`stripe_payout:${pOther}`)).toBe(false);

    // A charge-payer search surfaces the whole payout cluster.
    const { map: byCharge } = await listClusters("all_open", "Unrelated Charge Payer");
    expect(byCharge.has(`stripe_payout:${pOther}`)).toBe(true);
  });

  describe("per-charge attributedDonor and cluster coverage object", () => {
    it("each charge carries its own attributedDonor; no cluster-level candidateDonor", async () => {
      const payout = await seedPayout();
      const chWithDonor = await seedCharge(payout, { organizationId: ORG_ID });
      const chNoDonor = await seedCharge(payout, {});

      const { map } = await listClusters("all_open");
      const row = map.get(`stripe_payout:${payout}`);
      expect(row).toBeTruthy();

      // No cluster-level candidateDonor.
      expect(row.candidateDonor).toBeUndefined();

      // The identified charge shows attributedDonor with the org.
      const identified = row.charges.find((c: any) => c.chargeId === chWithDonor);
      expect(identified).toBeTruthy();
      expect(identified.attributedDonor).toBeTruthy();
      expect(identified.attributedDonor.donorKind).toBe("organization");
      expect(identified.attributedDonor.donorId).toBe(ORG_ID);
      expect(identified.attributedDonor.donorName).toBe(ORG_NAME);

      // The unidentified charge has null attributedDonor.
      const unidentified = row.charges.find((c: any) => c.chargeId === chNoDonor);
      expect(unidentified).toBeTruthy();
      expect(unidentified.attributedDonor).toBeNull();
    });

    it("donorPurpose grain=none when no counted PAs exist", async () => {
      const payout = await seedPayout();
      await seedCharge(payout, {});

      const { map } = await listClusters("all_open");
      const row = map.get(`stripe_payout:${payout}`);
      expect(row).toBeTruthy();
      expect(row.coverage).toBeTruthy();
      expect(row.coverage.donorPurpose.crmLinkage.grain).toBe("none");
      expect(row.coverage.donorPurpose.crmLinkage.complete).toBe(false);
      expect(row.coverage.accountingEvidence.grain).toBe("none");
      expect(row.coverage.complete).toBe(false);
      // No charge-grain coverage → no donor_purpose roles in evidence records
      expect(row.coverage.evidenceRecords.filter((r: any) => r.roles.includes("donor_purpose"))).toEqual([]);
      expect(row.coverage.donorPurpose.crmLinkage.coveredIds).toEqual([]);
      expect(row.coverage.donorPurpose.crmLinkage.uncoveredIds.length).toBeGreaterThanOrEqual(1);
    });

    it("donorPurpose+paymentTransaction complete but accountingEvidence absent (needs QB tie or settlement)", async () => {
      // Both charges have confirmed stripe PAs → donorPurpose & paymentTransaction complete.
      // No QB tie or settlement link → accountingEvidence grain=none, payoutSettled=false.
      // f_completed=false (payoutSettled=false) → cluster lands in needs_accounting.
      const g1 = await seedGift({ amount: "50.00" });
      const g2 = await seedGift({ amount: "50.00" });
      const payout = await seedPayout({ netTotal: "93.60" });
      const ch1 = await seedCharge(payout, { matchedGiftId: g1, grossAmount: "50.00" });
      const ch2 = await seedCharge(payout, { matchedGiftId: g2, grossAmount: "50.00" });

      const { map } = await listClusters("needs_accounting");
      const row = map.get(`stripe_payout:${payout}`);
      expect(row).toBeTruthy();
      expect(row.coverage).toBeTruthy();
      // donorPurpose: unit-grain (charge PAs), complete
      expect(row.coverage.donorPurpose.crmLinkage.grain).toBe("unit");
      expect(row.coverage.donorPurpose.crmLinkage.complete).toBe(true);
      expect(row.coverage.paymentTransaction.complete).toBe(true);
      // accountingEvidence: none (no QB tie or settlement)
      expect(row.coverage.accountingEvidence.grain).toBe("none");
      expect(row.coverage.accountingEvidence.complete).toBe(false);
      // overall not complete (QB accounting still absent)
      expect(row.coverage.complete).toBe(false);
      expect(row.coverage.donorPurpose.crmLinkage.coveredIds).toContain(ch1);
      expect(row.coverage.donorPurpose.crmLinkage.coveredIds).toContain(ch2);
      expect(row.coverage.donorPurpose.crmLinkage.uncoveredIds).toEqual([]);
      // Stripe charge evidence records carry donor_purpose role
      const stripeEvidence = row.coverage.evidenceRecords.filter((r: any) => r.source === "stripe_charge");
      expect(stripeEvidence.length).toBe(2);
      expect(stripeEvidence.every((r: any) => r.roles.includes("donor_purpose"))).toBe(true);
      // No cluster-level depositGrainGift field (removed).
      expect(row.depositGrainGift).toBeUndefined();
    });

    it("donorPurpose grain=unit + partial when only some charges have counted PAs", async () => {
      const g1 = await seedGift({ amount: "100.00" });
      const payout = await seedPayout();
      const ch1 = await seedCharge(payout, { matchedGiftId: g1 });
      const ch2 = await seedCharge(payout, {});

      const { map } = await listClusters("all_open");
      const row = map.get(`stripe_payout:${payout}`);
      expect(row).toBeTruthy();
      expect(row.coverage.donorPurpose.crmLinkage.grain).toBe("unit");
      expect(row.coverage.donorPurpose.crmLinkage.complete).toBe(false);
      expect(row.coverage.donorPurpose.crmLinkage.coveredIds).toContain(ch1);
      expect(row.coverage.donorPurpose.crmLinkage.uncoveredIds).toContain(ch2);
    });

    it("donorPurpose grain=bundle + complete when deposit PA covers full amount and settlement confirmed", async () => {
      // depositGrainGiftExists=true suppresses payoutAnyOpenCharge; payoutSettled=true
      // → f_completed=true → cluster in "completed" lens.
      const dep = await seedStaged({ entityType: "deposit", amount: "100.00" });
      const gDep = await seedCompleteGift({ amount: "100.00" });
      const payout = await seedPayout({ settledDeposit: dep, amount: "100.00", netTotal: "100.00" });
      await seedCharge(payout, {});
      await seedDepositApplication({ depositId: dep, giftId: gDep, amountApplied: "100.00" });

      const { map: completed } = await listClusters("completed");
      const row = completed.get(`stripe_payout:${payout}`);
      expect(row).toBeTruthy();
      expect(row.coverage).toBeTruthy();
      // donorPurpose: bundle-grain (deposit PA), complete
      expect(row.coverage.donorPurpose.crmLinkage.grain).toBe("bundle");
      expect(row.coverage.donorPurpose.crmLinkage.complete).toBe(true);
      // accountingEvidence: bundle-grain (confirmed settlement link), complete
      expect(row.coverage.accountingEvidence.grain).toBe("bundle");
      expect(row.coverage.accountingEvidence.complete).toBe(true);
      expect(row.coverage.complete).toBe(true);
      // QB deposit evidence record with bundle grain linked to gDep
      const qbRecord = row.coverage.evidenceRecords.find((r: any) => r.source === "qb_record");
      expect(qbRecord).toBeTruthy();
      expect(qbRecord.grain).toBe("bundle");
      expect(qbRecord.linkedGiftId).toBe(gDep);
    });

    it("donorPurpose grain=bundle + incomplete when deposit PA < expected amount → cluster stays open", async () => {
      // depositGrainGiftExists=true, but depositFullyCovered=false (50 < 100) → f_completed=false.
      const dep = await seedStaged({ entityType: "deposit", amount: "100.00" });
      const gDep = await seedGift({ amount: "50.00" });
      const payout = await seedPayout({ settledDeposit: dep, amount: "100.00", netTotal: "100.00" });
      await seedCharge(payout, {});
      await seedDepositApplication({ depositId: dep, giftId: gDep, amountApplied: "50.00" });

      const { map: completed } = await listClusters("completed");
      expect(completed.has(`stripe_payout:${payout}`)).toBe(false);

      const { map: open } = await listClusters("all_open");
      const row = open.get(`stripe_payout:${payout}`);
      expect(row).toBeTruthy();
      // Bundle-grain but the credited amount < expected → donorPurpose.crmLinkage.complete=false
      expect(row.coverage.donorPurpose.crmLinkage.grain).toBe("bundle");
      expect(row.coverage.donorPurpose.crmLinkage.complete).toBe(false);
      expect(row.coverage.complete).toBe(false);
      expect(Number(row.coverage.donorPurpose.crmLinkage.representedAmount)).toBeLessThan(
        Number(row.coverage.donorPurpose.crmLinkage.expectedAmount),
      );
    });

    it("donorPurpose grain=mixed when both charge PA and deposit PA exist → cluster stays open", async () => {
      // chargeGrainGiftExists=true AND depositGrainGiftExists=true → neither f_completed arm fires.
      const dep = await seedStaged({ entityType: "deposit", amount: "100.00" });
      const gCharge = await seedGift({ amount: "100.00" });
      const gDep = await seedGift({ amount: "100.00" });
      const payout = await seedPayout({ settledDeposit: dep, amount: "100.00", netTotal: "100.00" });
      const ch = await seedCharge(payout, { matchedGiftId: gCharge });
      await seedDepositApplication({ depositId: dep, giftId: gDep, amountApplied: "100.00" });

      const { map: completed } = await listClusters("completed");
      expect(completed.has(`stripe_payout:${payout}`)).toBe(false);

      const { map: open } = await listClusters("all_open");
      const rowAny = open.get(`stripe_payout:${payout}`);
      expect(rowAny).toBeTruthy();
      expect(rowAny.coverage.donorPurpose.crmLinkage.grain).toBe("mixed");
      expect(rowAny.coverage.donorPurpose.crmLinkage.complete).toBe(false);
      // All non-excluded charges appear in coveredIds for mixed grain
      expect(rowAny.coverage.donorPurpose.crmLinkage.coveredIds).toContain(ch);
      // Both evidence types present
      expect(rowAny.coverage.evidenceRecords.some((r: any) => r.source === "stripe_charge" && r.roles.includes("donor_purpose"))).toBe(true);
      expect(rowAny.coverage.evidenceRecords.some((r: any) => r.source === "qb_record")).toBe(true);
    });

    it("per-charge Done semantics: charge with linked gift shows Gift booked, not Done", async () => {
      // This test verifies the cluster response shape; UI rendering is tested separately.
      // The charge's linkedGiftId is set, but coverage.complete is false (1 of 2 covered).
      const g1 = await seedGift({ amount: "100.00" });
      const payout = await seedPayout();
      const ch1 = await seedCharge(payout, { matchedGiftId: g1 });
      await seedCharge(payout, {}); // uncovered

      const { map } = await listClusters("all_open");
      const row = map.get(`stripe_payout:${payout}`);
      expect(row).toBeTruthy();
      const linked = row.charges.find((c: any) => c.chargeId === ch1);
      expect(linked).toBeTruthy();
      expect(linked.linkedGiftId).toBe(g1);
      // Coverage is partial — the cluster is NOT complete.
      expect(row.coverage.complete).toBe(false);
      expect(row.coverage.donorPurpose.crmLinkage.grain).toBe("unit");
      // The UI is expected to show "Gift booked" not "Done" here (per chargeStatus logic).
    });

    it("refunded charge is excluded from paymentTransaction evidence", async () => {
      // A charge with refund_proposed=true must NOT count as payment-transaction evidence.
      // The cluster has two charges: one confirmed (with gift), one refunded.
      // paymentTransaction.complete = false (only the non-refunded gift-linked charge counts).
      const g1 = await seedGift({ amount: "100.00" });
      const payout = await seedPayout({ netTotal: "100.00" });
      const ch1 = await seedCharge(payout, { matchedGiftId: g1, grossAmount: "100.00" });
      const ch2 = await seedCharge(payout, { refundProposed: true });

      const { map } = await listClusters("all_open");
      const row = map.get(`stripe_payout:${payout}`);
      expect(row).toBeTruthy();
      expect(row.coverage).toBeTruthy();
      // ch1 is confirmed → crmLinkage coveredIds includes it
      expect(row.coverage.donorPurpose.crmLinkage.coveredIds).toContain(ch1);
      // ch2 is refunded → must NOT appear in paymentTransaction coveredIds
      expect(row.coverage.paymentTransaction.coveredIds).not.toContain(ch2);
      // paymentTransaction has ch1 (non-refunded, has PA) but coverage overall is incomplete (no QB tie)
      expect(row.coverage.paymentTransaction.complete).toBe(true);
      // ch2 not in crmLinkage uncoveredIds either — refunded charges are out of scope
      expect(row.coverage.donorPurpose.crmLinkage.uncoveredIds).not.toContain(ch2);
    });
  });

  // ── Invariant: cluster in Completed ⟺ coverage.complete ─────────────────
  //
  // This describe tests the central contract of the workbench-cluster system:
  // the server-side SQL flag f_completed (which gates lens membership) and the
  // JS-computed coverage.complete object MUST agree for every cluster kind.
  // Any divergence is a bug — one side would show "done" while the other shows
  // "still work to do".
  //
  // Cases covered:
  //   stripe_payout — charge-grain, bundle-grain, mixed-grain, refund (single
  //                   and partial), all-excluded
  //   qb_standalone — simple, grouped
  //   crm_only      — incomplete record, CRM-complete record (still not done:
  //                   payment/accounting always absent)
  describe("f_completed ↔ coverage.complete invariant", () => {
    // ── stripe_payout, charge-grain ────────────────────────────────────────
    it("stripe_payout charge-grain: complete gift → completed; incomplete gift → not completed", async () => {
      // COMPLETE side: confirmed settlement link + charge PA to CRM-complete gift.
      const dep = await seedStaged({ entityType: "deposit" });
      const gComplete = await seedCompleteGift();
      const pComplete = await seedPayout({ settledDeposit: dep, amount: "100.00", netTotal: "100.00" });
      await seedCharge(pComplete, { matchedGiftId: gComplete, grossAmount: "100.00" });

      // INCOMPLETE side: identical structure but gift has no coding-form / allocs.
      const dep2 = await seedStaged({ entityType: "deposit" });
      const gIncomplete = await seedGift();
      const pIncomplete = await seedPayout({ settledDeposit: dep2, amount: "100.00", netTotal: "100.00" });
      await seedCharge(pIncomplete, { matchedGiftId: gIncomplete, grossAmount: "100.00" });

      const { map: completed } = await listClusters("completed");
      const { map: open } = await listClusters("all_open");

      // Complete: in completed lens AND coverage.complete=true.
      const doneRow = completed.get(`stripe_payout:${pComplete}`);
      expect(doneRow).toBeTruthy();
      expect(doneRow.coverage.complete).toBe(true);
      expect(open.has(`stripe_payout:${pComplete}`)).toBe(false);

      // Incomplete: NOT in completed AND coverage.complete=false.
      expect(completed.has(`stripe_payout:${pIncomplete}`)).toBe(false);
      const openRow = open.get(`stripe_payout:${pIncomplete}`);
      expect(openRow).toBeTruthy();
      expect(openRow.coverage.complete).toBe(false);
      // donorPurpose linkage is covered (charge has PA) but CRM record is incomplete.
      expect(openRow.coverage.donorPurpose.crmLinkage.complete).toBe(true);
      expect(openRow.coverage.donorPurpose.crmRecordCompleteness.complete).toBe(false);
    });

    // ── stripe_payout, bundle-grain ────────────────────────────────────────
    it("stripe_payout bundle-grain: deposit PA fully covered + complete gift → completed; incomplete → not", async () => {
      // COMPLETE: deposit-grain PA covers full amount, confirmed settlement.
      // Charge has NO PA → chargeGrainGiftExists=false, depositGrainGiftExists=true.
      const dep = await seedStaged({ entityType: "deposit", amount: "100.00" });
      const gComplete = await seedCompleteGift({ amount: "100.00" });
      const pComplete = await seedPayout({ settledDeposit: dep, amount: "100.00", netTotal: "100.00" });
      await seedCharge(pComplete, {}); // no charge-grain PA
      await seedDepositApplication({ depositId: dep, giftId: gComplete, amountApplied: "100.00" });

      // INCOMPLETE: same shape but gift is CRM-incomplete.
      const dep2 = await seedStaged({ entityType: "deposit", amount: "100.00" });
      const gIncomplete = await seedGift({ amount: "100.00" });
      const pIncomplete = await seedPayout({ settledDeposit: dep2, amount: "100.00", netTotal: "100.00" });
      await seedCharge(pIncomplete, {}); // no charge-grain PA
      await seedDepositApplication({ depositId: dep2, giftId: gIncomplete, amountApplied: "100.00" });

      const { map: completed } = await listClusters("completed");
      const { map: open } = await listClusters("all_open");

      const doneRow = completed.get(`stripe_payout:${pComplete}`);
      expect(doneRow).toBeTruthy();
      expect(doneRow.coverage.complete).toBe(true);
      expect(doneRow.coverage.donorPurpose.crmLinkage.grain).toBe("bundle");
      expect(open.has(`stripe_payout:${pComplete}`)).toBe(false);

      expect(completed.has(`stripe_payout:${pIncomplete}`)).toBe(false);
      const openRow = open.get(`stripe_payout:${pIncomplete}`);
      expect(openRow).toBeTruthy();
      expect(openRow.coverage.complete).toBe(false);
      expect(openRow.coverage.donorPurpose.crmLinkage.grain).toBe("bundle");
      // Bundle linkage is complete (amount fully covered) but CRM record is not.
      expect(openRow.coverage.donorPurpose.crmLinkage.complete).toBe(true);
      expect(openRow.coverage.donorPurpose.crmRecordCompleteness.complete).toBe(false);
    });

    // ── stripe_payout, mixed-grain ─────────────────────────────────────────
    it("stripe_payout mixed-grain (charge + deposit PAs): never completed regardless of gift quality", async () => {
      // Both grain types present → neither f_completed arm fires; dpGrain="mixed"
      // → donorPurpose.crmLinkage.complete=false → coverage.complete=false.
      const dep = await seedStaged({ entityType: "deposit", amount: "100.00" });
      const gCharge = await seedCompleteGift({ amount: "100.00" });
      const gDep = await seedCompleteGift({ amount: "100.00" });
      const pMixed = await seedPayout({ settledDeposit: dep, amount: "100.00", netTotal: "100.00" });
      await seedCharge(pMixed, { matchedGiftId: gCharge, grossAmount: "100.00" }); // charge-grain
      await seedDepositApplication({ depositId: dep, giftId: gDep, amountApplied: "100.00" }); // deposit-grain

      const { map: completed } = await listClusters("completed");
      const { map: open } = await listClusters("all_open");

      expect(completed.has(`stripe_payout:${pMixed}`)).toBe(false);
      const row = open.get(`stripe_payout:${pMixed}`);
      expect(row).toBeTruthy();
      expect(row.coverage.complete).toBe(false);
      expect(row.coverage.donorPurpose.crmLinkage.grain).toBe("mixed");
    });

    // ── stripe_payout, refund pending ──────────────────────────────────────
    it("stripe_payout refund pending: coverage.complete=false even when other charges are done", async () => {
      // Single refunded charge: paymentTransaction.complete=false naturally.
      const pAllRefund = await seedPayout({ netTotal: "100.00" });
      await seedCharge(pAllRefund, { refundProposed: true });

      const { map: completed } = await listClusters("completed");
      const { map: refunds } = await listClusters("refunds");

      expect(completed.has(`stripe_payout:${pAllRefund}`)).toBe(false);
      const singleRow = refunds.get(`stripe_payout:${pAllRefund}`);
      expect(singleRow).toBeTruthy();
      expect(singleRow.coverage.complete).toBe(false);
      expect(singleRow.coverage.paymentTransaction.complete).toBe(false);

      // Mixed: one CRM-complete non-refunded charge + one refund pending.
      // hasPendingRefund gate must force coverage.complete=false even though
      // paymentTransaction + accounting + donorPurpose would otherwise all be true.
      const dep = await seedStaged({ entityType: "deposit" });
      const gDone = await seedCompleteGift();
      const pPartial = await seedPayout({ settledDeposit: dep, netTotal: "100.00" });
      await seedCharge(pPartial, { matchedGiftId: gDone, grossAmount: "100.00" });
      await seedCharge(pPartial, { refundProposed: true }); // pending refund on second charge

      const { map: completed2 } = await listClusters("completed");
      const { map: refunds2 } = await listClusters("refunds");

      expect(completed2.has(`stripe_payout:${pPartial}`)).toBe(false);
      const partialRow = refunds2.get(`stripe_payout:${pPartial}`);
      expect(partialRow).toBeTruthy();
      // hasPendingRefund gate — not complete even though the non-refunded side is done.
      expect(partialRow.coverage.complete).toBe(false);
    });

    // ── stripe_payout, all excluded ────────────────────────────────────────
    it("stripe_payout all excluded: not completed, coverage.complete=false", async () => {
      const pExcluded = await seedPayout();
      await seedCharge(pExcluded, { exclusionReason: "other" });

      const { map: completed } = await listClusters("completed");
      const { map: excluded } = await listClusters("excluded");

      expect(completed.has(`stripe_payout:${pExcluded}`)).toBe(false);
      const excRow = excluded.get(`stripe_payout:${pExcluded}`);
      expect(excRow).toBeTruthy();
      expect(excRow.coverage.complete).toBe(false);
      // No non-excluded charges → paymentTransaction and donorPurpose both absent.
      expect(excRow.coverage.paymentTransaction.complete).toBe(false);
      expect(excRow.coverage.donorPurpose.crmLinkage.grain).toBe("none");
    });

    // ── qb_standalone ──────────────────────────────────────────────────────
    it("qb_standalone: complete gift → completed; confirmed match to incomplete gift → not completed", async () => {
      // COMPLETE: confirmed match (autoApplied=false default) to CRM-complete gift.
      const gComplete = await seedCompleteGift();
      const sDone = await seedStaged({ matchedGiftId: gComplete });

      // INCOMPLETE: same structure but gift has no coding-form / allocs / grant-letter.
      // The match is still confirmed (status=match_confirmed) — allQbLinkedGiftsComplete
      // is false because giftComplete=false → f_completed=false.
      const gIncomplete = await seedGift();
      const sPartial = await seedStaged({ matchedGiftId: gIncomplete });

      const { map: completed } = await listClusters("completed");
      const { map: open } = await listClusters("all_open");

      const doneRow = completed.get(`qb_standalone:${sDone}`);
      expect(doneRow).toBeTruthy();
      expect(doneRow.coverage.complete).toBe(true);
      expect(doneRow.coverage.donorPurpose.crmLinkage.grain).toBe("unit");
      expect(open.has(`qb_standalone:${sDone}`)).toBe(false);

      // Matched but CRM-incomplete → NOT in completed lens, coverage.complete=false.
      expect(completed.has(`qb_standalone:${sPartial}`)).toBe(false);
      const openRow = open.get(`qb_standalone:${sPartial}`);
      expect(openRow).toBeTruthy();
      expect(openRow.coverage.complete).toBe(false);
      // qbDpComplete=true (resolved===total===1) but crmRecordCompleteness.complete=false.
      expect(openRow.coverage.donorPurpose.crmLinkage.complete).toBe(true);
      expect(openRow.coverage.donorPurpose.crmRecordCompleteness.complete).toBe(false);
      expect(openRow.coverage.donorPurpose.complete).toBe(false);
    });

    // ── grouped qb_standalone ──────────────────────────────────────────────
    it("grouped qb_standalone: all members matched to CRM-complete gifts → completed", async () => {
      const grp = `grp_inv_${RUN}`;
      const g1 = await seedCompleteGift({ amount: "40.00" });
      const g2 = await seedCompleteGift({ amount: "35.00" });
      const m1 = await seedStaged({ group: grp, amount: "40.00", matchedGiftId: g1 });
      await seedStaged({ group: grp, amount: "35.00", matchedGiftId: g2 });
      // m1 seeded first → lower seq suffix → m1 < m2 → m1 is the representative (MIN id).

      const { map: completed } = await listClusters("completed");
      const { map: open } = await listClusters("all_open");

      const doneRow = completed.get(`qb_standalone:${m1}`);
      expect(doneRow).toBeTruthy();
      expect(doneRow.coverage.complete).toBe(true);
      expect(doneRow.group?.memberCount).toBe(2);
      expect(open.has(`qb_standalone:${m1}`)).toBe(false);
    });

    // ── crm_only ───────────────────────────────────────────────────────────
    it("crm_only: coverage.complete always false — payment/accounting evidence absent by definition", async () => {
      // Incomplete CRM record (no allocs/coding-form → crmReason='missing_allocation').
      const gIncomplete = await seedGift();
      // CRM-complete gift (codingFormMemo set) — donorPurpose can be complete
      // (the gift IS the anchor so linkage is trivially covered), but payment and
      // accounting evidence are always absent → coverage.complete stays false.
      const gComplete = await seedCompleteGift();

      const { map: completed } = await listClusters("completed");
      const { map: open } = await listClusters("all_open");

      for (const giftId of [gIncomplete, gComplete]) {
        expect(completed.has(`crm_only:${giftId}`)).toBe(false);
        const row = open.get(`crm_only:${giftId}`);
        expect(row).toBeTruthy();
        expect(row.coverage.complete).toBe(false);
        expect(row.coverage.paymentTransaction.complete).toBe(false);
        expect(row.coverage.accountingEvidence.complete).toBe(false);
      }
      // CRM-incomplete gift: donorPurpose also false (crmRecordCompleteness.complete=false).
      const incRow = open.get(`crm_only:${gIncomplete}`);
      expect(incRow?.coverage.donorPurpose.complete).toBe(false);
      expect(incRow?.coverage.donorPurpose.crmRecordCompleteness.complete).toBe(false);

      // CRM-complete gift: donorPurpose.complete=true (linkage covered, record done)
      // but overall coverage.complete=false (payment/accounting still absent).
      const completeRow = open.get(`crm_only:${gComplete}`);
      expect(completeRow?.coverage.donorPurpose.complete).toBe(true);
      expect(completeRow?.coverage.donorPurpose.crmRecordCompleteness.complete).toBe(true);
    });
  });
});
