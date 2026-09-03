import {
  clearPaymentApplicationsForChargeIds,
  unitIdForAnchor,
} from "./paymentApplicationsTestUtil";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-backed coverage for confirmRefundPropagation — the transaction-level
 * refund confirm (workbench-business-rules §2.1).
 *
 * The money-safety contract under test:
 *   - confirming a full refund / chargeback NEVER archives or resizes the
 *     linked gift — it clears the charge unit's counted tie, preserving the
 *     gift link as a unit_gift_corroboration source_link (audit crumb
 *     retained, out of live coverage),
 *   - confirming a partial refund with a surviving remainder keeps the tie
 *     counted (the refunded portion is a charge-level accounting fact),
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
  paymentUnits: Db["paymentUnits"];
  sourceLinks: Db["sourceLinks"];
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
  const unitId = await unitIdForAnchor("stripe", id);
  await db
    .update(schema.paymentUnits)
    .set({
      giftId: opts.giftId,
      giftMatchMethod: "human",
      giftConfirmedAt: new Date(),
      createdTheGift: false,
    })
    .where(eqFn(schema.paymentUnits.id, unitId));
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

/** The charge unit's tie state: a counted unit tie or the retired-coverage
 * corroboration source_link (amount is the unit gross in both). */
async function ledgerRowsForCharge(chargeId: string) {
  const units = await db
    .select({
      id: schema.paymentUnits.id,
      giftId: schema.paymentUnits.giftId,
      grossAmount: schema.paymentUnits.grossAmount,
    })
    .from(schema.paymentUnits)
    .where(eqFn(schema.paymentUnits.stripeChargeId, chargeId));
  const unitIds = units.map((u) => u.id);
  const links = unitIds.length
    ? await db
        .select({
          paymentUnitId: schema.sourceLinks.paymentUnitId,
          note: schema.sourceLinks.note,
        })
        .from(schema.sourceLinks)
        .where(
          andFn(
            eqFn(schema.sourceLinks.linkType, "unit_gift_corroboration"),
            inArrayFn(schema.sourceLinks.paymentUnitId, unitIds),
          ),
        )
    : [];
  const grossByUnit = new Map(units.map((u) => [u.id, u.grossAmount]));
  return [
    ...units.flatMap((u) =>
      u.giftId
        ? [
            {
              linkRole: "counted" as const,
              amountApplied: u.grossAmount,
              note: null as string | null,
            },
          ]
        : [],
    ),
    ...links.map((l) => ({
      linkRole: "corroborating" as const,
      amountApplied: grossByUnit.get(l.paymentUnitId as string) ?? null,
      note: l.note,
    })),
  ];
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
    paymentUnits: dbMod.paymentUnits,
    sourceLinks: dbMod.sourceLinks,
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
  if (chargeIds.length) await clearPaymentApplicationsForChargeIds(chargeIds);
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
      expect(rows[0].linkRole).toBe("counted"); // tie survives the remainder
      // The refunded 30.00 is a charge-level accounting fact
      // (amount_refunded) — the unit's own gross is unchanged.
      expect(rows[0].amountApplied).toBe("100.00");
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
