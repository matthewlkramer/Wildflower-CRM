import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { confirmSettlementLink } from "../lib/settlementWriter";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `cards_ledger_user_${Date.now()}`,
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

const RUN = `cards_ledger_${Date.now()}`;
const MARKER = `${RUN}_stripe_deposit`;
const ORG_ID = `${RUN}_org`;
const GIFT_ID = `${RUN}_stale_gift`;
const STAGED_ID = `${RUN}_staged`;
const PAYOUT_ID = `${RUN}_payout`;
const CHARGE_ID = `${RUN}_charge`;
const SETTLEMENT_ID = `sl_${PAYOUT_ID}`;

let schema: typeof import("@workspace/db");
let db: typeof import("@workspace/db").db;
let eqFn: typeof import("drizzle-orm").eq;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = schema.db;
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Cards Ledger Org ${RUN}`,
  });
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    amount: "156.48",
    organizationId: ORG_ID,
    dateReceived: "2026-07-01",
    details: "Deliberately stale legacy Stripe pointer target",
  });
  await db.insert(schema.stagedPayments).values({
    id: STAGED_ID,
    realmId: `${RUN}_realm`,
    qbEntityType: "deposit",
    qbEntityId: `${RUN}_qb_deposit`,
    amount: "148.90",
    dateReceived: "2026-07-01",
    payerName: MARKER,
    matchStatus: "unmatched",
  });
  await db.insert(schema.stripePayouts).values({
    id: PAYOUT_ID,
    stripeAccountId: `${RUN}_acct`,
    amount: "148.90",
    grossTotal: "156.48",
    feeTotal: "7.58",
    netTotal: "148.90",
    chargeCount: 1,
    arrivalDate: "2026-07-01",
  });
  await db.insert(schema.stripeStagedCharges).values({
    id: CHARGE_ID,
    stripeAccountId: `${RUN}_acct`,
    stripePayoutId: PAYOUT_ID,
    grossAmount: "156.48",
    feeAmount: "7.58",
    netAmount: "148.90",
    dateReceived: "2026-07-01",
    payerName: "Correct Charge Donor",
    matchStatus: "matched",
    organizationId: ORG_ID,
    // This pointer is deliberately stale. There is no payment_application.
    matchedGiftId: GIFT_ID,
  });

  const settlement = confirmSettlementLink({
    depositStagedPaymentId: STAGED_ID,
    conflictGiftId: null,
    confirmedByUserId: TEST_USER_ID,
    confirmedAt: new Date(),
  });
  await db.insert(schema.settlementLinks).values({
    id: SETTLEMENT_ID,
    payoutId: PAYOUT_ID,
    depositStagedPaymentId: settlement.depositStagedPaymentId,
    conflictGiftId: settlement.conflictGiftId,
    lifecycle: settlement.lifecycle,
    provenance: settlement.provenance,
    confirmedByUserId: settlement.confirmedByUserId,
    confirmedAt: settlement.confirmedAt,
  });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));

  await db
    .delete(schema.settlementLinks)
    .where(eqFn(schema.settlementLinks.id, SETTLEMENT_ID));
  await db
    .delete(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, CHARGE_ID));
  await db
    .delete(schema.stripePayouts)
    .where(eqFn(schema.stripePayouts.id, PAYOUT_ID));
  await db
    .delete(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, STAGED_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("ledger-authoritative reconciliation cards", () => {
  it("does not let a stale Stripe pointer hide an unresolved charge", async () => {
    const response = await fetch(
      `${baseUrl}/api/reconciliation/cards?queue=all&q=${encodeURIComponent(MARKER)}`,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: Array<{
        stagedPaymentId: string;
        stripeChargeId: string | null;
        resolvedGiftId: string | null;
        stripeChargeDonorName: string | null;
      }>;
    };

    const card = payload.data.find(
      (row) =>
        row.stagedPaymentId === STAGED_ID && row.stripeChargeId === CHARGE_ID,
    );
    expect(card).toBeDefined();
    expect(card?.resolvedGiftId).toBeNull();
    expect(card?.stripeChargeDonorName).toBe("Cards Ledger Org " + RUN);
  });
});
