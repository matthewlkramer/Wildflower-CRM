import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { clearPaymentApplicationsForGiftIds } from "./paymentApplicationsTestUtil";

/**
 * Regression for pointer retirement: a stale legacy matched_gift_id must never
 * redirect a refund away from the confirmed payment_applications owner.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `refund_ledger_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const ORG_ID = `${RUN}_org`;
const LEDGER_GIFT_ID = `${RUN}_ledger_gift`;
const STALE_GIFT_ID = `${RUN}_stale_gift`;
const CHARGE_ID = `${RUN}_charge`;
const allocationIds = [`${RUN}_alloc_ledger`, `${RUN}_alloc_stale`];

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  paymentApplications: Db["paymentApplications"];
};

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    paymentApplications: dbMod.paymentApplications,
  };

  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({ id: ORG_ID, name: RUN });

  await db.insert(schema.giftsAndPayments).values([
    {
      id: LEDGER_GIFT_ID,
      amount: "80.00",
      organizationId: ORG_ID,
      dateReceived: "2026-07-01",
      details: "confirmed ledger owner",
    },
    {
      id: STALE_GIFT_ID,
      amount: "80.00",
      organizationId: ORG_ID,
      dateReceived: "2026-07-01",
      details: "stale pointer target",
    },
  ]);
  await db.insert(schema.giftAllocations).values([
    {
      id: allocationIds[0],
      giftId: LEDGER_GIFT_ID,
      subAmount: "80.00",
    },
    {
      id: allocationIds[1],
      giftId: STALE_GIFT_ID,
      subAmount: "80.00",
    },
  ]);

  await db.insert(schema.stripeStagedCharges).values({
    id: CHARGE_ID,
    grossAmount: "100.00",
    amountRefunded: "20.00",
    refunded: true,
    disputed: false,
    payerName: "Refund Ledger Test",
    dateReceived: "2026-07-01",
    organizationId: ORG_ID,
    // Deliberately wrong legacy pointer.
    matchedGiftId: STALE_GIFT_ID,
    matchStatus: "matched",
    refundPropagationStatus: "proposed",
    refundPropagationKind: "partial_refund",
    refundProposedAmount: "20.00",
  });

  await db.insert(schema.paymentApplications).values({
    id: `${RUN}_application`,
    giftId: LEDGER_GIFT_ID,
    evidenceSource: "stripe",
    stripeChargeId: CHARGE_ID,
    amountApplied: "100.00",
    matchMethod: "human",
    linkRole: "counted",
    lifecycle: "confirmed",
    confirmedByUserId: USER_ID,
    confirmedAt: new Date(),
    createdTheGift: false,
  });
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await clearPaymentApplicationsForGiftIds([LEDGER_GIFT_ID, STALE_GIFT_ID]);
  await db
    .delete(schema.stripeStagedCharges)
    .where(eq(schema.stripeStagedCharges.id, CHARGE_ID));
  await db
    .delete(schema.giftAllocations)
    .where(inArray(schema.giftAllocations.id, allocationIds));
  await db
    .delete(schema.giftsAndPayments)
    .where(
      inArray(schema.giftsAndPayments.id, [LEDGER_GIFT_ID, STALE_GIFT_ID]),
    );
  await db.delete(schema.organizations).where(eq(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("Stripe refund ledger ownership", () => {
  it("reduces the confirmed ledger gift and ignores the stale pointer gift", async () => {
    const { confirmRefundPropagation } = await import("../lib/stripeRefund");
    const result = await confirmRefundPropagation(CHARGE_ID, USER_ID);

    expect(result.code).toBe("ok");
    expect(result.giftId).toBe(LEDGER_GIFT_ID);
    expect(result.newGiftAmount).toBe("80.00");

    const gifts = await db
      .select({
        id: schema.giftsAndPayments.id,
        amount: schema.giftsAndPayments.amount,
      })
      .from(schema.giftsAndPayments)
      .where(
        inArray(schema.giftsAndPayments.id, [LEDGER_GIFT_ID, STALE_GIFT_ID]),
      );
    const byId = new Map(gifts.map((gift) => [gift.id, gift.amount]));
    expect(byId.get(LEDGER_GIFT_ID)).toBe("80.00");
    expect(byId.get(STALE_GIFT_ID)).toBe("80.00");

    const [charge] = await db
      .select({
        status: schema.stripeStagedCharges.refundPropagationStatus,
        auditGiftId: schema.stripeStagedCharges.refundPropagationGiftId,
        legacyGiftId: schema.stripeStagedCharges.matchedGiftId,
      })
      .from(schema.stripeStagedCharges)
      .where(
        and(
          eq(schema.stripeStagedCharges.id, CHARGE_ID),
          eq(schema.stripeStagedCharges.refundPropagationStatus, "applied"),
        ),
      );
    expect(charge.status).toBe("applied");
    expect(charge.auditGiftId).toBe(LEDGER_GIFT_ID);
    expect(charge.legacyGiftId).toBe(STALE_GIFT_ID);
  });
});
