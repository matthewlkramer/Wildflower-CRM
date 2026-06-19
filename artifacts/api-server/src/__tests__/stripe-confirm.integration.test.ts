import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-backed coverage for the R4 human-confirm/revert payout ↔ QuickBooks-deposit
 * transitions (stripeConfirm.ts). Exercises the real guarded UPDATEs + archive
 * against dev Postgres:
 *   - CONFIRM-EXCLUDE: proposed → confirmed_excluded; deposit excluded + linked,
 *   - CONFIRM-KEEP: conflict_approved → confirmed_keep; deposit/gift untouched,
 *   - CONFIRM-REPLACE: conflict_approved → confirmed_replace; gift archived
 *     (allocations preserved), deposit excluded + linked,
 *   - REVERT for each confirmed state restores the prior state,
 *   - REVERT of confirmed_replace is refused once a payout charge is booked,
 *   - invalid transitions / unknown payout return typed errors.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `stripeconf_${Date.now()}`;
const ACCOUNT_ID = `${RUN}_acct`;
const REALM_ID = `${RUN}_realm`;
const ORG_ID = `${RUN}_org`;
const USER_ID = `${RUN}_user`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stripePayouts: Db["stripePayouts"];
  stagedPayments: Db["stagedPayments"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  organizations: Db["organizations"];
  users: Db["users"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let confirm: typeof import("../lib/stripeConfirm");

const payoutIds: string[] = [];
const stagedIds: string[] = [];
const giftIds: string[] = [];
const chargeIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedPayout(over: {
  status?: Db["stripePayouts"]["$inferInsert"]["qbReconciliationStatus"];
  proposedQbStagedPaymentId?: string | null;
  matchedQbStagedPaymentId?: string | null;
  qbConflictStagedPaymentId?: string | null;
  qbConflictGiftId?: string | null;
}): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: "1000.00",
    netTotal: "1000.00",
    arrivalDate: "2026-03-15",
    qbReconciliationStatus: over.status ?? "unmatched",
    proposedQbStagedPaymentId: over.proposedQbStagedPaymentId ?? null,
    matchedQbStagedPaymentId: over.matchedQbStagedPaymentId ?? null,
    qbConflictStagedPaymentId: over.qbConflictStagedPaymentId ?? null,
    qbConflictGiftId: over.qbConflictGiftId ?? null,
  });
  payoutIds.push(id);
  return id;
}

async function seedDeposit(over: {
  status?: "pending" | "approved" | "excluded" | "rejected";
  createdGiftId?: string | null;
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: nextId("qbe"),
    amount: "1000.00",
    dateReceived: "2026-03-15",
    payerName: "Stripe",
    status: over.status ?? "pending",
    createdGiftId: over.createdGiftId ?? null,
  });
  stagedIds.push(id);
  return id;
}

async function seedGift(): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount: "1000.00",
    organizationId: ORG_ID,
    details: "Imported from QuickBooks (deposit).",
  });
  await db.insert(schema.giftAllocations).values({
    id: nextId("alloc"),
    giftId: id,
    subAmount: "1000.00",
  });
  giftIds.push(id);
  return id;
}

async function seedCharge(
  payoutId: string,
  over: { status?: "pending" | "approved"; createdGiftId?: string | null },
): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: payoutId,
    grossAmount: "1000.00",
    feeAmount: "30.00",
    status: over.status ?? "pending",
    createdGiftId: over.createdGiftId ?? null,
  });
  chargeIds.push(id);
  return id;
}

async function readPayout(id: string) {
  const [row] = await db
    .select()
    .from(schema.stripePayouts)
    .where(eqFn(schema.stripePayouts.id, id));
  return row;
}
async function readDeposit(id: string) {
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

/** Seed a fully-wired conflict_approved payout: approved deposit booked into a
 * gift, payout pointing at both. Mirrors the proposal pass's conflict output. */
async function seedConflict(): Promise<{ po: string; dep: string; gift: string }> {
  const gift = await seedGift();
  const dep = await seedDeposit({ status: "approved", createdGiftId: gift });
  const po = await seedPayout({
    status: "conflict_approved",
    proposedQbStagedPaymentId: dep,
    qbConflictStagedPaymentId: dep,
    qbConflictGiftId: gift,
  });
  return { po, dep, gift };
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
    stripeStagedCharges: dbMod.stripeStagedCharges,
    organizations: dbMod.organizations,
    users: dbMod.users,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  confirm = await import("../lib/stripeConfirm");

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `${RUN}_clerk`,
    email: `${RUN}@wildflowerschools.org`,
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Stripe Confirm Org ${RUN}`,
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
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
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
});

describe.skipIf(!HAS_DB)("stripeConfirm transitions (DB)", () => {
  it("CONFIRM-EXCLUDE: proposed → confirmed_excluded, deposit excluded + linked", async () => {
    const dep = await seedDeposit({ status: "pending" });
    const po = await seedPayout({ status: "proposed", proposedQbStagedPaymentId: dep });

    const r = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("confirmed_excluded");

    const payout = await readPayout(po);
    expect(payout.qbReconciliationStatus).toBe("confirmed_excluded");
    expect(payout.matchedQbStagedPaymentId).toBe(dep);
    expect(payout.proposedQbStagedPaymentId).toBeNull();
    expect(payout.qbReconciliationConfirmedByUserId).toBe(USER_ID);
    expect(payout.qbReconciliationConfirmedAt).not.toBeNull();

    const deposit = await readDeposit(dep);
    expect(deposit.status).toBe("excluded");
    expect(deposit.exclusionReason).toBe("processor_payout");
    expect(deposit.classificationSource).toBe("manual");
  });

  it("CONFIRM-EXCLUDE: rejects a payout that is not proposed", async () => {
    const po = await seedPayout({ status: "unmatched" });
    const r = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_transition");
  });

  it("CONFIRM-EXCLUDE: not_found for an unknown payout", async () => {
    const r = await confirm.confirmPendingQbDeposit({
      payoutId: `${RUN}_missing`,
      userId: USER_ID,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });

  it("CONFIRM-KEEP: conflict_approved → confirmed_keep, deposit + gift untouched", async () => {
    const { po, dep, gift } = await seedConflict();

    const r = await confirm.confirmKeepApprovedQbGift({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("confirmed_keep");

    const payout = await readPayout(po);
    expect(payout.qbReconciliationStatus).toBe("confirmed_keep");
    expect(payout.matchedQbStagedPaymentId).toBe(dep);

    // KEEP touches nothing else: deposit stays approved, gift stays active.
    expect((await readDeposit(dep)).status).toBe("approved");
    expect((await readGift(gift)).archivedAt).toBeNull();
  });

  it("CONFIRM-REPLACE: conflict_approved → confirmed_replace, gift archived + allocations preserved", async () => {
    const { po, dep, gift } = await seedConflict();

    const r = await confirm.confirmReplaceApprovedQbGift({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("confirmed_replace");
    expect(r.archivedGiftId).toBe(gift);

    const payout = await readPayout(po);
    expect(payout.qbReconciliationStatus).toBe("confirmed_replace");
    expect(payout.matchedQbStagedPaymentId).toBe(dep);

    const deposit = await readDeposit(dep);
    expect(deposit.status).toBe("excluded");
    expect(deposit.exclusionReason).toBe("processor_payout");

    const archived = await readGift(gift);
    expect(archived.archivedAt).not.toBeNull();
    // Allocations are preserved (never deleted on archive).
    const allocs = await db
      .select()
      .from(schema.giftAllocations)
      .where(eqFn(schema.giftAllocations.giftId, gift));
    expect(allocs.length).toBe(1);
  });

  it("REVERT confirmed_excluded → proposed, deposit pending again", async () => {
    const dep = await seedDeposit({ status: "pending" });
    const po = await seedPayout({ status: "proposed", proposedQbStagedPaymentId: dep });
    await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });

    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);

    const payout = await readPayout(po);
    expect(payout.qbReconciliationStatus).toBe("proposed");
    expect(payout.proposedQbStagedPaymentId).toBe(dep);
    expect(payout.matchedQbStagedPaymentId).toBeNull();
    expect(payout.qbReconciliationConfirmedByUserId).toBeNull();
    expect((await readDeposit(dep)).status).toBe("pending");
  });

  it("REVERT confirmed_keep → conflict_approved", async () => {
    const { po, dep } = await seedConflict();
    await confirm.confirmKeepApprovedQbGift({ payoutId: po, userId: USER_ID });

    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);

    const payout = await readPayout(po);
    expect(payout.qbReconciliationStatus).toBe("conflict_approved");
    expect(payout.proposedQbStagedPaymentId).toBe(dep);
    expect(payout.matchedQbStagedPaymentId).toBeNull();
    expect((await readDeposit(dep)).status).toBe("approved");
  });

  it("REVERT confirmed_replace → conflict_approved, gift unarchived + deposit approved", async () => {
    const { po, dep, gift } = await seedConflict();
    await confirm.confirmReplaceApprovedQbGift({ payoutId: po, userId: USER_ID });

    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.restoredGiftId).toBe(gift);

    const payout = await readPayout(po);
    expect(payout.qbReconciliationStatus).toBe("conflict_approved");
    expect((await readDeposit(dep)).status).toBe("approved");
    expect((await readGift(gift)).archivedAt).toBeNull();
  });

  it("REVERT confirmed_replace: refused once a payout charge is booked", async () => {
    const { po, gift } = await seedConflict();
    await confirm.confirmReplaceApprovedQbGift({ payoutId: po, userId: USER_ID });
    // Operator books a granular Stripe charge into a gift.
    const chargeGift = await seedGift();
    await seedCharge(po, { status: "approved", createdGiftId: chargeGift });

    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("charges_already_booked");

    // The replace stays intact: old gift still archived, payout still replace.
    expect((await readPayout(po)).qbReconciliationStatus).toBe("confirmed_replace");
    expect((await readGift(gift)).archivedAt).not.toBeNull();
  });

  it("REVERT: rejects a payout with nothing to revert", async () => {
    const po = await seedPayout({ status: "unmatched" });
    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_transition");
  });
});
