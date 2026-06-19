import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-backed coverage for the Stripe payout ↔ QuickBooks deposit proposal pass
 * (`runProposalPass`). Unlike the pure scoring unit test, this exercises the
 * real candidate query + idempotent proposal writes against dev Postgres so it
 * can assert the actual stripe_payouts state transitions:
 *   - best eligible deposit proposed (status → proposed, proposedQb… set),
 *   - re-running is idempotent (no churn),
 *   - an APPROVED deposit already booked into a gift becomes conflict_approved,
 *   - a deposit already CONFIRMED-linked to another payout is never re-proposed,
 *   - a stale proposal clears back to unmatched when its candidate disappears,
 *   - confirmed_* payouts are left untouched,
 *   - one deposit is never assigned to two payouts in a single pass.
 *
 * The pass is lock-free, so no server/auth seam is needed — we call it directly.
 * All rows use a unique run prefix + deliberately unusual amounts/dates so the
 * ±$5 / ±10-day candidate query can't collide with other dev data. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `striperec_${Date.now()}`;
const ACCOUNT_ID = `${RUN}_acct`;
const REALM_ID = `${RUN}_realm`;
const ORG_ID = `${RUN}_org`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stripePayouts: Db["stripePayouts"];
  stagedPayments: Db["stagedPayments"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  organizations: Db["organizations"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let runProposalPass: typeof import("../lib/stripeReconcile")["runProposalPass"];

const payoutIds: string[] = [];
const stagedIds: string[] = [];
const giftIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedPayout(over: {
  amount: string;
  arrivalDate: string;
  status?: Db["stripePayouts"]["$inferInsert"]["qbReconciliationStatus"];
  matchedQbStagedPaymentId?: string | null;
  proposedQbStagedPaymentId?: string | null;
}): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: over.amount,
    netTotal: over.amount,
    arrivalDate: over.arrivalDate,
    qbReconciliationStatus: over.status ?? "unmatched",
    matchedQbStagedPaymentId: over.matchedQbStagedPaymentId ?? null,
    proposedQbStagedPaymentId: over.proposedQbStagedPaymentId ?? null,
  });
  payoutIds.push(id);
  return id;
}

async function seedDeposit(over: {
  amount: string;
  dateReceived: string;
  payerName?: string | null;
  status?: "pending" | "approved" | "excluded" | "rejected";
  createdGiftId?: string | null;
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: nextId("qbe"),
    amount: over.amount,
    dateReceived: over.dateReceived,
    payerName: over.payerName === undefined ? "Stripe" : over.payerName,
    status: over.status ?? "pending",
    createdGiftId: over.createdGiftId ?? null,
  });
  stagedIds.push(id);
  return id;
}

async function seedGift(amount: string): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
  });
  await db.insert(schema.giftAllocations).values({
    id: nextId("alloc"),
    giftId: id,
    subAmount: amount,
  });
  giftIds.push(id);
  return id;
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
    stripePayouts: dbMod.stripePayouts,
    stagedPayments: dbMod.stagedPayments,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    organizations: dbMod.organizations,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  ({ runProposalPass } = await import("../lib/stripeReconcile"));

  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Stripe Reconcile Org ${RUN}`,
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  if (giftIds.length) {
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
});

describe.skipIf(!HAS_DB)("runProposalPass (DB)", () => {
  it("proposes the best eligible deposit and is idempotent", async () => {
    const po = await seedPayout({ amount: "7777.77", arrivalDate: "2026-03-15" });
    const dep = await seedDeposit({ amount: "7777.77", dateReceived: "2026-03-15" });
    // A weaker (off-amount, no signal) deposit should NOT win.
    await seedDeposit({
      amount: "7779.00",
      dateReceived: "2026-03-15",
      payerName: "Bank Deposit",
    });

    const first = await runProposalPass([po]);
    expect(first.proposed).toBe(1);

    let row = await readPayout(po);
    expect(row.qbReconciliationStatus).toBe("proposed");
    expect(row.proposedQbStagedPaymentId).toBe(dep);
    expect(row.qbConflictStagedPaymentId).toBeNull();
    const firstUpdatedAt = row.updatedAt;

    // Re-run: still proposed to the same deposit (idempotent).
    const second = await runProposalPass([po]);
    expect(second.proposed).toBe(1);
    row = await readPayout(po);
    expect(row.qbReconciliationStatus).toBe("proposed");
    expect(row.proposedQbStagedPaymentId).toBe(dep);
    void firstUpdatedAt;
  });

  it("flags a conflict when the best deposit is approved + booked into a gift", async () => {
    const gift = await seedGift("8888.88");
    const po = await seedPayout({ amount: "8888.88", arrivalDate: "2026-04-10" });
    const dep = await seedDeposit({
      amount: "8888.88",
      dateReceived: "2026-04-10",
      status: "approved",
      createdGiftId: gift,
    });

    const r = await runProposalPass([po]);
    expect(r.conflicts).toBe(1);

    const row = await readPayout(po);
    expect(row.qbReconciliationStatus).toBe("conflict_approved");
    expect(row.proposedQbStagedPaymentId).toBe(dep);
    expect(row.qbConflictStagedPaymentId).toBe(dep);
    expect(row.qbConflictGiftId).toBe(gift);
  });

  it("never re-proposes a deposit already confirmed-linked to another payout", async () => {
    const dep = await seedDeposit({ amount: "9999.11", dateReceived: "2026-05-01" });
    // A confirmed payout owns that deposit.
    await seedPayout({
      amount: "9999.11",
      arrivalDate: "2026-05-01",
      status: "confirmed_keep",
      matchedQbStagedPaymentId: dep,
    });
    // A second, still-open payout whose only candidate is the taken deposit.
    const po2 = await seedPayout({ amount: "9999.11", arrivalDate: "2026-05-01" });

    const r = await runProposalPass([po2]);
    expect(r.proposed).toBe(0);
    const row = await readPayout(po2);
    expect(row.qbReconciliationStatus).toBe("unmatched");
    expect(row.proposedQbStagedPaymentId).toBeNull();
  });

  it("clears a stale proposal back to unmatched when no candidate is eligible", async () => {
    // Payout pre-set to `proposed` but with no matching deposit in the window.
    const po = await seedPayout({
      amount: "6543.21",
      arrivalDate: "2026-06-01",
      status: "proposed",
      proposedQbStagedPaymentId: null,
    });

    const r = await runProposalPass([po]);
    expect(r.cleared).toBe(1);
    const row = await readPayout(po);
    expect(row.qbReconciliationStatus).toBe("unmatched");
    expect(row.proposedQbStagedPaymentId).toBeNull();
  });

  it("leaves confirmed_* payouts untouched", async () => {
    const dep = await seedDeposit({ amount: "5151.51", dateReceived: "2026-07-01" });
    const po = await seedPayout({
      amount: "5151.51",
      arrivalDate: "2026-07-01",
      status: "confirmed_excluded",
      matchedQbStagedPaymentId: dep,
    });

    const r = await runProposalPass([po]);
    expect(r.proposed).toBe(0);
    expect(r.conflicts).toBe(0);
    const row = await readPayout(po);
    expect(row.qbReconciliationStatus).toBe("confirmed_excluded");
    expect(row.matchedQbStagedPaymentId).toBe(dep);
  });

  it("never assigns one deposit to two payouts in a single pass", async () => {
    const poA = await seedPayout({ amount: "4242.42", arrivalDate: "2026-08-01" });
    const poB = await seedPayout({ amount: "4242.42", arrivalDate: "2026-08-01" });
    const dep = await seedDeposit({ amount: "4242.42", dateReceived: "2026-08-01" });

    const r = await runProposalPass([poA, poB]);
    expect(r.proposed).toBe(1);

    const rowA = await readPayout(poA);
    const rowB = await readPayout(poB);
    const proposedTo = [rowA, rowB].filter(
      (x) => x.qbReconciliationStatus === "proposed",
    );
    const unmatched = [rowA, rowB].filter(
      (x) => x.qbReconciliationStatus === "unmatched",
    );
    expect(proposedTo).toHaveLength(1);
    expect(unmatched).toHaveLength(1);
    expect(proposedTo[0].proposedQbStagedPaymentId).toBe(dep);
  });
});
