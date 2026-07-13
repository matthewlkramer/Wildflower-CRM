import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearPaymentApplicationsForStagedIds } from "./paymentApplicationsTestUtil";
import {
  payoutStatusFromLink,
  type SettlementLinkFields,
} from "../lib/settlementLink";
import { proposeSettlementLink } from "../lib/settlementWriter";

/**
 * DB-backed coverage for the D4 human-confirm/revert payout ↔ QuickBooks-deposit
 * transitions (stripeConfirm.ts), where the CRM gift is the single source of
 * truth and QB staged rows are permanent EVIDENCE — never archived, never
 * excluded as processor_payout. Exercises the real guarded UPDATEs against dev
 * Postgres:
 *   - CONFIRM (pending deposit): proposed → confirmed_reconciled; deposit
 *     marked `reconciled` (not excluded), gift untouched,
 *   - CONFIRM (already-booked gift): conflict_approved → confirmed_reconciled;
 *     deposit + gift left untouched,
 *   - REPLACE is RETIRED: returns manual_review_required, mutates nothing,
 *   - REVERT of confirmed_reconciled restores the prior state via the settlement
 *     link's conflictGiftId discriminator (null ⇒ proposed + deposit pending;
 *     set ⇒ conflict_approved + deposit untouched),
 *   - invalid transitions / unknown payout return typed errors.
 *
 * `settlement_links` is the authoritative reconciliation store (the legacy
 * `stripe_payouts.qb_reconciliation_status` + pointer/confirmed-by mirror columns
 * have been dropped), so fixtures seed a link row and assertions read it back.
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
  settlementLinks: Db["settlementLinks"];
  paymentApplications: Db["paymentApplications"];
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
  // Settlement-link intent to seed alongside the payout. `null`/omitted = an
  // `unmatched` payout (no link row); a built link (proposeSettlementLink) seeds
  // the authoritative reconciliation state that confirm/revert read + mutate.
  link?: SettlementLinkFields | null;
}): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: "1000.00",
    netTotal: "1000.00",
    arrivalDate: "2026-03-15",
  });
  payoutIds.push(id);
  // FK cascade on payout_id cleans the link up with the payout in afterAll.
  if (over.link) {
    await db.insert(schema.settlementLinks).values({
      id: `sl_${id}`,
      payoutId: id,
      depositStagedPaymentId: over.link.depositStagedPaymentId,
      conflictGiftId: over.link.conflictGiftId,
      lifecycle: over.link.lifecycle,
      provenance: over.link.provenance,
      confirmedByUserId: over.link.confirmedByUserId,
      confirmedAt: over.link.confirmedAt,
    });
  }
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
async function readLink(payoutId: string) {
  const [row] = await db
    .select()
    .from(schema.settlementLinks)
    .where(eqFn(schema.settlementLinks.payoutId, payoutId));
  return row;
}

/** Seed a counted QB ledger row anchoring `dep`'s money onto `gift` — the
 * legacy-SPLIT bookedness shape (all 3 gift-link columns null; the money trail
 * lives only in payment_applications). Teardown clears these via
 * clearPaymentApplicationsForStagedIds. */
async function seedCountedPa(dep: string, gift: string): Promise<void> {
  await db.insert(schema.paymentApplications).values({
    id: nextId("pa"),
    paymentId: dep,
    giftId: gift,
    amountApplied: "1000.00",
    evidenceSource: "quickbooks",
  });
}

/** Seed a fully-wired conflict_approved payout: approved deposit booked into a
 * gift, its settlement link proposed with the conflict gift. Mirrors the
 * proposal pass's conflict output. */
async function seedConflict(): Promise<{ po: string; dep: string; gift: string }> {
  const gift = await seedGift();
  const dep = await seedDeposit({ status: "approved", createdGiftId: gift });
  const po = await seedPayout({ link: proposeSettlementLink(dep, gift) });
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
    settlementLinks: dbMod.settlementLinks,
    paymentApplications: dbMod.paymentApplications,
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
  await clearPaymentApplicationsForStagedIds(stagedIds);
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
  it("CONFIRM (pending deposit): proposed → confirmed_reconciled, deposit reconciled (not excluded)", async () => {
    const dep = await seedDeposit({ status: "pending" });
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });

    const r = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("confirmed_reconciled");

    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("confirmed_reconciled");
    expect(link?.lifecycle).toBe("confirmed");
    expect(link?.depositStagedPaymentId).toBe(dep);
    expect(link?.conflictGiftId).toBeNull();
    expect(link?.confirmedByUserId).toBe(USER_ID);
    expect(link?.confirmedAt).not.toBeNull();

    // D4: the deposit becomes permanent EVIDENCE — `reconciled`, NOT excluded
    // with a processor_payout reason.
    const deposit = await readDeposit(dep);
    expect(deposit.status).toBe("reconciled");
    expect(deposit.exclusionReason).toBeNull();
  });

  it("CONFIRM (approved SPLIT deposit, counted ledger rows): linkage-only confirm, deposit untouched", async () => {
    // The endless-loop shape: a legacy split left the deposit `approved` with
    // all 3 gift-link columns null but counted payment_applications rows.
    const gift = await seedGift();
    const dep = await seedDeposit({ status: "approved" });
    await seedCountedPa(dep, gift);
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });

    const r = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("confirmed_linkage_only");

    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("confirmed_reconciled");
    expect(link?.lifecycle).toBe("confirmed");
    expect(link?.depositStagedPaymentId).toBe(dep);
    expect(link?.confirmedByUserId).toBe(USER_ID);

    // The already-booked deposit is NEVER touched — stays approved.
    expect((await readDeposit(dep)).status).toBe("approved");
  });

  it("CONFIRM (approved deposit, gift-link column): linkage-only confirm, deposit untouched", async () => {
    const gift = await seedGift();
    const dep = await seedDeposit({ status: "approved", createdGiftId: gift });
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });

    const r = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("confirmed_linkage_only");
    expect(payoutStatusFromLink((await readLink(po)) ?? null)).toBe(
      "confirmed_reconciled",
    );
    expect((await readDeposit(dep)).status).toBe("approved");
  });

  it("CONFIRM (approved deposit, NO provable booking): permanent deposit_not_booked, nothing mutated", async () => {
    const dep = await seedDeposit({ status: "approved" });
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });

    const r = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("deposit_not_booked");

    // Nothing changed: link still proposed, deposit still approved.
    expect(payoutStatusFromLink((await readLink(po)) ?? null)).toBe("proposed");
    expect((await readDeposit(dep)).status).toBe("approved");
  });

  it("REVERT of a linkage-only confirm → proposed, deposit stays approved (never flipped to pending)", async () => {
    const gift = await seedGift();
    const dep = await seedDeposit({ status: "approved" });
    await seedCountedPa(dep, gift);
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });
    const c = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(c.ok).toBe(true);

    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);

    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("proposed");
    expect(link?.depositStagedPaymentId).toBe(dep);
    expect(link?.confirmedByUserId).toBeNull();
    // The revert must NOT flip the untouched approved deposit to pending.
    expect((await readDeposit(dep)).status).toBe("approved");
  });

  it("CONFIRM (pending deposit): rejects a payout that is not proposed", async () => {
    const po = await seedPayout({});
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

  it("CONFIRM (already-booked gift): conflict_approved → confirmed_reconciled, deposit + gift untouched", async () => {
    const { po, dep, gift } = await seedConflict();

    const r = await confirm.confirmKeepApprovedQbGift({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("confirmed_reconciled");

    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("confirmed_reconciled");
    expect(link?.depositStagedPaymentId).toBe(dep);
    // The conflict gift pointer is retained as the revert discriminator.
    expect(link?.conflictGiftId).toBe(gift);

    // Touches nothing else: deposit stays approved, gift stays active.
    expect((await readDeposit(dep)).status).toBe("approved");
    expect((await readGift(gift)).archivedAt).toBeNull();
  });

  it("REPLACE is retired: returns manual_review_required and mutates nothing", async () => {
    const { po, dep, gift } = await seedConflict();

    const r = await confirm.confirmReplaceApprovedQbGift({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("manual_review_required");

    // Nothing was changed — the link, deposit, and gift are all intact.
    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("conflict_approved");
    const deposit = await readDeposit(dep);
    expect(deposit.status).toBe("approved");
    expect(deposit.exclusionReason).toBeNull();
    expect((await readGift(gift)).archivedAt).toBeNull();
  });

  it("REVERT confirmed_reconciled (pending-deposit confirm) → proposed, deposit pending again", async () => {
    const dep = await seedDeposit({ status: "pending" });
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });
    await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });

    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);

    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("proposed");
    expect(link?.depositStagedPaymentId).toBe(dep);
    expect(link?.conflictGiftId).toBeNull();
    expect(link?.confirmedByUserId).toBeNull();
    // The deposit reverts from `reconciled` evidence back to `pending`.
    expect((await readDeposit(dep)).status).toBe("pending");
  });

  it("REVERT confirmed_reconciled (already-booked gift) → conflict_approved, deposit untouched", async () => {
    const { po, dep, gift } = await seedConflict();
    await confirm.confirmKeepApprovedQbGift({ payoutId: po, userId: USER_ID });

    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);

    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("conflict_approved");
    expect(link?.depositStagedPaymentId).toBe(dep);
    // The conflictGiftId discriminator routed the revert; deposit + gift intact.
    expect(link?.conflictGiftId).toBe(gift);
    expect((await readDeposit(dep)).status).toBe("approved");
    expect((await readGift(gift)).archivedAt).toBeNull();
  });

  it("REVERT: rejects a payout with nothing to revert", async () => {
    const po = await seedPayout({});
    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_transition");
  });
});
