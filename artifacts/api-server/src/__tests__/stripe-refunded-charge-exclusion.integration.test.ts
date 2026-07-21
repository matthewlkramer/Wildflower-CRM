import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPaymentApplicationsForGiftIds,
  seedStripeApplication,
  stripeCountedRowForCharge,
  stripeGiftIdForCharge,
} from "./paymentApplicationsTestUtil";
import { chargeStatusSql, stagedStatusSql } from "../lib/derivedStatus";
import { getTableColumns } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the refunded-charge auto-exclusion (`refunded_charge`).
 *
 * A Stripe charge that was FULLY refunded before ever being booked into a CRM
 * gift is not workable money: it must land in the EXCLUDED bucket
 * (`excluded` / `refunded_charge`), not sit in the pending queue as approvable
 * money. Mirrors the failed-charge precedent end to end:
 *   - upsert classification (a pending auto row flips when the refund fact
 *     arrives on a later sync; partial refunds / disputes / manual pins /
 *     booked rows are never touched),
 *   - the QB sweep (a pending staged payment whose ENTIRE Stripe trace is
 *     refunded_charge/failed_charge money is excluded; mixed deposits stay),
 *   - revert (unlinking a gift built on a fully-refunded charge re-lands the
 *     charge in Excluded, not pending).
 *
 * Same seam as the other reconciliation suites: only `requireAuth` is mocked
 * to inject a seeded admin; everything else is real production code. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `refunded_excl_user_${Date.now()}`,
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

const RUN = `refexcl_${Date.now()}`;
const ACCOUNT_ID = `${RUN}_acct`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  stagedPayments: Db["stagedPayments"];
  sourceLinks: Db["sourceLinks"];
  sourceLinkId: Db["sourceLinkId"];
};
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let sweepRefundedQbStagedPayments: typeof import("../lib/refundedChargeSweep")["sweepRefundedQbStagedPayments"];
let server: Server;
let baseUrl = "";

const giftIds: string[] = [];
const allocationIds: string[] = [];
const chargeIds: string[] = [];
const stagedIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function apiPost(
  path: string,
  body: unknown = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function seedGift(amount: string): Promise<string> {
  const id = nextId("gift");
  const allocId = nextId("alloc");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
    details: "refunded-exclusion test gift",
    dateReceived: "2026-04-01",
  });
  await db.insert(schema.giftAllocations).values({
    id: allocId,
    giftId: id,
    subAmount: amount,
  });
  giftIds.push(id);
  allocationIds.push(allocId);
  return id;
}

async function seedQbRow(over: {
  amount: string;
  classificationSource?: "auto" | "manual";
}): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "payment",
    qbEntityId: nextId("qbe"),
    amount: over.amount,
    dateReceived: "2026-04-01",
    payerName: `${RUN} qb payer`,
    ...(over.classificationSource
      ? { classificationSource: over.classificationSource }
      : {}),
  });
  stagedIds.push(id);
  return id;
}

/** Ledger mirror for a charge↔QB tie — reads are ledger-authoritative. */
async function seedTie(
  chargeId: string,
  qbStagedPaymentId: string,
  // Only ONE confirmed tie may claim a QB row (partial unique index) — extra
  // charges tracing to the same row are seeded as proposals; the sweep's
  // trace predicate accepts any lifecycle.
  lifecycle: "confirmed" | "proposed" = "confirmed",
) {
  await db.insert(schema.sourceLinks).values({
    id: schema.sourceLinkId("charge_qb_tie", chargeId),
    linkType: "charge_qb_tie",
    stripeChargeId: chargeId,
    qbStagedPaymentId,
    lifecycle,
    provenance: lifecycle === "confirmed" ? "human" : "system",
  });
}

async function readCharge(id: string) {
  const [row] = await db
    .select({
      ...getTableColumns(schema.stripeStagedCharges),
      status: chargeStatusSql,
    })
    .from(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, id));
  return row!;
}

async function readStaged(id: string) {
  const [row] = await db
    .select({
      exclusionReason: schema.stagedPayments.exclusionReason,
      status: stagedStatusSql,
    })
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, id));
  return row!;
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
    giftAllocations: dbMod.giftAllocations,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    stagedPayments: dbMod.stagedPayments,
    sourceLinks: dbMod.sourceLinks,
    sourceLinkId: dbMod.sourceLinkId,
  };
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;
  ({ sweepRefundedQbStagedPayments } = await import(
    "../lib/refundedChargeSweep"
  ));

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Refunded-Exclusion Test Org ${RUN}`,
  });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  // Delete order matters (RESTRICT FKs): PA rows → allocations → gifts →
  // charges → staged payments → org → user.
  await clearPaymentApplicationsForGiftIds(giftIds);
  if (allocationIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.id, allocationIds));
  if (giftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn("[stripe-refunded-exclusion] skipped: no live DATABASE_URL");
  }
});

type UpsertValues = Parameters<
  typeof import("../lib/stripeSync")["buildStagedChargeUpsert"]
>[0];

function upsertValues(
  id: string,
  overrides: Partial<UpsertValues> = {},
): UpsertValues {
  return {
    id,
    stripeAccountId: ACCOUNT_ID,
    grossAmount: "259.11",
    feeAmount: "10.92",
    netAmount: "248.19",
    dateReceived: "2026-04-01",
    payerName: `${RUN} upsert payer`,
    rawCharge: { id, object: "charge", status: "succeeded" },
    refunded: false,
    disputed: false,
    amountRefunded: null,
    exclusionReason: null,
    classificationSource: "auto",
    matchStatus: "unmatched",
    ...overrides,
  };
}

async function runUpsert(values: UpsertValues) {
  const { buildStagedChargeUpsert } = await import("../lib/stripeSync");
  await buildStagedChargeUpsert(values);
}

describe.skipIf(!HAS_DB)(
  "buildStagedChargeUpsert — refunded-charge classification (integration)",
  () => {
    it("INSERT: a fully-refunded never-booked charge is staged directly as excluded/refunded_charge", async () => {
      const id = nextId("ch");
      chargeIds.push(id);
      // Insert-time classification is computed by the sync loop and passed in
      // the values, mirroring failed_charge.
      await runUpsert(
        upsertValues(id, {
          refunded: true,
          amountRefunded: "259.11",
          exclusionReason: "refunded_charge",
        }),
      );

      const row = await readCharge(id);
      expect(row.status).toBe("excluded");
      expect(row.exclusionReason).toBe("refunded_charge");
    });

    it("UPDATE: a pending auto row flips to excluded when the refund arrives on a later sync", async () => {
      const id = nextId("ch");
      chargeIds.push(id);
      await runUpsert(upsertValues(id));
      expect((await readCharge(id)).status).toBe("pending");

      // Next sync sees the charge fully refunded (insert-time classifier not
      // in play: exclusionReason stays null in the incoming values, the CASE
      // arm in the upsert must do the flip).
      await runUpsert(
        upsertValues(id, { refunded: true, amountRefunded: "259.11" }),
      );
      const row = await readCharge(id);
      expect(row.status).toBe("excluded");
      expect(row.exclusionReason).toBe("refunded_charge");
    });

    it("UPDATE: a PARTIALLY refunded charge stays pending (real work)", async () => {
      const id = nextId("ch");
      chargeIds.push(id);
      await runUpsert(upsertValues(id));
      await runUpsert(
        upsertValues(id, { refunded: true, amountRefunded: "100.00" }),
      );
      const row = await readCharge(id);
      expect(row.status).toBe("pending");
      expect(row.exclusionReason).toBeNull();
    });

    it("UPDATE: a DISPUTED charge is a chargeback, not a refund exclusion", async () => {
      const id = nextId("ch");
      chargeIds.push(id);
      await runUpsert(upsertValues(id));
      await runUpsert(
        upsertValues(id, {
          refunded: true,
          disputed: true,
          amountRefunded: "259.11",
        }),
      );
      const row = await readCharge(id);
      expect(row.status).toBe("pending");
      expect(row.exclusionReason).toBeNull();
    });

    it("UPDATE: a manually re-included (pinned) row is never re-excluded by sync", async () => {
      const id = nextId("ch");
      chargeIds.push(id);
      await db.insert(schema.stripeStagedCharges).values({
        ...upsertValues(id, { refunded: true, amountRefunded: "259.11" }),
        classificationSource: "manual",
      } as UpsertValues);

      await runUpsert(
        upsertValues(id, { refunded: true, amountRefunded: "259.11" }),
      );
      const row = await readCharge(id);
      expect(row.status).toBe("pending");
      expect(row.exclusionReason).toBeNull();
    });

    it("UPDATE: a BOOKED (match_confirmed) charge keeps its gift link — refund propagation's job", async () => {
      const giftId = await seedGift("259.11");
      const id = nextId("ch");
      chargeIds.push(id);
      await db.insert(schema.stripeStagedCharges).values({
        ...upsertValues(id),
        matchStatus: "matched",
      } as UpsertValues);
      // The gift link lives in the ledger, not the retired pointer columns.
      await seedStripeApplication({
        stripeChargeId: id,
        giftId,
        amountApplied: "259.11",
      });

      await runUpsert(
        upsertValues(id, { refunded: true, amountRefunded: "259.11" }),
      );
      const row = await readCharge(id);
      expect(row.status).toBe("match_confirmed");
      expect(row.exclusionReason).toBeNull();
      expect(await stripeGiftIdForCharge(id)).toBe(giftId);
    });
  },
);

describe.skipIf(!HAS_DB)(
  "sweepRefundedQbStagedPayments — QB rows traced to refunded money (integration)",
  () => {
    it("excludes a pending QB row whose ENTIRE trace is refunded_charge money", async () => {
      const spId = await seedQbRow({ amount: "248.19" });
      const chId = nextId("ch");
      chargeIds.push(chId);
      await db.insert(schema.stripeStagedCharges).values({
        ...upsertValues(chId, {
          refunded: true,
          amountRefunded: "259.11",
          exclusionReason: "refunded_charge",
        }),
      } as UpsertValues);
      await seedTie(chId, spId);

      await sweepRefundedQbStagedPayments();
      const row = await readStaged(spId);
      expect(row.status).toBe("excluded");
      expect(row.exclusionReason).toBe("refunded_charge");
    });

    it("a deposit mixing refunded and LIVE charges stays in the queue", async () => {
      const spId = await seedQbRow({ amount: "500.00" });
      const refundedId = nextId("ch");
      const liveId = nextId("ch");
      chargeIds.push(refundedId, liveId);
      await db.insert(schema.stripeStagedCharges).values([
        {
          ...upsertValues(refundedId, {
            refunded: true,
            amountRefunded: "259.11",
            exclusionReason: "refunded_charge",
          }),
        },
        {
          ...upsertValues(liveId, { grossAmount: "251.81", netAmount: "251.81" }),
        },
      ] as UpsertValues[]);
      await seedTie(refundedId, spId);
      await seedTie(liveId, spId, "proposed");

      await sweepRefundedQbStagedPayments();
      const row = await readStaged(spId);
      expect(row.status).toBe("pending");
      expect(row.exclusionReason).toBeNull();
    });

    it("a trace of refunded + FAILED charges still excludes (failed contributes no money)", async () => {
      const spId = await seedQbRow({ amount: "248.19" });
      const refundedId = nextId("ch");
      const failedId = nextId("ch");
      chargeIds.push(refundedId, failedId);
      await db.insert(schema.stripeStagedCharges).values([
        {
          ...upsertValues(refundedId, {
            refunded: true,
            amountRefunded: "259.11",
            exclusionReason: "refunded_charge",
          }),
        },
        {
          ...upsertValues(failedId, {
            rawCharge: { id: failedId, object: "charge", status: "failed" },
            exclusionReason: "failed_charge",
          }),
        },
      ] as UpsertValues[]);
      await seedTie(refundedId, spId);
      await seedTie(failedId, spId, "proposed");

      await sweepRefundedQbStagedPayments();
      const row = await readStaged(spId);
      expect(row.status).toBe("excluded");
      expect(row.exclusionReason).toBe("refunded_charge");
    });

    it("never clobbers a manually pinned (re-included) QB row", async () => {
      const spId = await seedQbRow({
        amount: "248.19",
        classificationSource: "manual",
      });
      const chId = nextId("ch");
      chargeIds.push(chId);
      await db.insert(schema.stripeStagedCharges).values({
        ...upsertValues(chId, {
          refunded: true,
          amountRefunded: "259.11",
          exclusionReason: "refunded_charge",
        }),
      } as UpsertValues);
      await seedTie(chId, spId);

      await sweepRefundedQbStagedPayments();
      const row = await readStaged(spId);
      expect(row.status).toBe("pending");
      expect(row.exclusionReason).toBeNull();
    });

    it("a QB row with NO Stripe trace is never excluded", async () => {
      const spId = await seedQbRow({ amount: "99.00" });
      await sweepRefundedQbStagedPayments();
      const row = await readStaged(spId);
      expect(row.status).toBe("pending");
      expect(row.exclusionReason).toBeNull();
    });
  },
);

describe.skipIf(!HAS_DB)(
  "POST /stripe-staged-charges/:id/revert — refunded-charge landing (integration)",
  () => {
    it("reverting a FULLY-refunded charge lands it in excluded/refunded_charge, not pending", async () => {
      const giftId = await seedGift("259.11");
      const id = nextId("ch");
      chargeIds.push(id);
      await db.insert(schema.stripeStagedCharges).values({
        ...upsertValues(id, { refunded: true, amountRefunded: "259.11" }),
        matchStatus: "matched",
      } as UpsertValues);
      await seedStripeApplication({
        stripeChargeId: id,
        giftId,
        amountApplied: "259.11",
      });

      const res = await apiPost(`/api/stripe-staged-charges/${id}/revert`);
      expect(res.status).toBe(200);

      const charge = await readCharge(id);
      expect(charge.status).toBe("excluded");
      expect(charge.exclusionReason).toBe("refunded_charge");
      expect(await stripeCountedRowForCharge(id)).toBeNull();
    });

    it("reverting a PARTIALLY-refunded charge returns it to pending", async () => {
      const giftId = await seedGift("259.11");
      const id = nextId("ch");
      chargeIds.push(id);
      await db.insert(schema.stripeStagedCharges).values({
        ...upsertValues(id, { refunded: true, amountRefunded: "50.00" }),
        matchStatus: "matched",
      } as UpsertValues);
      await seedStripeApplication({
        stripeChargeId: id,
        giftId,
        amountApplied: "259.11",
      });

      const res = await apiPost(`/api/stripe-staged-charges/${id}/revert`);
      expect(res.status).toBe(200);

      const charge = await readCharge(id);
      expect(charge.status).toBe("pending");
      expect(charge.exclusionReason).toBeNull();
    });
  },
);
