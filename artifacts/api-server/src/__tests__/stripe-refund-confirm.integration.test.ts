import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-backed coverage for confirmRefundPropagation — the transaction-level
 * refund confirm (workbench-business-rules §2.1).
 *
 * The money-safety contract under test:
 *   - confirming a full refund / chargeback NEVER archives or resizes the
 *     linked gift — it demotes the charge's counted payment_applications row
 *     to `corroborating` (audit crumb retained, out of live coverage),
 *   - confirming a partial refund caps the counted amount_applied at what
 *     actually stayed (gross − amount_refunded), gift untouched,
 *   - a partial refund that consumes the whole charge demotes entirely,
 *   - a second confirm of the same charge returns `not_proposed` (the route
 *     maps this to 409),
 *   - dismiss touches neither the ledger nor the gift.
 *
 * Runs real production SQL against the dev DB; skips without a real
 * DATABASE_URL. Seeds use far-future dates + a unique run prefix.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `refconf_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const ORG_ID = `${RUN}_org`;
const ACCOUNT_ID = `${RUN}_acct`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  paymentApplications: Db["paymentApplications"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let confirmRefundPropagation: (typeof import("../lib/stripeRefund"))["confirmRefundPropagation"];
let dismissRefundPropagation: (typeof import("../lib/stripeRefund"))["dismissRefundPropagation"];

const giftIds: string[] = [];
const chargeIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedGift(amount = "100.00"): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    organizationId: ORG_ID,
    ownerUserId: USER_ID,
    amount,
    dateReceived: "2099-10-01",
  });
  giftIds.push(id);
  return id;
}

async function seedChargeWithProposal(opts: {
  giftId: string;
  kind: "full_refund" | "partial_refund" | "chargeback";
  grossAmount?: string;
  amountRefunded?: string;
  amountApplied?: string;
}): Promise<string> {
  const id = nextId("ch");
  const gross = opts.grossAmount ?? "100.00";
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    grossAmount: gross,
    feeAmount: "3.20",
    netAmount: "96.80",
    amountRefunded: opts.amountRefunded ?? gross,
    refunded: opts.kind !== "chargeback",
    disputed: opts.kind === "chargeback",
    dateReceived: "2099-10-02",
    payerName: `Zztest Refund Confirm ${RUN}`,
    refundPropagationStatus: "proposed" as never,
    refundPropagationKind: opts.kind as never,
    refundPropagationGiftId: opts.giftId,
    refundProposedAmount: opts.amountRefunded ?? gross,
  });
  chargeIds.push(id);
  await db.insert(schema.paymentApplications).values({
    id: nextId("pa"),
    giftId: opts.giftId,
    amountApplied: opts.amountApplied ?? gross,
    evidenceSource: "stripe",
    stripeChargeId: id,
    matchMethod: "human",
    confirmedAt: new Date(),
    createdTheGift: false,
  });
  return id;
}

async function giftRow(giftId: string) {
  const [row] = await db
    .select({
      amount: schema.giftsAndPayments.amount,
      archivedAt: schema.giftsAndPayments.archivedAt,
    })
    .from(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, giftId));
  return row;
}

async function ledgerRowsForCharge(chargeId: string) {
  return db
    .select({
      linkRole: schema.paymentApplications.linkRole,
      amountApplied: schema.paymentApplications.amountApplied,
      note: schema.paymentApplications.note,
    })
    .from(schema.paymentApplications)
    .where(
      andFn(
        eqFn(schema.paymentApplications.stripeChargeId, chargeId),
        eqFn(schema.paymentApplications.evidenceSource, "stripe"),
      ),
    );
}

async function chargeStatus(chargeId: string): Promise<string | null> {
  const [row] = await db
    .select({ status: schema.stripeStagedCharges.refundPropagationStatus })
    .from(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, chargeId));
  return row?.status ?? null;
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
    stripeStagedCharges: dbMod.stripeStagedCharges,
    paymentApplications: dbMod.paymentApplications,
  };
  eqFn = drizzle.eq;
  andFn = drizzle.and;
  inArrayFn = drizzle.inArray;
  const refundMod = await import("../lib/stripeRefund");
  confirmRefundPropagation = refundMod.confirmRefundPropagation;
  dismissRefundPropagation = refundMod.dismissRefundPropagation;

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db
    .insert(schema.organizations)
    .values({ id: ORG_ID, name: `Zztest Refund Confirm Org ${RUN}` });
}, 60_000);

afterAll(async () => {
  if (!HAS_DB || !db) return;
  if (chargeIds.length)
    await db
      .delete(schema.paymentApplications)
      .where(inArrayFn(schema.paymentApplications.stripeChargeId, chargeIds));
  if (giftIds.length)
    await db
      .delete(schema.paymentApplications)
      .where(inArrayFn(schema.paymentApplications.giftId, giftIds));
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)(
  "confirmRefundPropagation (transaction-level, §2.1)",
  () => {
    it("full refund: gift untouched, counted row demoted to corroborating", async () => {
      const giftId = await seedGift("100.00");
      const chargeId = await seedChargeWithProposal({
        giftId,
        kind: "full_refund",
      });

      const res = await confirmRefundPropagation(chargeId, USER_ID);
      expect(res.code).toBe("ok");
      expect(res.retiredFromCoverage).toBe(true);
      expect(res.remainingApplied).toBeNull();

      const gift = await giftRow(giftId);
      expect(gift.archivedAt).toBeNull();
      expect(gift.amount).toBe("100.00");

      const rows = await ledgerRowsForCharge(chargeId);
      expect(rows).toHaveLength(1);
      expect(rows[0].linkRole).toBe("corroborating");
      expect(rows[0].amountApplied).toBe("100.00");
      expect(rows[0].note).toContain("Retired from live coverage");

      expect(await chargeStatus(chargeId)).toBe("applied");
    });

    it("chargeback: gift untouched, counted row demoted", async () => {
      const giftId = await seedGift("250.00");
      const chargeId = await seedChargeWithProposal({
        giftId,
        kind: "chargeback",
        grossAmount: "250.00",
        amountApplied: "250.00",
      });

      const res = await confirmRefundPropagation(chargeId, USER_ID);
      expect(res.code).toBe("ok");
      expect(res.retiredFromCoverage).toBe(true);

      const gift = await giftRow(giftId);
      expect(gift.archivedAt).toBeNull();
      expect(gift.amount).toBe("250.00");

      const rows = await ledgerRowsForCharge(chargeId);
      expect(rows).toHaveLength(1);
      expect(rows[0].linkRole).toBe("corroborating");
    });

    it("partial refund: counted amount capped at gross − refunded, gift amount unchanged", async () => {
      const giftId = await seedGift("100.00");
      const chargeId = await seedChargeWithProposal({
        giftId,
        kind: "partial_refund",
        grossAmount: "100.00",
        amountRefunded: "30.00",
        amountApplied: "100.00",
      });

      const res = await confirmRefundPropagation(chargeId, USER_ID);
      expect(res.code).toBe("ok");
      expect(res.retiredFromCoverage).toBe(false);
      expect(res.remainingApplied).toBe("70.00");

      const gift = await giftRow(giftId);
      expect(gift.archivedAt).toBeNull();
      expect(gift.amount).toBe("100.00");

      const rows = await ledgerRowsForCharge(chargeId);
      expect(rows).toHaveLength(1);
      expect(rows[0].linkRole).toBe("counted");
      expect(rows[0].amountApplied).toBe("70.00");
    });

    it("partial refund consuming the whole charge demotes entirely", async () => {
      const giftId = await seedGift("100.00");
      const chargeId = await seedChargeWithProposal({
        giftId,
        kind: "partial_refund",
        grossAmount: "100.00",
        amountRefunded: "100.00",
      });

      const res = await confirmRefundPropagation(chargeId, USER_ID);
      expect(res.code).toBe("ok");
      expect(res.retiredFromCoverage).toBe(true);
      expect(res.remainingApplied).toBeNull();

      const rows = await ledgerRowsForCharge(chargeId);
      expect(rows).toHaveLength(1);
      expect(rows[0].linkRole).toBe("corroborating");
      expect((await giftRow(giftId)).amount).toBe("100.00");
    });

    it("partial refund with counted amount already below the cap is left as-is", async () => {
      const giftId = await seedGift("100.00");
      const chargeId = await seedChargeWithProposal({
        giftId,
        kind: "partial_refund",
        grossAmount: "100.00",
        amountRefunded: "30.00",
        amountApplied: "50.00",
      });

      const res = await confirmRefundPropagation(chargeId, USER_ID);
      expect(res.code).toBe("ok");
      expect(res.remainingApplied).toBe("50.00");

      const rows = await ledgerRowsForCharge(chargeId);
      expect(rows[0].linkRole).toBe("counted");
      expect(rows[0].amountApplied).toBe("50.00");
    });

    it("re-confirming an applied charge returns not_proposed", async () => {
      const giftId = await seedGift();
      const chargeId = await seedChargeWithProposal({
        giftId,
        kind: "full_refund",
      });
      expect((await confirmRefundPropagation(chargeId, USER_ID)).code).toBe(
        "ok",
      );
      expect((await confirmRefundPropagation(chargeId, USER_ID)).code).toBe(
        "not_proposed",
      );
    });

    it("dismiss leaves the ledger and gift untouched", async () => {
      const giftId = await seedGift("80.00");
      const chargeId = await seedChargeWithProposal({
        giftId,
        kind: "full_refund",
        grossAmount: "80.00",
        amountApplied: "80.00",
      });

      const res = await dismissRefundPropagation(chargeId, USER_ID);
      expect(res.code).toBe("ok");

      const rows = await ledgerRowsForCharge(chargeId);
      expect(rows).toHaveLength(1);
      expect(rows[0].linkRole).toBe("counted");
      expect(rows[0].amountApplied).toBe("80.00");
      expect((await giftRow(giftId)).amount).toBe("80.00");
      expect(await chargeStatus(chargeId)).toBe("dismissed");
    });

    it("unknown charge returns not_found", async () => {
      const res = await confirmRefundPropagation(`${RUN}_missing`, USER_ID);
      expect(res.code).toBe("not_found");
    });
  },
);
