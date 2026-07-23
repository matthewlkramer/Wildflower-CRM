import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { chargeStatusSql } from "../lib/derivedStatus";
import { stripeMintedGiftIdForCharge } from "./paymentApplicationsTestUtil";
import { getTableColumns } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * DB-backed coverage for the atomic settlement-bundle confirm endpoint
 * (POST /api/reconciliation/bundle-proposals/:draftId/confirm) and its assemble
 * / derive companions.
 *
 * The bundle confirm commits the WHOLE proposed end-state in one transaction via
 * the SAME money-write primitives the manual reconciler uses (no parallel money
 * path). These tests drive the real HTTP surface against a live DB and assert:
 *   - assemble persists an editable draft for a Stripe-payout anchor,
 *   - a per-charge MINT to an EXISTING donor books a real gift (charge →
 *     reconciled, createdGiftId, gross stamped) and is idempotent by revision
 *     (a replay returns the stored result; a stale revision is a 409),
 *   - a per-charge MINT to a brand-NEW donor materializes the donor + gift
 *     (propose-new-donor),
 *   - the consistency gate refuses a bundle with a blocker (exclude without a
 *     reason) and mutates nothing, then a human-supplied reason lets the same row
 *     EXCLUDE on confirm,
 *   - an open draft rejects a confirm carrying a stale expectedRevision.
 *
 * Same seam as the QuickBooks/Stripe reconcile suites: only the Clerk auth gate
 * (`requireAuth`) is mocked to inject a seeded admin user; the transaction, the
 * gates, and the guarded writes are real production code. Skips automatically
 * when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `recon_bundle_user_${Date.now()}`,
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

const RUN = `reconbundle_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const ACCOUNT_ID = `${RUN}_acct`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  people: Db["people"];
  households: Db["households"];
  emails: Db["emails"];
  giftsAndPayments: Db["giftsAndPayments"];
  giftAllocations: Db["giftAllocations"];
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  reconciliationBundleDrafts: Db["reconciliationBundleDrafts"];
  paymentApplications: Db["paymentApplications"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

const draftIds: string[] = [];
const payoutIds: string[] = [];
const chargeIds: string[] = [];
const createdGiftIds: string[] = [];
const createdDonorIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

async function api(
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// Seed a Stripe payout with NO tied QB deposit (so the payout↔deposit tie is a
// no-op and the bundle is pure per-charge money).
async function seedPayout(): Promise<string> {
  const id = nextId("po");
  await db.insert(schema.stripePayouts).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    amount: "100.00",
    netTotal: "96.80",
    arrivalDate: "2026-03-15",
  });
  payoutIds.push(id);
  return id;
}

async function seedCharge(
  payoutId: string,
  opts: { gross?: string; payerName?: string; payerEmail?: string } = {},
): Promise<string> {
  const id = nextId("ch");
  await db.insert(schema.stripeStagedCharges).values({
    id,
    stripeAccountId: ACCOUNT_ID,
    stripePayoutId: payoutId,
    grossAmount: opts.gross ?? "100.00",
    feeAmount: "3.20",
    netAmount: "96.80",
    dateReceived: "2026-03-15",
    payerName: opts.payerName ?? `Zztest Bundle Payer ${RUN}`,
    payerEmail: opts.payerEmail ?? `${RUN}-payer@example.invalid`,
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
async function readGift(id: string) {
  const [row] = await db
    .select()
    .from(schema.giftsAndPayments)
    .where(eqFn(schema.giftsAndPayments.id, id));
  return row;
}

function trackConfirm(json: any): void {
  for (const r of json?.rows ?? []) {
    if (r.giftId) createdGiftIds.push(r.giftId);
    if (r.createdDonorId) createdDonorIds.push(r.createdDonorId);
  }
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  db = dbMod.db;
  schema = {
    users: dbMod.users,
    organizations: dbMod.organizations,
    people: dbMod.people,
    households: dbMod.households,
    emails: dbMod.emails,
    giftsAndPayments: dbMod.giftsAndPayments,
    giftAllocations: dbMod.giftAllocations,
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    reconciliationBundleDrafts: dbMod.reconciliationBundleDrafts,
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
    name: `Reconciliation Bundle Test Org ${RUN}`,
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

  // `payment_applications` (Plane-2 ledger booked by the per-charge mint) FKs the
  // gift ON DELETE RESTRICT, so clear it before the gifts. (The settled payout
  // pairing needs no explicit cleanup: `settled_stripe_payout_id` is SET NULL
  // on the stripePayouts delete below.)
  if (createdGiftIds.length)
    await db
      .delete(schema.paymentApplications)
      .where(inArrayFn(schema.paymentApplications.giftId, createdGiftIds));
  if (createdGiftIds.length)
    await db
      .delete(schema.giftAllocations)
      .where(inArrayFn(schema.giftAllocations.giftId, createdGiftIds));
  if (createdGiftIds.length)
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, createdGiftIds));
  if (draftIds.length)
    await db
      .delete(schema.reconciliationBundleDrafts)
      .where(inArrayFn(schema.reconciliationBundleDrafts.id, draftIds));
  if (chargeIds.length)
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, chargeIds));
  if (payoutIds.length)
    await db
      .delete(schema.stripePayouts)
      .where(inArrayFn(schema.stripePayouts.id, payoutIds));
  // Donors materialized by propose-new-donor (org / person / household) + their
  // emails. Delete is a harmless no-op for ids that aren't of a given kind.
  if (createdDonorIds.length) {
    await db
      .delete(schema.emails)
      .where(inArrayFn(schema.emails.personId, createdDonorIds));
    await db
      .delete(schema.emails)
      .where(inArrayFn(schema.emails.organizationId, createdDonorIds));
    await db
      .delete(schema.people)
      .where(inArrayFn(schema.people.id, createdDonorIds));
    await db
      .delete(schema.households)
      .where(inArrayFn(schema.households.id, createdDonorIds));
    await db
      .delete(schema.organizations)
      .where(inArrayFn(schema.organizations.id, createdDonorIds));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[reconciliation-bundle-confirm] skipped: no live DATABASE_URL configured",
    );
  }
});

async function assembleDraft(payoutId: string): Promise<{
  draftId: string;
  revision: number;
  rowKey: string;
  json: any;
}> {
  const res = await api("/api/reconciliation/bundle-proposals", {
    anchorType: "stripe_payout",
    anchorId: payoutId,
  });
  expect(res.status).toBe(200);
  const draftId = res.json.draftId as string;
  draftIds.push(draftId);
  return {
    draftId,
    revision: res.json.revision as number,
    rowKey: res.json.rows[0].rowKey as string,
    json: res.json,
  };
}

describe.skipIf(!HAS_DB)("Reconciliation bundle confirm (integration)", () => {
  it("assembles a persisted, editable draft for a Stripe-payout anchor", async () => {
    const payoutId = await seedPayout();
    const chargeId = await seedCharge(payoutId);

    const { json } = await assembleDraft(payoutId);
    expect(json.anchorType).toBe("stripe_payout");
    expect(json.anchorId).toBe(payoutId);
    expect(json.status).toBe("open");
    expect(json.revision).toBe(1);
    expect(json.stale).toBe(false);
    expect(json.rows).toHaveLength(1);
    expect(json.rows[0].rowKey).toBe(chargeId);
    expect(json.summary.rowCount).toBe(1);
    // Tie is a no-op: the payout has no QB deposit, so there is nothing to confirm.
    expect(json.tie?.action ?? "none").toBe("none");
  });

  it("mints a gift from a charge to an existing donor, idempotently by revision", async () => {
    const payoutId = await seedPayout();
    const chargeId = await seedCharge(payoutId);
    const { draftId, rowKey } = await assembleDraft(payoutId);

    // Edit the row to an explicit end-state: MINT to the seeded existing org.
    const derived = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/derive`,
      {
        rows: [
          {
            rowKey,
            giftKind: "mint",
            donorKind: "existing",
            donorId: ORG_ID,
            donorRecordKind: "organization",
          },
        ],
      },
    );
    expect(derived.status).toBe(200);
    expect(derived.json.revision).toBe(2);
    expect(derived.json.summary.ready).toBe(true);
    expect(derived.json.summary.blockerCount).toBe(0);
    expect(derived.json.rows[0].gift.kind).toBe("mint");
    expect(derived.json.rows[0].donor.donorId).toBe(ORG_ID);

    const confirm = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/confirm`,
      { expectedRevision: 2 },
    );
    trackConfirm(confirm.json);
    expect(confirm.status).toBe(200);
    expect(confirm.json.ok).toBe(true);
    expect(confirm.json.giftsCreated).toBe(1);
    expect(confirm.json.giftsMatched).toBe(0);
    expect(confirm.json.rows[0].outcome).toBe("minted_gift");

    const giftId = confirm.json.rows[0].giftId as string;
    const gift = await readGift(giftId);
    expect(gift?.organizationId).toBe(ORG_ID);
    expect(Number(gift?.amount)).toBeCloseTo(100, 2);

    const charge = await readCharge(chargeId);
    expect(charge?.status).toBe("match_confirmed");
    // The mint ownership lives in the ledger (pointer columns are retired).
    expect(await stripeMintedGiftIdForCharge(chargeId)).toBe(giftId);

    // Idempotent replay at the committed revision returns the stored result and
    // books NOTHING further.
    const replay = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/confirm`,
      { expectedRevision: 2 },
    );
    expect(replay.status).toBe(200);
    expect(replay.json.alreadyConfirmed).toBe(true);
    expect(replay.json.rows[0].giftId).toBe(giftId);

    // A confirmed draft rejects a confirm at a DIFFERENT revision.
    const mismatch = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/confirm`,
      { expectedRevision: 999 },
    );
    expect(mismatch.status).toBe(409);
    expect(mismatch.json.error).toBe("revision_mismatch");
  });

  it("materializes a brand-new donor and mints its gift (propose-new-donor)", async () => {
    const payoutId = await seedPayout();
    await seedCharge(payoutId);
    const { draftId, rowKey } = await assembleDraft(payoutId);

    const derived = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/derive`,
      {
        rows: [
          {
            rowKey,
            giftKind: "mint",
            donorKind: "new",
            newDonor: {
              kind: "person",
              name: `Bundle NewDonor ${RUN}`,
              firstName: "Bundle",
              lastName: `NewDonor ${RUN}`,
            },
          },
        ],
      },
    );
    expect(derived.status).toBe(200);
    expect(derived.json.summary.ready).toBe(true);

    const confirm = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/confirm`,
      { expectedRevision: derived.json.revision },
    );
    trackConfirm(confirm.json);
    expect(confirm.status).toBe(200);
    expect(confirm.json.donorsCreated).toBe(1);
    expect(confirm.json.giftsCreated).toBe(1);

    const createdDonorId = confirm.json.rows[0].createdDonorId as string;
    expect(createdDonorId).toBeTruthy();
    const giftId = confirm.json.rows[0].giftId as string;
    const gift = await readGift(giftId);
    expect(gift?.individualGiverPersonId).toBe(createdDonorId);
  });

  it("refuses to confirm a blocker, then excludes the row once a reason is given", async () => {
    const payoutId = await seedPayout();
    const chargeId = await seedCharge(payoutId);
    const { draftId, rowKey } = await assembleDraft(payoutId);

    // Exclude WITHOUT a reason → blocker → confirm refused, nothing mutated.
    const noReason = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/derive`,
      { rows: [{ rowKey, giftKind: "exclude" }] },
    );
    expect(noReason.status).toBe(200);
    expect(noReason.json.summary.ready).toBe(false);
    expect(noReason.json.summary.blockerCount).toBeGreaterThanOrEqual(1);

    const blocked = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/confirm`,
      { expectedRevision: noReason.json.revision },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe("blockers");
    expect((await readCharge(chargeId))?.status).toBe("pending");

    // Supply a reason → ready → confirm excludes the charge.
    const withReason = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/derive`,
      { rows: [{ rowKey, exclusionReason: "membership" }] },
    );
    expect(withReason.status).toBe(200);
    expect(withReason.json.summary.ready).toBe(true);

    const confirm = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/confirm`,
      { expectedRevision: withReason.json.revision },
    );
    expect(confirm.status).toBe(200);
    expect(confirm.json.rows[0].outcome).toBe("excluded");
    expect(confirm.json.giftsCreated).toBe(0);

    const charge = await readCharge(chargeId);
    expect(charge?.status).toBe("excluded");
    expect(charge?.exclusionReason).toBe("membership");
  });

  it("rejects a confirm carrying a stale expectedRevision on an open draft", async () => {
    const payoutId = await seedPayout();
    const chargeId = await seedCharge(payoutId);
    const { draftId } = await assembleDraft(payoutId);

    const res = await api(
      `/api/reconciliation/bundle-proposals/${draftId}/confirm`,
      { expectedRevision: 999 },
    );
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("revision_mismatch");
    // Nothing booked: the charge is untouched.
    expect((await readCharge(chargeId))?.status).toBe("pending");
  });
});
