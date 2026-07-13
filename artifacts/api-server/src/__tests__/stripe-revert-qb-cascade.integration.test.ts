import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  clearPaymentApplicationsForGiftIds,
  clearPaymentApplicationsForStagedIds,
} from "./paymentApplicationsTestUtil";
import { chargeStatusSql, stagedStatusSql } from "../lib/derivedStatus";
import { getTableColumns } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the QuickBooks cascade on
 * POST /api/stripe-staged-charges/:id/revert (the "Nneka" recovery path).
 *
 * When a Stripe charge reconciled to a gift is reverted, any QuickBooks staged
 * row still DIRECTLY matched (`matched_gift_id`) to the same gift must be
 * cascade-reset to pending alongside it — otherwise the QB row stays locked to
 * a gift that just lost its Stripe evidence and every re-link attempt 409s
 * with no recovery path. The cascade must:
 *   - reset the QB row's gift link + confirmation stamps (derived status back
 *     to `pending`) and drop its payment_applications ledger rows,
 *   - leave mint-owned (`created_gift_id`) and group-reconciled
 *     (`group_reconciled_gift_id`) rows untouched — those revert through their
 *     own explicit paths,
 *   - unblock the full user flow: re-approving the freed QB row to the CORRECT
 *     gift afterwards succeeds (no `not_approvable` 409).
 *
 * Same seam as the other reconciliation suites: only `requireAuth` is mocked
 * to inject a seeded admin; the revert + approve SQL is the real production
 * code. Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `revert_cascade_user_${Date.now()}`,
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

const RUN = `revcasc_${Date.now()}`;
const REALM_ID = `${RUN}_realm`;
const ACCOUNT_ID = `${RUN}_acct`;
const ORG_ID = `${RUN}_org`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stagedPayments: Db["stagedPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  paymentApplications: Db["paymentApplications"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

const giftIds: string[] = [];
const stagedIds: string[] = [];
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
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
    details: "revert-cascade test gift",
  });
  await db.insert(schema.giftAllocations).values({
    id: nextId("alloc"),
    giftId: id,
    subAmount: amount,
  });
  giftIds.push(id);
  return id;
}

/** A Stripe charge human-reconciled to an existing gift (derives match_confirmed). */
async function seedReconciledCharge(
  gross: string,
  matchedGiftId: string,
): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    grossAmount: gross,
    feeAmount: "0.00",
    netAmount: gross,
    dateReceived: "2026-03-15",
    payerName: `${RUN} payer`,
    matchStatus: "matched",
    matchedGiftId,
    organizationId: ORG_ID,
    rawCharge: { id, object: "charge", status: "succeeded" } as Record<
      string,
      unknown
    >,
  });
  chargeIds.push(id);
  return id;
}

/** A QuickBooks staged row with the given gift links (facts drive the derived status). */
async function seedQbStaged(
  amount: string,
  links: {
    matchedGiftId?: string | null;
    createdGiftId?: string | null;
    groupReconciledGiftId?: string | null;
  } = {},
): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    amount,
    dateReceived: "2026-03-15",
    payerName: `${RUN} qb payer`,
    organizationId: ORG_ID,
    matchStatus: "matched",
    matchedGiftId: links.matchedGiftId ?? null,
    createdGiftId: links.createdGiftId ?? null,
    groupReconciledGiftId: links.groupReconciledGiftId ?? null,
  });
  stagedIds.push(id);
  return id;
}

/** Mirror production's dual-write: a linked QB row also carries a ledger row. */
async function seedPaymentApplication(
  stagedPaymentId: string,
  giftId: string,
  amount: string,
): Promise<void> {
  await db.insert(schema.paymentApplications).values({
    id: `${stagedPaymentId}_pa`,
    paymentId: stagedPaymentId,
    giftId,
    amountApplied: amount,
    evidenceSource: "quickbooks",
    matchMethod: "system",
    createdTheGift: false,
  });
}

async function readStaged(id: string) {
  const [row] = await db
    .select({ ...getTableColumns(schema.stagedPayments), status: stagedStatusSql })
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, id));
  return row;
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

async function readPaymentApplications(stagedPaymentId: string) {
  return db
    .select()
    .from(schema.paymentApplications)
    .where(eqFn(schema.paymentApplications.paymentId, stagedPaymentId));
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
    stagedPayments: dbMod.stagedPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    paymentApplications: dbMod.paymentApplications,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;

  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `Revert Cascade Test Org ${RUN}`,
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
  // Delete order matters (RESTRICT FKs): release the gifts' final-amount
  // pointers first (approve stamps source=quickbooks + staged pointer), then
  // ledger rows, allocations, staged rows, charges, gifts, org, user.
  if (giftIds.length)
    await db
      .update(schema.giftsAndPayments)
      .set({
        finalAmountSource: "human",
        finalAmountStripeChargeId: null,
        finalAmountQbStagedPaymentId: null,
      })
      .where(inArrayFn(schema.giftsAndPayments.id, giftIds));
  await clearPaymentApplicationsForGiftIds(giftIds);
  await clearPaymentApplicationsForStagedIds(stagedIds);
  if (giftIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, giftIds));
  if (stagedIds.length)
    await db
      .delete(schema.stagedPayments)
      .where(inArrayFn(schema.stagedPayments.id, stagedIds));
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
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn("[stripe-revert-qb-cascade] skipped: no live DATABASE_URL");
  }
});

describe.skipIf(!HAS_DB)(
  "Stripe charge revert — QuickBooks cascade reset (integration)",
  () => {
    it("reverting a charge also resets a QB row matched to the same gift back to pending (link + stamps + ledger row cleared)", async () => {
      const giftId = await seedGift("250.00");
      const chargeId = await seedReconciledCharge("250.00", giftId);
      const stagedId = await seedQbStaged("250.00", { matchedGiftId: giftId });
      await seedPaymentApplication(stagedId, giftId, "250.00");

      expect((await readStaged(stagedId)).status).toBe("match_confirmed");

      const res = await apiPost(`/api/stripe-staged-charges/${chargeId}/revert`);
      expect(res.status).toBe(200);

      // The charge itself is back in the pending queue…
      expect((await readCharge(chargeId)).status).toBe("pending");

      // …and the QB row was cascade-reset alongside it: gift link and every
      // confirmation stamp cleared, so the derived status is pending again.
      const staged = await readStaged(stagedId);
      expect(staged.status).toBe("pending");
      expect(staged.matchedGiftId).toBeNull();
      expect(staged.autoApplied).toBe(false);
      expect(staged.matchConfirmedAt).toBeNull();
      expect(staged.matchConfirmedByUserId).toBeNull();
      expect(staged.approvedAt).toBeNull();
      expect(staged.approvedByUserId).toBeNull();

      // Its cash-application ledger row is gone too.
      expect(await readPaymentApplications(stagedId)).toHaveLength(0);
    }, 30_000);

    it("after the cascade, re-approving the freed QB row to the CORRECT gift succeeds (the full Nneka recovery)", async () => {
      const wrongGiftId = await seedGift("100.00");
      const correctGiftId = await seedGift("100.00");
      const chargeId = await seedReconciledCharge("100.00", wrongGiftId);
      const stagedId = await seedQbStaged("100.00", {
        matchedGiftId: wrongGiftId,
      });
      await seedPaymentApplication(stagedId, wrongGiftId, "100.00");

      // Without the cascade this approve would 409 not_approvable — the QB row
      // would still be match_confirmed against the wrong gift.
      const revert = await apiPost(
        `/api/stripe-staged-charges/${chargeId}/revert`,
      );
      expect(revert.status).toBe(200);
      expect((await readStaged(stagedId)).status).toBe("pending");

      const approve = await apiPost(
        `/api/reconciliation/cards/${stagedId}/approve`,
        { outcome: "link_existing_gift", giftId: correctGiftId },
      );
      expect(approve.status).toBe(200);
      expect(approve.json.ok).toBe(true);

      const staged = await readStaged(stagedId);
      expect(staged.status).toBe("match_confirmed");
      expect(staged.matchedGiftId).toBe(correctGiftId);
    }, 30_000);

    it("mint-owned and group-reconciled QB rows are NOT cascade-reset (they revert through their own paths)", async () => {
      const giftId = await seedGift("75.00");
      const chargeId = await seedReconciledCharge("75.00", giftId);
      // A row that MINTED the gift and a row group-reconciled into it — both
      // excluded from the cascade by design.
      const mintOwnedId = await seedQbStaged("75.00", {
        createdGiftId: giftId,
      });
      const groupedId = await seedQbStaged("75.00", {
        groupReconciledGiftId: giftId,
      });

      const res = await apiPost(`/api/stripe-staged-charges/${chargeId}/revert`);
      expect(res.status).toBe(200);

      const mintOwned = await readStaged(mintOwnedId);
      expect(mintOwned.createdGiftId).toBe(giftId);
      expect(mintOwned.status).toBe("match_confirmed");

      const grouped = await readStaged(groupedId);
      expect(grouped.groupReconciledGiftId).toBe(giftId);
      expect(grouped.status).toBe("match_confirmed");
    }, 30_000);
  },
);
