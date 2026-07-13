import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPaymentApplicationsForGiftIds } from "./paymentApplicationsTestUtil";
import { chargeStatusSql } from "../lib/derivedStatus";
import { getTableColumns } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the failed-charge landing rule on
 * POST /api/stripe-staged-charges/:id/revert.
 *
 * A charge whose raw Stripe status is 'failed' (e.g. a bounced ACH debit later
 * retried as a NEW charge) never settled. The staged tables mirror Stripe 1:1,
 * so the row exists — but after a revert unlinks it from a gift it must land in
 * the EXCLUDED bucket (`excluded` / `failed_charge`), not back in the pending
 * queue where it would look like real money again. A succeeded charge keeps the
 * original behavior and reverts to `pending`.
 *
 * Same seam as the other reconciliation suites: only `requireAuth` is mocked to
 * inject a seeded admin; the revert SQL is the real production code. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `revert_failed_user_${Date.now()}`,
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

const RUN = `revfail_${Date.now()}`;
const ACCOUNT_ID = `${RUN}_acct`;
const ORG_ID = `${RUN}_org`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripeStagedCharges: Db["stripeStagedCharges"];
};
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

const giftIds: string[] = [];
const allocationIds: string[] = [];
const chargeIds: string[] = [];
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
    details: "revert-failed test gift",
    dateReceived: "2026-03-15",
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

async function seedReconciledCharge(opts: {
  gross: string;
  matchedGiftId: string;
  rawStatus: "failed" | "succeeded" | null;
}): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    grossAmount: opts.gross,
    feeAmount: "0.00",
    netAmount: opts.gross,
    dateReceived: "2026-03-15",
    payerName: `${RUN} payer`,
    matchStatus: "matched",
    matchedGiftId: opts.matchedGiftId,
    organizationId: ORG_ID,
    rawCharge:
      opts.rawStatus === null
        ? null
        : ({ id, object: "charge", status: opts.rawStatus } as Record<
            string,
            unknown
          >),
  });
  chargeIds.push(id);
  return id;
}

async function readCharge(id: string) {
  const [row] = await db
    .select({
      ...getTableColumns(schema.stripeStagedCharges),
      status: chargeStatusSql,
    })
    .from(schema.stripeStagedCharges)
    .where(eqFn(schema.stripeStagedCharges.id, id));
  return row;
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
  };
  inArrayFn = drizzle.inArray;
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Revert-Failed Test Org ${RUN}`,
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
  // Delete order matters (RESTRICT FKs): PA rows → allocations → gifts (release
  // final_amount_stripe_charge_id) → charges → org → user.
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
  await db.delete(schema.organizations).where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn("[stripe-revert-failed] skipped: no live DATABASE_URL");
  }
});

describe.skipIf(!HAS_DB)(
  "POST /stripe-staged-charges/:id/revert — failed-charge landing (integration)",
  () => {
    it("reverting a FAILED charge lands it in excluded/failed_charge, not pending", async () => {
      const giftId = await seedGift("513.08");
      const chargeId = await seedReconciledCharge({
        gross: "513.08",
        matchedGiftId: giftId,
        rawStatus: "failed",
      });

      const res = await apiPost(`/api/stripe-staged-charges/${chargeId}/revert`);
      expect(res.status).toBe(200);

      const charge = await readCharge(chargeId);
      expect(charge.status).toBe("excluded");
      expect(charge.exclusionReason).toBe("failed_charge");
      expect(charge.matchedGiftId).toBeNull();
      expect(charge.createdGiftId).toBeNull();
    });

    it("reverting a SUCCEEDED charge still returns it to pending with no exclusion reason", async () => {
      const giftId = await seedGift("100.00");
      const chargeId = await seedReconciledCharge({
        gross: "100.00",
        matchedGiftId: giftId,
        rawStatus: "succeeded",
      });

      const res = await apiPost(`/api/stripe-staged-charges/${chargeId}/revert`);
      expect(res.status).toBe(200);

      const charge = await readCharge(chargeId);
      expect(charge.status).toBe("pending");
      expect(charge.exclusionReason).toBeNull();
    });

    it("reverting a charge with NO raw payload (CSV-backfilled rows) returns it to pending", async () => {
      const giftId = await seedGift("75.00");
      const chargeId = await seedReconciledCharge({
        gross: "75.00",
        matchedGiftId: giftId,
        rawStatus: null,
      });

      const res = await apiPost(`/api/stripe-staged-charges/${chargeId}/revert`);
      expect(res.status).toBe(200);

      const charge = await readCharge(chargeId);
      expect(charge.status).toBe("pending");
      expect(charge.exclusionReason).toBeNull();
    });
  },
);

describe.skipIf(!HAS_DB)(
  "buildStagedChargeUpsert — failed-charge classification (integration)",
  () => {
    type UpsertValues = Parameters<
      typeof import("../lib/stripeSync")["buildStagedChargeUpsert"]
    >[0];

    function upsertValues(
      id: string,
      rawStatus: "failed" | "succeeded",
      overrides: Partial<UpsertValues> = {},
    ): UpsertValues {
      return {
        id,
        stripeAccountId: ACCOUNT_ID,
        grossAmount: "50.00",
        feeAmount: "1.50",
        netAmount: "48.50",
        dateReceived: "2026-03-15",
        payerName: `${RUN} upsert payer`,
        rawCharge: { id, object: "charge", status: rawStatus },
        exclusionReason: rawStatus === "failed" ? "failed_charge" : null,
        classificationSource: "auto",
        matchStatus: "unmatched",
        ...overrides,
      };
    }

    async function runUpsert(values: UpsertValues) {
      const { buildStagedChargeUpsert } = await import("../lib/stripeSync");
      await buildStagedChargeUpsert(values);
    }

    it("INSERT: a failed charge is staged directly as excluded/failed_charge", async () => {
      const id = nextId("ch");
      chargeIds.push(id);
      await runUpsert(upsertValues(id, "failed"));

      const row = await readCharge(id);
      expect(row.status).toBe("excluded");
      expect(row.exclusionReason).toBe("failed_charge");
    });

    it("UPDATE: a pending auto row flips to excluded when the charge later fails (ACH late-fail)", async () => {
      const id = nextId("ch");
      chargeIds.push(id);
      // Staged while the ACH debit still looked good…
      await runUpsert(upsertValues(id, "succeeded"));
      expect((await readCharge(id)).status).toBe("pending");

      // …then the next sync sees the charge as failed.
      await runUpsert(upsertValues(id, "failed", { exclusionReason: null }));
      const row = await readCharge(id);
      expect(row.status).toBe("excluded");
      expect(row.exclusionReason).toBe("failed_charge");
    });

    it("UPDATE: a manually re-included (pinned) row is never re-excluded by sync", async () => {
      const id = nextId("ch");
      chargeIds.push(id);
      await db.insert(schema.stripeStagedCharges).values({
        ...upsertValues(id, "failed", { exclusionReason: null }),
        classificationSource: "manual",
      } as UpsertValues);

      await runUpsert(upsertValues(id, "failed"));
      const row = await readCharge(id);
      expect(row.status).toBe("pending");
      expect(row.exclusionReason).toBeNull();
    });

    it("UPDATE: a human-resolved (match_confirmed) row is untouched by a failed refresh", async () => {
      const giftId = await seedGift("50.00");
      const id = nextId("ch");
      chargeIds.push(id);
      // A human-confirmed gift link (autoApplied false) derives match_confirmed.
      await db.insert(schema.stripeStagedCharges).values({
        ...upsertValues(id, "failed", { exclusionReason: null }),
        matchStatus: "matched",
        matchedGiftId: giftId,
      } as UpsertValues);

      await runUpsert(upsertValues(id, "failed"));
      const row = await readCharge(id);
      expect(row.status).toBe("match_confirmed");
      expect(row.exclusionReason).toBeNull();
      expect(row.matchedGiftId).toBe(giftId);
    });
  },
);
