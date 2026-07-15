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

async function seedPayout(
  opts: {
    settledDeposit?: string;
    proposedDeposit?: string;
    conflictGiftId?: string;
  } = {},
): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: "100.00",
    netTotal: "96.80",
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
    payerName: opts.payerName ?? `Zztest Cluster Charge ${RUN}`,
    payerEmail: `${RUN}-charge@example.invalid`,
    exclusionReason: (opts.exclusionReason ?? null) as never,
    linkedQbStagedPaymentId: opts.linkedQbStagedPaymentId ?? null,
    linkedFeeQbStagedPaymentId: opts.linkedFeeQbStagedPaymentId ?? null,
    refundPropagationStatus: (opts.refundProposed ? "proposed" : "none") as never,
    refundPropagationKind: (opts.refundProposed ? "full_refund" : null) as never,
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

async function seedStaged(
  opts: {
    group?: string | null;
    exclusionReason?: string | null;
    amount?: string;
    payerName?: string;
    matchedGiftId?: string | null;
    autoApplied?: boolean;
    entityType?: "payment" | "deposit";
  } = {},
): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: opts.entityType ?? "payment",
    qbEntityId: id,
    qbLineId: "",
    amount: opts.amount ?? "75.00",
    dateReceived: futureDate(),
    payerName: opts.payerName ?? `Zztest Cluster Payer ${RUN}`,
    exclusionReason: (opts.exclusionReason ?? null) as never,
    autoApplied: opts.autoApplied ?? false,
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
    const gQb = await seedGift();
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
    const gCharge = await seedGift();
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
  });

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
});
