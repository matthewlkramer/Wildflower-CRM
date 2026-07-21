import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearPaymentApplicationsForStagedIds } from "./paymentApplicationsTestUtil";
import {
  payoutStatusFromLink,
  type SettlementLinkFields,
} from "../lib/settlementLink";
import { proposeSettlementLink } from "../lib/settlementWriter";
import { stagedStatusSql } from "../lib/derivedStatus";
import { getTableColumns } from "drizzle-orm";

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
  /** Bank amount override — negative models a Stripe withdrawal. */
  amount?: string;
  netTotal?: string | null;
}): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: over.amount ?? "1000.00",
    netTotal: over.netTotal === undefined ? "1000.00" : over.netTotal,
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

// The gift link is a counted QB `payment_applications` ledger row (the legacy
// matched/created pointer columns are @deprecated and never written).
// `createdGiftId` models a mint (created_the_gift:true).
async function seedDeposit(over: {
  createdGiftId?: string | null;
  matchedGiftId?: string | null;
  autoApplied?: boolean;
  exclusionReason?: "other" | null;
  // QB booking type. Defaults to 'deposit' (the classic Stripe lump); pass
  // 'payment' to model a bookkeeper mis-typed net lump or a donor payment row.
  qbEntityType?: "deposit" | "payment" | "sales_receipt";
  payerName?: string | null;
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: over.qbEntityType ?? "deposit",
    qbEntityId: nextId("qbe"),
    amount: "1000.00",
    dateReceived: "2026-03-15",
    payerName: over.payerName === undefined ? "Stripe" : over.payerName,
    autoApplied: over.autoApplied ?? false,
    exclusionReason: over.exclusionReason ?? null,
  });
  const linkedGiftId = over.createdGiftId ?? over.matchedGiftId;
  if (linkedGiftId) {
    await db.insert(schema.paymentApplications).values({
      id: nextId("pa"),
      paymentId: id,
      giftId: linkedGiftId,
      amountApplied: "1000.00",
      evidenceSource: "quickbooks",
      matchMethod: "system",
      createdTheGift: !!over.createdGiftId,
    });
  }
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

/** Seed a fully-wired conflict_approved payout: a deposit already booked into
 * a gift (derives match_confirmed), its settlement link proposed with the
 * conflict gift. Mirrors the proposal pass's conflict output. */
async function seedConflict(): Promise<{ po: string; dep: string; gift: string }> {
  const gift = await seedGift();
  const dep = await seedDeposit({ createdGiftId: gift });
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
    const dep = await seedDeposit({});
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

    // D4: the deposit becomes permanent EVIDENCE — the confirmed settlement
    // link derives `match_confirmed`, NOT excluded with a processor_payout
    // reason.
    const deposit = await readDeposit(dep);
    expect(deposit.status).toBe("match_confirmed");
    expect(deposit.exclusionReason).toBeNull();
  });

  it("CONFIRM (mis-typed 'payment' lump, Misc Customer): confirms + reverts like a deposit", async () => {
    // The stuck-card shape: the bookkeeper booked the Stripe net lump as a
    // generic 'payment' row with a placeholder payer. The shared lump predicate
    // (settlementLump.ts) makes it confirmable exactly like a deposit-typed
    // lump, and revert round-trips it back to pending.
    const dep = await seedDeposit({
      qbEntityType: "payment",
      payerName: "Misc Customer",
    });
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });

    const c = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.kind).toBe("confirmed_reconciled");
    expect(payoutStatusFromLink((await readLink(po)) ?? null)).toBe(
      "confirmed_reconciled",
    );
    expect((await readDeposit(dep)).status).toBe("match_confirmed");

    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    expect(payoutStatusFromLink((await readLink(po)) ?? null)).toBe("proposed");
    expect((await readDeposit(dep)).status).toBe("pending");
  });

  it("CONFIRM (donor-name 'payment' row, NOT a lump): permanent deposit_unconfirmable, nothing mutated", async () => {
    const dep = await seedDeposit({
      qbEntityType: "payment",
      payerName: "Jane Donor",
    });
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });

    const r = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("deposit_unconfirmable");

    // Nothing changed: link still proposed, row still pending.
    expect(payoutStatusFromLink((await readLink(po)) ?? null)).toBe("proposed");
    expect((await readDeposit(dep)).status).toBe("pending");
  });

  it("CONFIRM (deposit resolved elsewhere — excluded): permanent deposit_unconfirmable, nothing mutated", async () => {
    const dep = await seedDeposit({ exclusionReason: "other" });
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });

    const r = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("deposit_unconfirmable");

    expect(payoutStatusFromLink((await readLink(po)) ?? null)).toBe("proposed");
    expect((await readDeposit(dep)).status).toBe("excluded");
  });

  it("CONFIRM (SPLIT deposit, counted ledger rows): linkage-only confirm, deposit untouched", async () => {
    // The endless-loop shape: a legacy split left the deposit with all 3
    // gift-link columns null but counted payment_applications rows (which
    // derive match_confirmed).
    const gift = await seedGift();
    const dep = await seedDeposit({});
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

    // The already-booked deposit is NEVER touched — stays match_confirmed.
    expect((await readDeposit(dep)).status).toBe("match_confirmed");
  });

  it("CONFIRM (booked deposit, gift-link column): linkage-only confirm, deposit untouched", async () => {
    const gift = await seedGift();
    const dep = await seedDeposit({ createdGiftId: gift });
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });

    const r = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("confirmed_linkage_only");
    expect(payoutStatusFromLink((await readLink(po)) ?? null)).toBe(
      "confirmed_reconciled",
    );
    expect((await readDeposit(dep)).status).toBe("match_confirmed");
  });

  it("CONFIRM (unreviewed auto-match — match_proposed): permanent deposit_unconfirmable, nothing mutated", async () => {
    // An auto-applied match a human never reviewed derives match_proposed —
    // it was claimed by the worker, so this settlement can't swallow it.
    const gift = await seedGift();
    const dep = await seedDeposit({ autoApplied: true, matchedGiftId: gift });
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });

    const r = await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("deposit_unconfirmable");

    // Nothing changed: link still proposed, deposit still match_proposed.
    expect(payoutStatusFromLink((await readLink(po)) ?? null)).toBe("proposed");
    expect((await readDeposit(dep)).status).toBe("match_proposed");
  });

  it("REVERT of a linkage-only confirm → proposed, deposit stays booked (never flipped to pending)", async () => {
    const gift = await seedGift();
    const dep = await seedDeposit({});
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
    // The revert must NOT flip the still-booked deposit to pending — its
    // counted ledger rows keep deriving match_confirmed.
    expect((await readDeposit(dep)).status).toBe("match_confirmed");
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

    // Touches nothing else: deposit stays booked, gift stays active.
    expect((await readDeposit(dep)).status).toBe("match_confirmed");
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
    expect(deposit.status).toBe("match_confirmed");
    expect(deposit.exclusionReason).toBeNull();
    expect((await readGift(gift)).archivedAt).toBeNull();
  });

  it("REVERT confirmed_reconciled (pending-deposit confirm) → proposed, deposit pending again", async () => {
    const dep = await seedDeposit({});
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });
    await confirm.confirmPendingQbDeposit({ payoutId: po, userId: USER_ID });

    const r = await confirm.revertPayoutQbConfirmation({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);

    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("proposed");
    expect(link?.depositStagedPaymentId).toBe(dep);
    expect(link?.conflictGiftId).toBeNull();
    expect(link?.confirmedByUserId).toBeNull();
    // The deposit reverts from confirmed evidence back to derived `pending`
    // (the confirmed settlement link — its only booking fact — is gone).
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
    expect((await readDeposit(dep)).status).toBe("match_confirmed");
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

// ── Withdrawal resolution (negative payouts → exempt settlement link) ──────
//
// A NEGATIVE payout is money pulled BACK to Stripe — no QB deposit will ever
// exist, so a human resolves it as exempt (deposit-less settlement link,
// allowed only for lifecycle='exempt' by settlement_links_deposit_required_chk).
describe.skipIf(!HAS_DB)("withdrawal resolution (DB)", () => {
  it("RESOLVE: negative payout → exempt link (no deposit, human provenance)", async () => {
    const po = await seedPayout({ amount: "-256.00", netTotal: "-256.00" });
    const r = await confirm.resolvePayoutAsWithdrawal({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("resolved_withdrawal");
    const link = await readLink(po);
    expect(link?.lifecycle).toBe("exempt");
    expect(link?.depositStagedPaymentId).toBeNull();
    expect(link?.conflictGiftId).toBeNull();
    expect(link?.provenance).toBe("human");
    expect(link?.confirmedByUserId).toBe(USER_ID);
  });

  it("RESOLVE is idempotent on an already-exempt payout", async () => {
    const po = await seedPayout({ amount: "-0.45", netTotal: "-0.45" });
    const first = await confirm.resolvePayoutAsWithdrawal({ payoutId: po, userId: USER_ID });
    expect(first.ok).toBe(true);
    const again = await confirm.resolvePayoutAsWithdrawal({ payoutId: po, userId: USER_ID });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.kind).toBe("resolved_withdrawal");
    expect((await readLink(po))?.lifecycle).toBe("exempt");
  });

  it("RESOLVE: rejects a positive payout", async () => {
    const po = await seedPayout({});
    const r = await confirm.resolvePayoutAsWithdrawal({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_transition");
  });

  it("RESOLVE: rejects when a proposed/confirmed settlement link exists", async () => {
    const dep = await seedDeposit({});
    const po = await seedPayout({
      amount: "-10.00",
      netTotal: "-10.00",
      link: proposeSettlementLink(dep, null),
    });
    const r = await confirm.resolvePayoutAsWithdrawal({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_transition");
    // The existing proposal was NOT clobbered.
    expect((await readLink(po))?.lifecycle).toBe("proposed");
  });

  it("REVERT WITHDRAWAL: exempt link deleted → payout back to unlinked", async () => {
    const po = await seedPayout({ amount: "-1023.21", netTotal: "-1023.21" });
    await confirm.resolvePayoutAsWithdrawal({ payoutId: po, userId: USER_ID });
    const r = await confirm.revertWithdrawalResolution({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(true);
    expect(await readLink(po)).toBeUndefined();
  });

  it("REVERT WITHDRAWAL: rejects when the link is not exempt", async () => {
    const dep = await seedDeposit({});
    const po = await seedPayout({ link: proposeSettlementLink(dep, null) });
    const r = await confirm.revertWithdrawalResolution({ payoutId: po, userId: USER_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_transition");
    expect((await readLink(po))?.lifecycle).toBe("proposed");
  });
});
