import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `qbobasis_${Date.now()}`;
const ids = {
  grossPayout: `${RUN}_payout_gross`,
  netPayout: `${RUN}_payout_net`,
  unmatchedPayout: `${RUN}_payout_unmatched`,
  grossPayment: `${RUN}_payment_gross`,
  netPayment: `${RUN}_payment_net`,
  unmatchedPayment: `${RUN}_payment_unmatched`,
};

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stripePayouts: Db["stripePayouts"];
  stagedPayments: Db["stagedPayments"];
  sourceLinks: Db["sourceLinks"];
  qboAccountingChecks: Db["qboAccountingChecks"];
};
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let recompute: typeof import("../lib/qboAccountingRecompute").recomputeQboAccountingChecks;

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    stripePayouts: dbMod.stripePayouts,
    stagedPayments: dbMod.stagedPayments,
    sourceLinks: dbMod.sourceLinks,
    qboAccountingChecks: dbMod.qboAccountingChecks,
  };
  inArrayFn = drizzle.inArray;
  recompute = (await import("../lib/qboAccountingRecompute"))
    .recomputeQboAccountingChecks;

  await db.insert(schema.stripePayouts).values([
    {
      id: ids.grossPayout,
      stripeAccountId: `${RUN}_acct`,
      amount: "142.00",
      netTotal: "142.00",
      grossTotal: "150.00",
      currency: "usd",
      status: "paid",
      arrivalDate: "2099-12-20",
    },
    {
      id: ids.netPayout,
      stripeAccountId: `${RUN}_acct`,
      amount: "47.00",
      netTotal: "47.00",
      grossTotal: "50.00",
      currency: "usd",
      status: "paid",
      arrivalDate: "2099-12-21",
    },
    {
      id: ids.unmatchedPayout,
      stripeAccountId: `${RUN}_acct`,
      amount: "90.00",
      netTotal: "90.00",
      grossTotal: "100.00",
      currency: "usd",
      status: "paid",
      arrivalDate: "2099-12-22",
    },
  ]);

  await db.insert(schema.stagedPayments).values({
    id: ids.grossPayment,
    realmId: `${RUN}_realm`,
    qbEntityType: "deposit",
    qbEntityId: ids.grossPayment,
    amount: "150.00",
    dateReceived: "2099-12-20",
    fundingSource: "stripe",
  });
  await db.insert(schema.stagedPayments).values({
    id: ids.netPayment,
    realmId: `${RUN}_realm`,
    qbEntityType: "deposit",
    qbEntityId: ids.netPayment,
    amount: "47.00",
    dateReceived: "2099-12-21",
    fundingSource: "stripe",
  });
  await db.insert(schema.stagedPayments).values({
    id: ids.unmatchedPayment,
    realmId: `${RUN}_realm`,
    qbEntityType: "deposit",
    qbEntityId: ids.unmatchedPayment,
    amount: "95.00",
    dateReceived: "2099-12-22",
    fundingSource: "stripe",
  });

  await db.insert(schema.sourceLinks).values([
    {
      id: `srcl_pqs_${ids.grossPayout}`,
      linkType: "payout_qb_settlement",
      qbStagedPaymentId: ids.grossPayment,
      stripePayoutId: ids.grossPayout,
      lifecycle: "confirmed",
      provenance: "system",
      matchBasis: "settled_pairing",
    },
    {
      id: `srcl_pqs_${ids.netPayout}`,
      linkType: "payout_qb_settlement",
      qbStagedPaymentId: ids.netPayment,
      stripePayoutId: ids.netPayout,
      lifecycle: "confirmed",
      provenance: "system",
      matchBasis: "settled_pairing",
    },
    {
      id: `srcl_pqs_${ids.unmatchedPayout}`,
      linkType: "payout_qb_settlement",
      qbStagedPaymentId: ids.unmatchedPayment,
      stripePayoutId: ids.unmatchedPayout,
      lifecycle: "confirmed",
      provenance: "system",
      matchBasis: "settled_pairing",
    },
  ]);
});

afterAll(async () => {
  if (!HAS_DB) return;
  const paymentIds = [
    ids.grossPayment,
    ids.netPayment,
    ids.unmatchedPayment,
  ];
  await db
    .delete(schema.qboAccountingChecks)
    .where(inArrayFn(schema.qboAccountingChecks.stagedPaymentId, paymentIds));
  await db
    .delete(schema.sourceLinks)
    .where(
      inArrayFn(schema.sourceLinks.stripePayoutId, [
        ids.grossPayout,
        ids.netPayout,
        ids.unmatchedPayout,
      ]),
    );
  await db
    .delete(schema.stagedPayments)
    .where(inArrayFn(schema.stagedPayments.id, paymentIds));
  await db
    .delete(schema.stripePayouts)
    .where(
      inArrayFn(schema.stripePayouts.id, [
        ids.grossPayout,
        ids.netPayout,
        ids.unmatchedPayout,
      ]),
    );
});

describe.skipIf(!HAS_DB)("QBO Stripe booking basis", () => {
  it("accepts both gross and net booking and flags only unmatched amounts", async () => {
    await recompute();

    const rows = await db
      .select({
        stagedPaymentId: schema.qboAccountingChecks.stagedPaymentId,
        bookingBasis: schema.qboAccountingChecks.bookingBasis,
        disposition: schema.qboAccountingChecks.disposition,
      })
      .from(schema.qboAccountingChecks)
      .where(
        inArrayFn(schema.qboAccountingChecks.stagedPaymentId, [
          ids.grossPayment,
          ids.netPayment,
          ids.unmatchedPayment,
        ]),
      );

    const byPayment = new Map(rows.map((row) => [row.stagedPaymentId, row]));
    expect(byPayment.get(ids.grossPayment)).toMatchObject({
      bookingBasis: "gross",
      disposition: "consistent",
    });
    expect(byPayment.get(ids.netPayment)).toMatchObject({
      bookingBasis: "net",
      disposition: "consistent",
    });
    expect(byPayment.get(ids.unmatchedPayment)).toMatchObject({
      bookingBasis: "unmatched",
      disposition: "correction_needed",
    });
  });
});
