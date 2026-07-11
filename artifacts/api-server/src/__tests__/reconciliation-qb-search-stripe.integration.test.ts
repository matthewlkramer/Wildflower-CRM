import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the includeStripe extension of the un-anchored
 * payment search (GET /api/reconciliation/qb-search): the "Link
 * gift/allocation to a payment" dialog searches BOTH QuickBooks staged
 * payments AND Stripe staged charges, interleaved by amount/date proximity
 * and labeled by source (nodeType qb vs stripe).
 *
 * Rules under test:
 *   - Default (no includeStripe) stays QB-only — existing callers unchanged.
 *   - includeStripe=true returns Stripe candidates with nodeType="stripe".
 *   - A charge already tied to a gift (matchedGiftId / createdGiftId) carries
 *     alreadyLinkedGiftId so the picker can gray it and offer an unlink.
 *   - Failed (status excluded), rejected, refunded, and disputed charges
 *     never appear — they aren't linkable money.
 *   - With a target amount, a closer-amount Stripe charge sorts before a
 *     farther-amount QB row (interleave, not append).
 *
 * Same seam as the sibling reconciliation suites: only `requireAuth` is
 * mocked; the SQL and route validation are real production code. Skips
 * automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `recon_qbstripe_user_${Date.now()}`,
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));

const RUN = `reconqbstripe_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;
// A distinctive payer name so the text search isolates only these rows.
const PAYER = `Zzstripemix Payer ${RUN}`;
const GIFT_ID = `${RUN}_gift`;
// QB staged payment: farther from the target amount than the free charge.
const STAGED_QB_ID = `${RUN}_staged_qb`;
// Stripe charges: one free, one already linked, one refunded, one failed.
const CH_FREE_ID = `ch_${RUN}_free`;
const CH_LINKED_ID = `ch_${RUN}_linked`;
const CH_REFUNDED_ID = `ch_${RUN}_refunded`;
const CH_FAILED_ID = `ch_${RUN}_failed`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";

type Candidate = {
  nodeType: string;
  id: string;
  label: string;
  amount?: string | null;
  alreadyLinkedGiftId?: string | null;
};

async function qbSearch(
  qs: string,
): Promise<{ status: number; json: { data?: Candidate[] } }> {
  const res = await fetch(`${baseUrl}/api/reconciliation/qb-search?${qs}`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as { data?: Candidate[] } };
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
    stagedPayments: dbMod.stagedPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
  };
  eqFn = drizzle.eq;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Reconciliation QB+Stripe Search Test Org ${RUN}`,
  });
  await db.insert(schema.giftsAndPayments).values({
    id: GIFT_ID,
    organizationId: ORG_ID,
    ownerUserId: TEST_USER_ID,
    amount: "250.00",
    dateReceived: "2099-11-15",
  });

  // QB staged payment sharing the payer name — amount 260 so with a target of
  // 248 its delta (12) is WORSE than the free charge's gross delta (2): the
  // Stripe row must interleave ahead of it, not append after.
  await db.insert(schema.stagedPayments).values({
    id: STAGED_QB_ID,
    realmId: REALM_ID,
    qbEntityType: "payment",
    qbEntityId: STAGED_QB_ID,
    qbLineId: "",
    amount: "260.00",
    dateReceived: "2099-11-15",
    payerName: PAYER,
    status: "pending" as never,
  });

  // Free (linkable) charge: pending, no gift link, gross 250 / net 242.50 so a
  // 248 target falls inside the known-net fee band.
  await db.insert(schema.stripeStagedCharges).values({
    id: CH_FREE_ID,
    stripeAccountId: "acct_test",
    grossAmount: "250.00",
    netAmount: "242.50",
    dateReceived: "2099-11-15",
    payerName: PAYER,
    status: "pending" as never,
  });
  // Already tied to a gift — must surface grayed via alreadyLinkedGiftId.
  await db.insert(schema.stripeStagedCharges).values({
    id: CH_LINKED_ID,
    stripeAccountId: "acct_test",
    grossAmount: "250.00",
    netAmount: "242.50",
    dateReceived: "2099-11-15",
    payerName: PAYER,
    status: "reconciled" as never,
    matchedGiftId: GIFT_ID,
  });
  // Refunded — not linkable money, must never appear.
  await db.insert(schema.stripeStagedCharges).values({
    id: CH_REFUNDED_ID,
    stripeAccountId: "acct_test",
    grossAmount: "250.00",
    netAmount: "242.50",
    dateReceived: "2099-11-15",
    payerName: PAYER,
    status: "pending" as never,
    refunded: true,
  });
  // Failed charge (auto-excluded at ingest) — must never appear.
  await db.insert(schema.stripeStagedCharges).values({
    id: CH_FAILED_ID,
    stripeAccountId: "acct_test",
    grossAmount: "250.00",
    netAmount: "242.50",
    dateReceived: "2099-11-15",
    payerName: PAYER,
    status: "excluded" as never,
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
  for (const id of [CH_FREE_ID, CH_LINKED_ID, CH_REFUNDED_ID, CH_FAILED_ID]) {
    await db
      .delete(schema.stripeStagedCharges)
      .where(eqFn(schema.stripeStagedCharges.id, id));
  }
  await db
    .delete(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, STAGED_QB_ID));
  await db
    .delete(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, GIFT_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[reconciliation-qb-search-stripe] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)(
  "reconciliation qb-search includeStripe interleave (integration)",
  () => {
    it("stays QB-only by default (existing callers unchanged)", async () => {
      const { status, json } = await qbSearch(`q=${encodeURIComponent(PAYER)}`);
      expect(status).toBe(200);
      const rows = json.data ?? [];
      expect(rows.some((c) => c.id === STAGED_QB_ID)).toBe(true);
      expect(rows.every((c) => c.nodeType === "qb")).toBe(true);
    });

    it("returns Stripe candidates labeled nodeType=stripe with includeStripe=true", async () => {
      const { status, json } = await qbSearch(
        `q=${encodeURIComponent(PAYER)}&includeStripe=true`,
      );
      expect(status).toBe(200);
      const rows = json.data ?? [];
      const qb = rows.find((c) => c.id === STAGED_QB_ID);
      const free = rows.find((c) => c.id === CH_FREE_ID);
      expect(qb).toBeDefined();
      expect(qb!.nodeType).toBe("qb");
      expect(free).toBeDefined();
      expect(free!.nodeType).toBe("stripe");
      expect(free!.alreadyLinkedGiftId ?? null).toBeNull();
    });

    it("flags a charge already tied to a gift via alreadyLinkedGiftId", async () => {
      const { status, json } = await qbSearch(
        `q=${encodeURIComponent(PAYER)}&includeStripe=true`,
      );
      expect(status).toBe(200);
      const linked = (json.data ?? []).find((c) => c.id === CH_LINKED_ID);
      expect(linked).toBeDefined();
      expect(linked!.nodeType).toBe("stripe");
      expect(linked!.alreadyLinkedGiftId).toBe(GIFT_ID);
    });

    it("never surfaces refunded or failed/excluded charges", async () => {
      const { status, json } = await qbSearch(
        `q=${encodeURIComponent(PAYER)}&includeStripe=true`,
      );
      expect(status).toBe(200);
      const ids = (json.data ?? []).map((c) => c.id);
      expect(ids).not.toContain(CH_REFUNDED_ID);
      expect(ids).not.toContain(CH_FAILED_ID);
    });

    it("interleaves by amount proximity — a closer Stripe charge sorts before a farther QB row", async () => {
      const { status, json } = await qbSearch(
        `q=${encodeURIComponent(PAYER)}&amount=248&includeStripe=true`,
      );
      expect(status).toBe(200);
      const rows = json.data ?? [];
      const freeIdx = rows.findIndex((c) => c.id === CH_FREE_ID);
      const qbIdx = rows.findIndex((c) => c.id === STAGED_QB_ID);
      // Both are in band: 248 sits in the charge's [net 242.50, gross 250]
      // known-net band (delta 2 vs gross) and within the QB ±$50 band
      // (delta 12) — so the Stripe row must come FIRST, not be appended.
      expect(freeIdx).toBeGreaterThanOrEqual(0);
      expect(qbIdx).toBeGreaterThanOrEqual(0);
      expect(freeIdx).toBeLessThan(qbIdx);
    });
  },
);
