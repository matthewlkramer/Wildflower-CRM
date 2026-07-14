import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearPaymentApplicationsForStagedIds } from "./paymentApplicationsTestUtil";
import {
  payoutStatusFromLink,
  type SettlementLinkFields,
} from "../lib/settlementLink";
import {
  proposeSettlementLink,
  confirmSettlementLink,
} from "../lib/settlementWriter";

/**
 * DB-backed coverage for the Stripe payout ↔ QuickBooks deposit proposal pass
 * (`runProposalPass`). Unlike the pure scoring unit test, this exercises the
 * real candidate query + idempotent proposal writes against dev Postgres so it
 * can assert the actual settlement_links state transitions:
 *   - best eligible deposit proposed (link lifecycle 'proposed', deposit set),
 *   - re-running is idempotent (no churn),
 *   - an APPROVED deposit already booked into a gift becomes conflict_approved
 *     (a 'proposed' link carrying a conflict gift),
 *   - a deposit already CONFIRMED-linked to another payout is never re-proposed,
 *   - a stale proposal clears back to unmatched (link deleted) when its
 *     candidate disappears,
 *   - confirmed payouts are left untouched,
 *   - one deposit is never assigned to two payouts in a single pass.
 *
 * `settlement_links` is the authoritative reconciliation store (the legacy
 * `stripe_payouts.qb_reconciliation_status` + pointer mirror columns have been
 * dropped), so fixtures seed a link row and assertions read it back.
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
  settlementLinks: Db["settlementLinks"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  organizations: Db["organizations"];
  paymentApplications: Db["paymentApplications"];
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
  // Number of charges rolled into the payout. Omitted/null = single-charge
  // (conservative default), which routes to charge grain (no mis-typed-lump tie).
  chargeCount?: number | null;
  // Settlement-link intent to seed alongside the payout. `null`/omitted = an
  // `unmatched` payout (no link row); a built link (proposeSettlementLink /
  // confirmSettlementLink) seeds the authoritative reconciliation state.
  link?: SettlementLinkFields | null;
}): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: over.amount,
    netTotal: over.amount,
    arrivalDate: over.arrivalDate,
    chargeCount: over.chargeCount ?? null,
  });
  payoutIds.push(id);
  // FK cascade on payout_id cleans the link up when the payout is deleted in
  // afterAll.
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
  amount: string;
  dateReceived: string;
  payerName?: string | null;
  // QB booking type. Defaults to 'deposit' (the classic Stripe lump); pass
  // 'payment' to model the dominant real-world shape (a donor-name payment row).
  qbEntityType?: "deposit" | "payment" | "sales_receipt";
  /** Set to derive `excluded` (exclusion_reason IS NOT NULL wins the CASE). */
  exclusionReason?: "other_revenue" | null;
  /**
   * Model a mint: a counted QB `payment_applications` ledger row with
   * created_the_gift:true (the legacy pointer column is @deprecated and never
   * written).
   */
  createdGiftId?: string | null;
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: over.qbEntityType ?? "deposit",
    qbEntityId: nextId("qbe"),
    amount: over.amount,
    dateReceived: over.dateReceived,
    payerName: over.payerName === undefined ? "Stripe" : over.payerName,
    exclusionReason: over.exclusionReason ?? null,
  });
  if (over.createdGiftId) {
    await db.insert(schema.paymentApplications).values({
      id: nextId("pa"),
      paymentId: id,
      giftId: over.createdGiftId,
      amountApplied: over.amount,
      evidenceSource: "quickbooks",
      matchMethod: "system",
      createdTheGift: true,
    });
  }
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

async function readLink(payoutId: string) {
  const [row] = await db
    .select()
    .from(schema.settlementLinks)
    .where(eqFn(schema.settlementLinks.payoutId, payoutId));
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
    settlementLinks: dbMod.settlementLinks,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    organizations: dbMod.organizations,
    paymentApplications: dbMod.paymentApplications,
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

    let link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("proposed");
    expect(link?.depositStagedPaymentId).toBe(dep);
    expect(link?.conflictGiftId).toBeNull();

    // Re-run: still proposed to the same deposit (idempotent).
    const second = await runProposalPass([po]);
    expect(second.proposed).toBe(1);
    link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("proposed");
    expect(link?.depositStagedPaymentId).toBe(dep);
  });

  it("proposes a donor-name 'payment' lump for a MULTI-charge payout", async () => {
    // The dominant real-world shape: the payout was booked in QB as a single
    // donor-name 'payment' row (NOT a 'deposit'), payer contains a generic
    // "misc" marker. A multi-charge payout is a genuine lump, so the broadened
    // candidate query must reach it and propose the payout↔lump tie.
    const po = await seedPayout({
      amount: "7373.73",
      arrivalDate: "2026-03-20",
      chargeCount: 4,
    });
    const dep = await seedDeposit({
      amount: "7373.73",
      dateReceived: "2026-03-20",
      qbEntityType: "payment",
      payerName: "Misc Customer",
    });

    const r = await runProposalPass([po]);
    expect(r.proposed).toBe(1);

    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("proposed");
    expect(link?.depositStagedPaymentId).toBe(dep);
  });

  it("does NOT tie a single-charge payout to a 'payment' lump (charge grain instead)", async () => {
    // A single-charge payout is one donation; its QB counterpart is an
    // individual donor 'payment' matched at the charge grain, never a
    // payout↔deposit lump tie. The single-charge gate must skip the non-deposit
    // candidate so we don't double-book the same dollars.
    const po = await seedPayout({
      amount: "6262.62",
      arrivalDate: "2026-03-25",
      chargeCount: 1,
    });
    await seedDeposit({
      amount: "6262.62",
      dateReceived: "2026-03-25",
      qbEntityType: "payment",
      payerName: "Misc Customer",
    });

    const r = await runProposalPass([po]);
    expect(r.proposed).toBe(0);
    const link = await readLink(po);
    expect(link).toBeUndefined();
    expect(payoutStatusFromLink(link ?? null)).toBe("unmatched");
  });

  it("proposes a deposit just outside the OLD ±10-day window but inside the widened one", async () => {
    // Payout on 2026-03-01, matching QB deposit 20 days later — the retired
    // ±10-day window would have missed it; the widened window catches it.
    const po = await seedPayout({ amount: "5959.59", arrivalDate: "2026-03-01" });
    const dep = await seedDeposit({
      amount: "5959.59",
      dateReceived: "2026-03-21",
    });

    const r = await runProposalPass([po]);
    expect(r.proposed).toBe(1);
    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("proposed");
    expect(link?.depositStagedPaymentId).toBe(dep);
  });

  it("flags a conflict when the best deposit is approved + booked into a gift", async () => {
    const gift = await seedGift("8888.88");
    const po = await seedPayout({ amount: "8888.88", arrivalDate: "2026-04-10" });
    const dep = await seedDeposit({
      amount: "8888.88",
      dateReceived: "2026-04-10",
      createdGiftId: gift,
    });

    const r = await runProposalPass([po]);
    expect(r.conflicts).toBe(1);

    const link = await readLink(po);
    expect(payoutStatusFromLink(link ?? null)).toBe("conflict_approved");
    expect(link?.depositStagedPaymentId).toBe(dep);
    expect(link?.conflictGiftId).toBe(gift);
  });

  it("never re-proposes a deposit already confirmed-linked to another payout", async () => {
    const dep = await seedDeposit({ amount: "9999.11", dateReceived: "2026-05-01" });
    // A confirmed payout owns that deposit.
    await seedPayout({
      amount: "9999.11",
      arrivalDate: "2026-05-01",
      link: confirmSettlementLink({
        depositStagedPaymentId: dep,
        conflictGiftId: null,
        confirmedByUserId: null,
        confirmedAt: new Date(),
      }),
    });
    // A second, still-open payout whose only candidate is the taken deposit.
    const po2 = await seedPayout({ amount: "9999.11", arrivalDate: "2026-05-01" });

    const r = await runProposalPass([po2]);
    expect(r.proposed).toBe(0);
    const link = await readLink(po2);
    expect(link).toBeUndefined();
    expect(payoutStatusFromLink(link ?? null)).toBe("unmatched");
  });

  it("clears a stale proposal back to unmatched when no candidate is eligible", async () => {
    // A stale proposed link whose deposit is no longer an eligible candidate
    // (`excluded` is outside the pending/approved/reconciled candidate set), so
    // the pass finds no `best` and must clear the link. In the settlement_links
    // model a `proposed` payout ALWAYS carries a proposed link with a deposit
    // pointer (a null-pointer `proposed` is not representable), so we anchor the
    // stale link on a real-but-ineligible deposit.
    const dep = await seedDeposit({
      amount: "6543.21",
      dateReceived: "2026-06-01",
      exclusionReason: "other_revenue",
    });
    const po = await seedPayout({
      amount: "6543.21",
      arrivalDate: "2026-06-01",
      link: proposeSettlementLink(dep, null),
    });

    const r = await runProposalPass([po]);
    expect(r.cleared).toBe(1);
    const link = await readLink(po);
    expect(link).toBeUndefined();
    expect(payoutStatusFromLink(link ?? null)).toBe("unmatched");
  });

  it("clears a stale conflict proposal (deletes the settlement link)", async () => {
    // A pre-existing conflict_approved proposal is a `proposed` settlement link
    // that ALSO carries a conflict gift. When its deposit is no longer an
    // eligible candidate the pass must clear it by deleting the settlement link,
    // so the link-derived status returns to `unmatched`.
    const gift = await seedGift("3131.31");
    const dep = await seedDeposit({
      amount: "3131.31",
      dateReceived: "2026-09-01",
      // An exclusion reason derives `excluded` (it wins over the gift link),
      // which is outside the candidate set, so the pass takes the clear branch.
      exclusionReason: "other_revenue",
      createdGiftId: gift,
    });
    const po = await seedPayout({
      amount: "3131.31",
      arrivalDate: "2026-09-01",
      link: proposeSettlementLink(dep, gift),
    });

    // Precondition: the fixture really is a conflict.
    const beforeLink = await readLink(po);
    expect(beforeLink?.lifecycle).toBe("proposed");
    expect(beforeLink?.conflictGiftId).toBe(gift);
    expect(payoutStatusFromLink(beforeLink ?? null)).toBe("conflict_approved");

    const r = await runProposalPass([po]);
    expect(r.cleared).toBe(1);

    // The settlement link is gone, so the derived status returns to unmatched.
    const afterLink = await readLink(po);
    expect(afterLink).toBeUndefined();
    expect(payoutStatusFromLink(afterLink ?? null)).toBe("unmatched");
  });

  it("leaves confirmed payouts untouched", async () => {
    const dep = await seedDeposit({ amount: "5151.51", dateReceived: "2026-07-01" });
    const po = await seedPayout({
      amount: "5151.51",
      arrivalDate: "2026-07-01",
      link: confirmSettlementLink({
        depositStagedPaymentId: dep,
        conflictGiftId: null,
        confirmedByUserId: null,
        confirmedAt: new Date(),
      }),
    });

    const r = await runProposalPass([po]);
    expect(r.proposed).toBe(0);
    expect(r.conflicts).toBe(0);
    const link = await readLink(po);
    expect(link?.lifecycle).toBe("confirmed");
    expect(payoutStatusFromLink(link ?? null)).toBe("confirmed_reconciled");
    expect(link?.depositStagedPaymentId).toBe(dep);
  });

  it("never assigns one deposit to two payouts in a single pass", async () => {
    const poA = await seedPayout({ amount: "4242.42", arrivalDate: "2026-08-01" });
    const poB = await seedPayout({ amount: "4242.42", arrivalDate: "2026-08-01" });
    const dep = await seedDeposit({ amount: "4242.42", dateReceived: "2026-08-01" });

    const r = await runProposalPass([poA, poB]);
    expect(r.proposed).toBe(1);

    const linkA = await readLink(poA);
    const linkB = await readLink(poB);
    const proposedTo = [linkA, linkB].filter(
      (x) => payoutStatusFromLink(x ?? null) === "proposed",
    );
    const unmatched = [linkA, linkB].filter(
      (x) => payoutStatusFromLink(x ?? null) === "unmatched",
    );
    expect(proposedTo).toHaveLength(1);
    expect(unmatched).toHaveLength(1);
    expect(proposedTo[0]?.depositStagedPaymentId).toBe(dep);
  });
});
