import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-backed coverage for the charge-grain Stripe↔QB tie proposal pass
 * (`runChargeTiePass`). Unlike the pure assignment unit test
 * (charge-qb-tie.test.ts) this exercises the real candidate query + idempotent
 * proposal writes against dev Postgres, asserting the actual
 * `stripe_staged_charges.proposed_qb_staged_payment_id` transitions:
 *   - an exact-amount close-date QB row is proposed onto the payout's charge,
 *   - re-running is idempotent (same proposal, no churn),
 *   - a payout WITH a settlement link is out of scope and any stale proposal
 *     on its charges clears,
 *   - a confirmed tie (linked_qb_staged_payment_id) is never touched and its
 *     QB row is never re-proposed elsewhere,
 *   - a QB row that is a settlement-link deposit is not a candidate,
 *   - terminal (excluded) charges never get proposals.
 *
 * The pass is lock-free (`runChargeTiePass`, not the locked wrapper) so no
 * Stripe connector is needed. All rows use a unique run prefix + a deliberately
 * unusual amount so exact-amount candidate queries can't collide with other
 * dev data. Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `chgtie_${Date.now()}`;
const ACCOUNT_ID = `${RUN}_acct`;
const REALM_ID = `${RUN}_realm`;

// Deliberately unusual cent values, unique per amount group in this run.
const AMT_A = "1234.57";
const AMT_B = "2345.68";
const AMT_C = "3456.79";
// Net-booked fixture: gross/net pair (bookkeeper booked the post-fee net).
const AMT_D_GROSS = "4567.91";
const AMT_D_NET = "4435.26";
// Combined-booked fixture: two charges whose GROSS sum equals one QB row.
const AMT_E1 = "1111.13";
const AMT_E2 = "2222.27";
const AMT_E_SUM = "3333.40";

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  stagedPayments: Db["stagedPayments"];
  sourceLinks: Db["sourceLinks"];
  sourceLinkId: Db["sourceLinkId"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let runChargeTiePass: (typeof import("../lib/chargeQbTie"))["runChargeTiePass"];

const payoutIds: string[] = [];
const chargeIds: string[] = [];
const stagedIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function seedPayout(over: { amount: string; arrivalDate: string }) {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: over.amount,
    netTotal: over.amount,
    arrivalDate: over.arrivalDate,
  });
  payoutIds.push(id);
  return id;
}

async function seedCharge(over: {
  payoutId: string;
  grossAmount: string;
  netAmount?: string | null;
  dateReceived: string;
  payerName?: string | null;
  /** Set to derive `excluded` (exclusion_reason IS NOT NULL). */
  exclusionReason?: "other_revenue" | null;
  linkedQbStagedPaymentId?: string | null;
  proposedQbStagedPaymentId?: string | null;
}) {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: over.payoutId,
    grossAmount: over.grossAmount,
    netAmount: over.netAmount ?? null,
    dateReceived: over.dateReceived,
    payerName: over.payerName ?? null,
    exclusionReason: over.exclusionReason ?? null,
  });
  // The tie lives ONLY in the source_links ledger (the authority).
  const tieQb = over.linkedQbStagedPaymentId ?? over.proposedQbStagedPaymentId;
  if (tieQb) {
    await db.insert(schema.sourceLinks).values({
      id: schema.sourceLinkId("charge_qb_tie", id),
      linkType: "charge_qb_tie",
      stripeChargeId: id,
      qbStagedPaymentId: tieQb,
      lifecycle: over.linkedQbStagedPaymentId ? "confirmed" : "proposed",
      provenance: over.linkedQbStagedPaymentId ? "human" : "system",
    });
  }
  chargeIds.push(id);
  return id;
}

async function seedQbRow(over: {
  amount: string;
  dateReceived: string;
  payerName?: string | null;
}) {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "payment",
    qbEntityId: nextId("qbe"),
    amount: over.amount,
    dateReceived: over.dateReceived,
    payerName: over.payerName === undefined ? null : over.payerName,
  });
  stagedIds.push(id);
  return id;
}

/** Read the tie state from the LEDGER (the sole authority). */
async function readCharge(id: string) {
  const ties = await db
    .select({
      lifecycle: schema.sourceLinks.lifecycle,
      qb: schema.sourceLinks.qbStagedPaymentId,
    })
    .from(schema.sourceLinks)
    .where(
      andFn(
        eqFn(schema.sourceLinks.linkType, "charge_qb_tie"),
        eqFn(schema.sourceLinks.stripeChargeId, id),
      ),
    );
  const tie = ties[0] ?? null;
  const row = {
    proposed: tie?.lifecycle === "proposed" ? tie.qb : null,
    linked: tie?.lifecycle === "confirmed" ? tie.qb : null,
  };
  expect(ties.length).toBeLessThanOrEqual(1);
  return row;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    stagedPayments: dbMod.stagedPayments,
    sourceLinks: dbMod.sourceLinks,
    sourceLinkId: dbMod.sourceLinkId,
  };
  andFn = drizzle.and;
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  ({ runChargeTiePass } = await import("../lib/chargeQbTie"));
}, 60_000);

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
}, 60_000);

describe.skipIf(!HAS_DB)("runChargeTiePass (DB)", () => {
  it(
    "proposes, is idempotent, respects scope and confirmed ties",
    { timeout: 120_000 },
    async () => {
      // ── Fixture 1: plain missing-deposit payout, one exact-amount QB row.
      const po1 = await seedPayout({ amount: AMT_A, arrivalDate: "2026-02-10" });
      const ch1 = await seedCharge({
        payoutId: po1,
        grossAmount: AMT_A,
        dateReceived: "2026-02-08",
        payerName: "Hilary Beard",
      });
      const qb1 = await seedQbRow({
        amount: AMT_A,
        dateReceived: "2026-02-12",
        payerName: "Beard, Hilary",
      });
      // Out-of-window same-amount decoy (must NOT be proposed).
      await seedQbRow({
        amount: AMT_A,
        dateReceived: "2025-10-01",
        payerName: "Beard, Hilary",
      });

      // ── Fixture 2: payout WITH a settled QBO lump (lump path owns it) whose
      // charge carries a stale proposal → must clear, payout out of scope.
      const po2 = await seedPayout({ amount: AMT_B, arrivalDate: "2026-02-10" });
      const qbDep = await seedQbRow({
        amount: AMT_B,
        dateReceived: "2026-02-11",
        payerName: "Stripe",
      });
      await db
        .update(schema.stagedPayments)
        .set({ settledStripePayoutId: po2 })
        .where(eqFn(schema.stagedPayments.id, qbDep));
      const ch2 = await seedCharge({
        payoutId: po2,
        grossAmount: AMT_B,
        dateReceived: "2026-02-09",
        proposedQbStagedPaymentId: qbDep, // stale
      });

      // ── Fixture 3: charge with a CONFIRMED tie + an excluded charge; the
      // confirmed QB row must never be re-proposed onto the open charge of
      // another payout even at the exact same amount/date.
      const qb3 = await seedQbRow({
        amount: AMT_C,
        dateReceived: "2026-02-12",
      });
      const po3 = await seedPayout({ amount: AMT_C, arrivalDate: "2026-02-10" });
      const ch3 = await seedCharge({
        payoutId: po3,
        grossAmount: AMT_C,
        dateReceived: "2026-02-10",
        linkedQbStagedPaymentId: qb3,
      });
      const chExcluded = await seedCharge({
        payoutId: po3,
        grossAmount: AMT_C,
        dateReceived: "2026-02-10",
        exclusionReason: "other_revenue",
      });
      const po4 = await seedPayout({ amount: AMT_C, arrivalDate: "2026-02-10" });
      const ch4 = await seedCharge({
        payoutId: po4,
        grossAmount: AMT_C,
        dateReceived: "2026-02-12",
      });

      // ── Fixture 5: NET-booked payout — the only QB row records the charge's
      // post-fee NET amount exactly; it must be proposed via the net match.
      const po5 = await seedPayout({
        amount: AMT_D_NET,
        arrivalDate: "2026-02-10",
      });
      const ch5 = await seedCharge({
        payoutId: po5,
        grossAmount: AMT_D_GROSS,
        netAmount: AMT_D_NET,
        dateReceived: "2026-02-08",
        payerName: "Allen Vasan",
      });
      const qb5 = await seedQbRow({
        amount: AMT_D_NET,
        dateReceived: "2026-02-11",
        payerName: "Vasan, Allen",
      });

      const scope = [po1, po2, po3, po4, po5];
      const first = await runChargeTiePass(scope);
      // po2 has a settlement link → out of the evaluated pool.
      expect(first.payoutsEvaluated).toBe(4);

      // 1) exact-amount close-date proposal landed (window decoy ignored).
      expect((await readCharge(ch1)).proposed).toBe(qb1);
      // 2) stale proposal on the linked payout cleared.
      expect((await readCharge(ch2)).proposed).toBeNull();
      expect(first.cleared).toBeGreaterThanOrEqual(1);
      // 3) confirmed tie untouched; its QB row not re-proposed on ch4;
      //    excluded charge got nothing.
      const c3 = await readCharge(ch3);
      expect(c3.linked).toBe(qb3);
      expect(c3.proposed).toBeNull();
      expect((await readCharge(ch4)).proposed).toBeNull();
      expect((await readCharge(chExcluded)).proposed).toBeNull();
      // 3b) net-booked QB row proposed via the exact-NET match.
      expect((await readCharge(ch5)).proposed).toBe(qb5);

      // 4) idempotent re-run: same proposals, nothing newly cleared.
      const second = await runChargeTiePass(scope);
      expect((await readCharge(ch1)).proposed).toBe(qb1);
      expect((await readCharge(ch5)).proposed).toBe(qb5);
      expect(second.cleared).toBe(0);
      expect(second.proposed).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    "proposes a combined-booked group: both leftovers point at the shared QB row",
    { timeout: 120_000 },
    async () => {
      // Neither charge has an exact-amount QB row of its own; the ONLY QB row
      // in the window carries their exact gross sum (one combined deposit
      // line). The subset-sum pass must propose BOTH charges onto that row —
      // the confirm endpoint later splits it into per-charge units.
      const po = await seedPayout({
        amount: AMT_E_SUM,
        arrivalDate: "2026-03-10",
      });
      const chA = await seedCharge({
        payoutId: po,
        grossAmount: AMT_E1,
        dateReceived: "2026-03-08",
        payerName: "Devon Person",
      });
      const chB = await seedCharge({
        payoutId: po,
        grossAmount: AMT_E2,
        dateReceived: "2026-03-08",
        payerName: "Fisher Fund",
      });
      const qbSum = await seedQbRow({
        amount: AMT_E_SUM,
        dateReceived: "2026-03-11",
        payerName: null, // combined lines rarely carry one donor's name
      });

      const first = await runChargeTiePass([po]);
      expect(first.payoutsEvaluated).toBe(1);
      expect((await readCharge(chA)).proposed).toBe(qbSum);
      expect((await readCharge(chB)).proposed).toBe(qbSum);

      // Idempotent re-run: same group proposal, nothing cleared.
      const second = await runChargeTiePass([po]);
      expect((await readCharge(chA)).proposed).toBe(qbSum);
      expect((await readCharge(chB)).proposed).toBe(qbSum);
      expect(second.cleared).toBe(0);
    },
  );
});
