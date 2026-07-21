import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  DERIVED_STATUSES,
  type DerivedStatus,
  qbStatusCaseText,
  qbOpenText,
  chargeStatusCaseText,
  chargeOpenText,
  stagedStatusSql,
  stagedStatusWhere,
  chargeStatusSql,
  chargeStatusWhere,
} from "../lib/derivedStatus";
import {
  clearPaymentApplicationsForGiftIds,
  seedStripeApplication,
} from "./paymentApplicationsTestUtil";

/**
 * PostgreSQL EXECUTION parity for the centralized derived-status builders.
 *
 * For every fact combination we seed a real row and assert that THREE reads
 * agree on the derived status:
 *
 *   1. the base-table drizzle fragment (`stagedStatusSql` / `chargeStatusSql`),
 *   2. the alias-parameterized text builder rendered through `sql.raw` with a
 *      DIFFERENT alias (`zz` / `cz`) — the aliased/raw-SQL entry point every
 *      converted call site uses,
 *   3. the per-status WHERE partition (`stagedStatusWhere` / `chargeStatusWhere`)
 *      — the row must satisfy EXACTLY ONE arm, and it must be the same status
 *      (mutual exclusivity + exhaustiveness under real SQL semantics).
 *
 * It also locks the tie ≠ status rule against the live schema: a raw
 * charge→QB tie (linked_qb_staged_payment_id) WITHOUT the tied charge's own
 * counted booking must leave the QB row `pending` — only the booked tie is
 * confirmation evidence. And a merely-PROPOSED settlement link is not
 * evidence either.
 *
 * Static SQL-rendering parity lives in derived-status-builders.test.ts.
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `dsparity_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  stripePayouts: Db["stripePayouts"];
  settlementLinks: Db["settlementLinks"];
  paymentApplications: Db["paymentApplications"];
  sourceLinks: Db["sourceLinks"];
  sourceLinkId: Db["sourceLinkId"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];

const giftIds: string[] = [];
const stagedIds: string[] = [];
const chargeIds: string[] = [];
const payoutIds: string[] = [];
const settlementLinkIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedGift(): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    organizationId: ORG_ID,
    amount: "50.00",
    details: "derived-status parity test gift",
    dateReceived: "2026-05-01",
  });
  giftIds.push(id);
  return id;
}

async function seedQbRow(
  over: {
    exclusionReason?: "other_revenue";
    autoApplied?: boolean;
    matchConfirmedAt?: Date | null;
  } = {},
): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "payment",
    qbEntityId: nextId("qbe"),
    amount: "50.00",
    dateReceived: "2026-05-02",
    payerName: `${RUN} qb payer`,
    ...(over.exclusionReason ? { exclusionReason: over.exclusionReason } : {}),
    ...(over.autoApplied !== undefined ? { autoApplied: over.autoApplied } : {}),
    ...(over.matchConfirmedAt !== undefined
      ? { matchConfirmedAt: over.matchConfirmedAt }
      : {}),
  });
  stagedIds.push(id);
  return id;
}

/** Counted QB cash-application ledger row anchored on a staged payment. */
async function seedQbApplication(paymentId: string): Promise<void> {
  await db.insert(schema.paymentApplications).values({
    id: nextId("pa"),
    giftId: await seedGift(),
    paymentId,
    amountApplied: "50.00",
    evidenceSource: "quickbooks",
    matchMethod: "system",
  });
}

async function seedPayout(): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: "50.00",
    netTotal: "48.55",
    grossTotal: "50.00",
    feeTotal: "1.45",
    arrivalDate: "2026-05-03",
    chargeCount: 1,
  });
  payoutIds.push(id);
  return id;
}

async function seedSettlementLink(
  payoutId: string,
  depositStagedPaymentId: string,
  lifecycle: "confirmed" | "proposed",
): Promise<void> {
  const id = `sl_${payoutId}`;
  await db.insert(schema.settlementLinks).values({
    id,
    payoutId,
    depositStagedPaymentId,
    lifecycle,
    provenance: lifecycle === "confirmed" ? "human" : "system",
    confirmedByUserId: null,
    confirmedAt: lifecycle === "confirmed" ? new Date() : null,
  });
  settlementLinkIds.push(id);
}

async function seedCharge(
  payoutId: string,
  over: {
    exclusionReason?: "other_revenue";
    autoApplied?: boolean;
    matchConfirmedAt?: Date | null;
    linkedQbStagedPaymentId?: string;
  } = {},
): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: payoutId,
    grossAmount: "50.00",
    feeAmount: "1.45",
    netAmount: "48.55",
    dateReceived: "2026-05-02",
    payerName: `${RUN} charge payer`,
    payerEmail: `${RUN}@example.invalid`,
    ...(over.exclusionReason ? { exclusionReason: over.exclusionReason } : {}),
    ...(over.autoApplied !== undefined ? { autoApplied: over.autoApplied } : {}),
    ...(over.matchConfirmedAt !== undefined
      ? { matchConfirmedAt: over.matchConfirmedAt }
      : {}),
  });
  // The tie lives ONLY in the source_links ledger (the authority).
  if (over.linkedQbStagedPaymentId) {
    await db.insert(schema.sourceLinks).values({
      id: schema.sourceLinkId("charge_qb_tie", id),
      linkType: "charge_qb_tie",
      stripeChargeId: id,
      qbStagedPaymentId: over.linkedQbStagedPaymentId,
      lifecycle: "confirmed",
      provenance: "human",
    });
  }
  chargeIds.push(id);
  return id;
}

/** Counted Stripe ledger row on a charge = the charge's money is booked. */
async function bookCharge(chargeId: string): Promise<void> {
  await seedStripeApplication({
    stripeChargeId: chargeId,
    giftId: await seedGift(),
    amountApplied: "50.00",
  });
}

interface ParityReadout {
  base: string;
  aliasedRaw: string;
  open: boolean;
  matchingWhereArms: DerivedStatus[];
}

async function readQbParity(id: string): Promise<ParityReadout> {
  const [row] = await db
    .select({ status: stagedStatusSql })
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, id));
  const raw = await db.execute(
    sql`SELECT ${sql.raw(qbStatusCaseText("zz"))}::text AS status, ${sql.raw(qbOpenText("zz"))} AS open FROM staged_payments "zz" WHERE "zz"."id" = ${id}`,
  );
  const rawRow = (raw as unknown as { rows: Array<{ status: string; open: boolean }> })
    .rows[0];
  const matching: DerivedStatus[] = [];
  for (const s of DERIVED_STATUSES) {
    const hits = await db
      .select({ id: schema.stagedPayments.id })
      .from(schema.stagedPayments)
      .where(andFn(eqFn(schema.stagedPayments.id, id), stagedStatusWhere[s]));
    if (hits.length) matching.push(s);
  }
  return {
    base: row!.status,
    aliasedRaw: rawRow!.status,
    open: rawRow!.open,
    matchingWhereArms: matching,
  };
}

async function readChargeParity(id: string): Promise<ParityReadout> {
  const [row] = await db
    .select({ status: chargeStatusSql })
    .from(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, id));
  const raw = await db.execute(
    sql`SELECT ${sql.raw(chargeStatusCaseText("cz"))}::text AS status, ${sql.raw(chargeOpenText("cz"))} AS open FROM stripe_staged_charges "cz" WHERE "cz"."id" = ${id}`,
  );
  const rawRow = (raw as unknown as { rows: Array<{ status: string; open: boolean }> })
    .rows[0];
  const matching: DerivedStatus[] = [];
  for (const s of DERIVED_STATUSES) {
    const hits = await db
      .select({ id: schema.stripeStagedCharges.id })
      .from(schema.stripeStagedCharges)
      .where(
        andFn(eqFn(schema.stripeStagedCharges.id, id), chargeStatusWhere[s]),
      );
    if (hits.length) matching.push(s);
  }
  return {
    base: row!.status,
    aliasedRaw: rawRow!.status,
    open: rawRow!.open,
    matchingWhereArms: matching,
  };
}

async function expectQbStatus(id: string, expected: DerivedStatus) {
  const r = await readQbParity(id);
  expect(r.base, "base-table fragment").toBe(expected);
  expect(r.aliasedRaw, "aliased builder text").toBe(expected);
  expect(r.matchingWhereArms, "WHERE partition (exactly one arm)").toEqual([
    expected,
  ]);
  expect(r.open, "open predicate").toBe(
    expected === "pending" || expected === "match_proposed",
  );
}

async function expectChargeStatus(id: string, expected: DerivedStatus) {
  const r = await readChargeParity(id);
  expect(r.base, "base-table fragment").toBe(expected);
  expect(r.aliasedRaw, "aliased builder text").toBe(expected);
  expect(r.matchingWhereArms, "WHERE partition (exactly one arm)").toEqual([
    expected,
  ]);
  expect(r.open, "open predicate").toBe(
    expected === "pending" || expected === "match_proposed",
  );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
    stagedPayments: dbMod.stagedPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    stripePayouts: dbMod.stripePayouts,
    settlementLinks: dbMod.settlementLinks,
    paymentApplications: dbMod.paymentApplications,
    sourceLinks: dbMod.sourceLinks,
    sourceLinkId: dbMod.sourceLinkId,
  };
  eqFn = drizzle.eq;
  andFn = drizzle.and as typeof andFn;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Derived-Status Parity Test Org ${RUN}`,
  });
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  // FK order: ledger rows → settlement links → gifts → charges → staged
  // payments → payouts → org.
  await clearPaymentApplicationsForGiftIds(giftIds);
  if (settlementLinkIds.length)
    await db
      .delete(schema.settlementLinks)
      .where(inArrayFn(schema.settlementLinks.id, settlementLinkIds));
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn("[derived-status-parity] skipped: no live DATABASE_URL");
  }
});

describe.skipIf(!HAS_DB)("QB staged-payment derived-status parity", () => {
  it("bare row → pending", async () => {
    await expectQbStatus(await seedQbRow(), "pending");
  });

  it("exclusion_reason set → excluded (wins over everything)", async () => {
    const id = await seedQbRow({
      exclusionReason: "other_revenue",
      autoApplied: true,
    });
    await seedQbApplication(id);
    await expectQbStatus(id, "excluded");
  });

  it("auto-applied counted row awaiting review → match_proposed", async () => {
    const id = await seedQbRow({ autoApplied: true, matchConfirmedAt: null });
    await seedQbApplication(id);
    await expectQbStatus(id, "match_proposed");
  });

  it("counted row, human-confirmed → match_confirmed", async () => {
    const id = await seedQbRow({
      autoApplied: true,
      matchConfirmedAt: new Date(),
    });
    await seedQbApplication(id);
    await expectQbStatus(id, "match_confirmed");
  });

  it("counted row, not auto-applied → match_confirmed", async () => {
    const id = await seedQbRow();
    await seedQbApplication(id);
    await expectQbStatus(id, "match_confirmed");
  });

  it("CONFIRMED settlement link (no ledger row) → match_confirmed", async () => {
    const id = await seedQbRow();
    await seedSettlementLink(await seedPayout(), id, "confirmed");
    await expectQbStatus(id, "match_confirmed");
  });

  it("merely-PROPOSED settlement link is NOT evidence → pending", async () => {
    const id = await seedQbRow();
    await seedSettlementLink(await seedPayout(), id, "proposed");
    await expectQbStatus(id, "pending");
  });

  it("RAW charge tie WITHOUT the charge's booking is a claim, not evidence → pending", async () => {
    const id = await seedQbRow();
    await seedCharge(await seedPayout(), { linkedQbStagedPaymentId: id });
    await expectQbStatus(id, "pending");
  });

  it("BOOKED charge tie (tied charge carries a counted row) → match_confirmed", async () => {
    const id = await seedQbRow();
    const chargeId = await seedCharge(await seedPayout(), {
      linkedQbStagedPaymentId: id,
    });
    await bookCharge(chargeId);
    await expectQbStatus(id, "match_confirmed");
    // The tied charge itself is booked → confirmed on its own ledger row.
    await expectChargeStatus(chargeId, "match_confirmed");
  });
});

describe.skipIf(!HAS_DB)("Stripe charge derived-status parity", () => {
  it("bare charge → pending", async () => {
    await expectChargeStatus(await seedCharge(await seedPayout()), "pending");
  });

  it("exclusion_reason set → excluded (wins over booking)", async () => {
    const id = await seedCharge(await seedPayout(), {
      exclusionReason: "other_revenue",
      autoApplied: true,
    });
    await bookCharge(id);
    await expectChargeStatus(id, "excluded");
  });

  it("auto-applied counted row awaiting review → match_proposed", async () => {
    const id = await seedCharge(await seedPayout(), {
      autoApplied: true,
      matchConfirmedAt: null,
    });
    await bookCharge(id);
    await expectChargeStatus(id, "match_proposed");
  });

  it("counted row, human-confirmed → match_confirmed", async () => {
    const id = await seedCharge(await seedPayout(), {
      autoApplied: true,
      matchConfirmedAt: new Date(),
    });
    await bookCharge(id);
    await expectChargeStatus(id, "match_confirmed");
  });

  it("a charge's raw tie claim does not change the CHARGE's own status either", async () => {
    const qbId = await seedQbRow();
    const id = await seedCharge(await seedPayout(), {
      linkedQbStagedPaymentId: qbId,
    });
    await expectChargeStatus(id, "pending");
  });
});
