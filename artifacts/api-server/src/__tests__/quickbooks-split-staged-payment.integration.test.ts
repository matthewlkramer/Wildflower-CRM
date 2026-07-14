import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { stagedStatusSql } from "../lib/derivedStatus";
import { getTableColumns } from "drizzle-orm";
import { clearPaymentApplicationsForRealm } from "./paymentApplicationsTestUtil";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for SPLIT reconciliation: ONE staged payment reconciled
 * across TWO OR MORE pre-existing gifts (no gift minted). The inverse of
 * group-reconcile.
 *
 * Asserts the happy path AND every guardrail returns the right status/error and
 * (for rejections) leaves all rows untouched:
 *   - happy path (2 gifts, combined gross within fee band) → 200, splits inserted,
 *     staged row approved with donor + single-gift link cols cleared
 *   - revert a split row → 200, splits deleted, row back to clean pending
 *   - fewer than two distinct gifts (schema)            → 400 validation_error
 *   - duplicate ids collapse to one gift                → 400 split_too_small
 *   - a gift that doesn't exist                         → 404
 *   - a gift with no donor                              → 400 link_invalid
 *   - a gift already matched to another staged row      → 409 link_conflict
 *   - a gift already split-linked elsewhere             → 409 link_conflict
 *   - combined gross below / above the fee band         → 400 amount_mismatch
 *   - the staged row already resolved                   → 409 not_pending
 *
 * Same seam as the group-reconcile suites: only `requireAuth` is mocked to inject
 * a seeded user; transactions, locking, the donor/tolerance guards and the unique
 * index are real production code. All seeded rows use a unique run prefix.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `qb_split_test_user_${Date.now()}`,
}));

// Replace the Clerk-backed auth gate with one that injects our seeded user.
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

const RUN = `qbsplit_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const REALM_ID = `${RUN}_realm`;

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
  paymentApplications: Db["paymentApplications"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let server: Server;
let baseUrl = "";

let gen = 0;
function nextId(kind: string): string {
  gen += 1;
  return `${RUN}_${kind}_${String(gen).padStart(3, "0")}`;
}

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

const seededGiftIds: string[] = [];

/** Seed a gift carrying the test org as donor (valid Donor-XOR). */
async function seedGift(amount: string): Promise<string> {
  const id = nextId("gift");
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
  });
  seededGiftIds.push(id);
  return id;
}

async function seedStaged(
  amount: string,
  opts: {
    linkedGiftId?: string | null;
  } = {},
): Promise<string> {
  const id = nextId("sp");
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    qbLineId: "0",
    amount,
    payerName: "Stripe Payout",
    dateReceived: "2025-07-01",
    organizationId: ORG_ID,
  });
  // A QB match lives SOLELY in the authoritative `payment_applications`
  // ledger row (the deprecated staged link columns are no longer written).
  if (opts.linkedGiftId) {
    await db.insert(schema.paymentApplications).values({
      id: nextId("pa"),
      paymentId: id,
      giftId: opts.linkedGiftId,
      amountApplied: amount,
      evidenceSource: "quickbooks",
      matchMethod: "system",
      createdTheGift: false,
    });
  }
  return id;
}

async function readStaged(id: string) {
  const [row] = await db
    .select({
      ...getTableColumns(schema.stagedPayments),
      status: stagedStatusSql,
    })
    .from(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.id, id));
  return row;
}

/**
 * Read a split's resolution records: the counted QB payment_applications rows
 * anchored to the staged payment (the sole store of split links — the retired
 * staged_payment_splits table is gone).
 */
async function readSplits(stagedPaymentId: string) {
  const rows = await db
    .select()
    .from(schema.paymentApplications)
    .where(eqFn(schema.paymentApplications.paymentId, stagedPaymentId));
  return rows.filter(
    (r) => r.evidenceSource === "quickbooks" && r.linkRole === "counted",
  );
}

/** Assert a staged row is still a clean, untouched pending row with no splits. */
async function expectUntouchedPending(id: string) {
  const row = await readStaged(id);
  expect(row.status).toBe("pending");
  expect(row.approvedByUserId).toBeNull();
  expect(row.matchConfirmedAt).toBeNull();
  // No ledger rows at all ⇒ no gift link and no splits.
  const splits = await readSplits(id);
  expect(splits.length).toBe(0);
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
    name: `QB Split Test Org ${RUN}`,
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
  // Children first: ledger rows → staged rows → gifts → org → user.
  await clearPaymentApplicationsForRealm(REALM_ID);
  // Un-stamp any gift whose final-amount provenance points at this realm's
  // staged rows (the FK would otherwise block the staged_payments delete).
  await db
    .update(schema.giftsAndPayments)
    .set({ finalAmountQbStagedPaymentId: null })
    .where(
      inArrayFn(
        schema.giftsAndPayments.finalAmountQbStagedPaymentId,
        db
          .select({ id: schema.stagedPayments.id })
          .from(schema.stagedPayments)
          .where(eqFn(schema.stagedPayments.realmId, REALM_ID)),
      ),
    );
  await db
    .delete(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.realmId, REALM_ID));
  if (seededGiftIds.length) {
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, seededGiftIds));
  }
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[quickbooks-split-staged-payment] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("QuickBooks split staged payment (integration)", () => {
  it("splits one payment across two gifts → 200, inserts splits, clears donor + single-gift cols", async () => {
    // Stripe payout net 980 covers two gifts grossing 600 + 400 = 1000 (fees
    // withheld), comfortably inside the band (980-0.01 .. 980*1.1+1).
    const giftA = await seedGift("600.00");
    const giftB = await seedGift("400.00");
    const spId = await seedStaged("980.00");

    const res = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA, giftB],
    });

    expect(res.status).toBe(200);
    expect(res.json.stagedPaymentId).toBe(spId);
    expect(new Set(res.json.giftIds)).toEqual(new Set([giftA, giftB]));
    expect(res.json.splitTotal).toBe("1000.00");

    const row = await readStaged(spId);
    expect(row.status).toBe("match_confirmed");
    expect(row.organizationId).toBeNull();
    expect(row.individualGiverPersonId).toBeNull();
    expect(row.householdId).toBeNull();
    expect(row.approvedByUserId).toBe(TEST_USER_ID);

    const splits = await readSplits(spId);
    expect(splits.length).toBe(2);
    const byGift = new Map(splits.map((s) => [s.giftId, s.amountApplied]));
    expect(byGift.get(giftA)).toBe("600.00");
    expect(byGift.get(giftB)).toBe("400.00");
  }, 30_000);

  it("reverts a split row → 200, deletes splits, returns to clean pending", async () => {
    const giftA = await seedGift("600.00");
    const giftB = await seedGift("400.00");
    const spId = await seedStaged("980.00");

    const split = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA, giftB],
    });
    expect(split.status).toBe(200);

    const revert = await api(`/api/staged-payments/${spId}/revert`, {});
    expect(revert.status).toBe(200);

    await expectUntouchedPending(spId);
    // After revert the gifts are free to be split again.
    const reSplit = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA, giftB],
    });
    expect(reSplit.status).toBe(200);
  }, 30_000);

  it("rejects fewer than two links (one gift, no remainder) → 400 split_too_small", async () => {
    const giftA = await seedGift("600.00");
    const spId = await seedStaged("600.00");

    // A single existing gift with no remainder is a valid SHAPE (giftIds has
    // minItems 1, since a real split can be one gift + a minted remainder), so it
    // passes the schema layer and is caught by the app-layer "at least two links"
    // guard instead.
    const res = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA],
    });

    expect(res.status).toBe(400);
    expect(res.json.error).toBe("split_too_small");
    await expectUntouchedPending(spId);
  }, 30_000);

  it("collapses duplicate gift ids to one → 400 split_too_small", async () => {
    const giftA = await seedGift("600.00");
    const spId = await seedStaged("600.00");

    const res = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA, giftA],
    });

    expect(res.status).toBe(400);
    expect(res.json.error).toBe("split_too_small");
    await expectUntouchedPending(spId);
  }, 30_000);

  it("rejects a non-existent gift → 404 and changes nothing", async () => {
    const giftA = await seedGift("600.00");
    const spId = await seedStaged("980.00");

    const res = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA, `${RUN}_missing_gift`],
    });

    expect(res.status).toBe(404);
    await expectUntouchedPending(spId);
  }, 30_000);

  // NOTE: the "gift has no donor → link_invalid" guard is intentionally not
  // covered here — the DB's gifts_and_payments_donor_xor CHECK constraint makes
  // a donor-less gift impossible to seed, so the route guard is defensive only.

  it("rejects a gift already matched to another staged row → 409 link_conflict", async () => {
    const giftA = await seedGift("600.00");
    const giftB = await seedGift("400.00");
    const spId = await seedStaged("980.00");
    // giftB is already matched to a different staged row.
    await seedStaged("400.00", { linkedGiftId: giftB });

    const res = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA, giftB],
    });

    expect(res.status).toBe(409);
    expect(res.json.error).toBe("link_conflict");
    await expectUntouchedPending(spId);
  }, 30_000);

  it("rejects a gift already split-linked elsewhere → 409 link_conflict", async () => {
    const giftA = await seedGift("600.00");
    const giftB = await seedGift("400.00");
    const giftC = await seedGift("400.00");
    const firstSp = await seedStaged("980.00");
    // First split claims giftA + giftB.
    const first = await api(`/api/staged-payments/${firstSp}/split`, {
      giftIds: [giftA, giftB],
    });
    expect(first.status).toBe(200);

    // A second payment tries to reuse giftB (already split-linked).
    const secondSp = await seedStaged("780.00");
    const res = await api(`/api/staged-payments/${secondSp}/split`, {
      giftIds: [giftB, giftC],
    });

    expect(res.status).toBe(409);
    expect(res.json.error).toBe("link_conflict");
    await expectUntouchedPending(secondSp);
  }, 30_000);

  it("rejects a combined gross below the fee band → 400 amount_mismatch", async () => {
    // Gifts gross only 700 but the payout net is 980 — far under staged*0.9-1
    // (=881), so still outside the (now symmetric) band.
    const giftA = await seedGift("400.00");
    const giftB = await seedGift("300.00");
    const spId = await seedStaged("980.00");

    const res = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA, giftB],
    });

    expect(res.status).toBe(400);
    expect(res.json.error).toBe("amount_mismatch");
    await expectUntouchedPending(spId);
  }, 30_000);

  it("splits when the payout runs slightly ABOVE the combined gross (in band) → 200", async () => {
    // The LISC case: a payout 50¢ over the two booked gifts (1000.50 vs
    // 600 + 400 = 1000). The old gifts-must-cover-the-payment rule rejected this
    // (1000 < 1000.50 - 0.01); the symmetric band now reconciles it.
    const giftA = await seedGift("600.00");
    const giftB = await seedGift("400.00");
    const spId = await seedStaged("1000.50");

    const res = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA, giftB],
    });

    expect(res.status).toBe(200);
    expect(res.json.splitTotal).toBe("1000.00");
    const row = await readStaged(spId);
    expect(row.status).toBe("match_confirmed");
    const splits = await readSplits(spId);
    expect(splits.length).toBe(2);
  }, 30_000);

  it("rejects a combined gross above the fee band → 400 amount_mismatch", async () => {
    // Gifts gross 2000 against a 980 payout — well over staged*1.1+1.
    const giftA = await seedGift("1000.00");
    const giftB = await seedGift("1000.00");
    const spId = await seedStaged("980.00");

    const res = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA, giftB],
    });

    expect(res.status).toBe(400);
    expect(res.json.error).toBe("amount_mismatch");
    await expectUntouchedPending(spId);
  }, 30_000);

  it("serializes a split and a reconcile racing for the same gift → exactly one wins", async () => {
    // The cross-path invariant (a gift is claimed as a direct match OR as a
    // split's ledger row, never both) is enforced by the gift row FOR UPDATE
    // lock shared by every claiming path. Fire a split and a single-row
    // reconcile at the SAME gift (via different staged rows) concurrently and
    // assert exactly one succeeds and the gift ends up claimed in one place.
    const shared = await seedGift("600.00");
    const other = await seedGift("400.00");
    const splitSp = await seedStaged("980.00");
    const matchSp = await seedStaged("600.00");

    const [splitRes, matchRes] = await Promise.all([
      api(`/api/staged-payments/${splitSp}/split`, {
        giftIds: [shared, other],
      }),
      api(`/api/staged-payments/${matchSp}/reconcile`, { giftId: shared }),
    ]);

    const wins = [splitRes, matchRes].filter((r) => r.status === 200).length;
    const conflicts = [splitRes, matchRes].filter(
      (r) => r.status === 409,
    ).length;
    expect(wins).toBe(1);
    expect(conflicts).toBe(1);

    // The shared gift is claimed in exactly ONE place: either the split's
    // ledger rows (anchored to splitSp) or a direct-match ledger row on matchSp.
    const sharedClaims = await db
      .select()
      .from(schema.paymentApplications)
      .where(eqFn(schema.paymentApplications.giftId, shared));
    const sharedSplit = sharedClaims.filter((r) => r.paymentId === splitSp);
    const sharedMatched = sharedClaims.filter((r) => r.paymentId === matchSp);
    expect(sharedSplit.length + sharedMatched.length).toBe(1);
    expect(sharedClaims.length).toBe(1);
  }, 30_000);

  it("serializes a split and a group-reconcile racing for the same gift → exactly one wins", async () => {
    // Same cross-table invariant as the reconcile race, but against the
    // group-reconcile path (writes group_reconciled_gift_id). Both paths now
    // lock the gift row FOR UPDATE (staged → gift), so the shared gift can only
    // be claimed in one place. The two grp rows share payer+date with null
    // deposit ids, forming one coherent group summing to the gift amount.
    const shared = await seedGift("600.00");
    const other = await seedGift("400.00");
    const splitSp = await seedStaged("980.00");
    const grpA = await seedStaged("300.00");
    const grpB = await seedStaged("300.00");

    const [splitRes, groupRes] = await Promise.all([
      api(`/api/staged-payments/${splitSp}/split`, {
        giftIds: [shared, other],
      }),
      api(`/api/staged-payments/group-reconcile`, {
        giftId: shared,
        stagedPaymentIds: [grpA, grpB],
      }),
    ]);

    const wins = [splitRes, groupRes].filter((r) => r.status === 200).length;
    const conflicts = [splitRes, groupRes].filter(
      (r) => r.status === 409,
    ).length;
    expect(wins).toBe(1);
    expect(conflicts).toBe(1);

    // The shared gift is claimed in exactly ONE place: either the split's
    // ledger rows (anchored to splitSp) or group-reconcile ledger rows on the
    // grp member rows.
    const sharedClaims = await db
      .select()
      .from(schema.paymentApplications)
      .where(eqFn(schema.paymentApplications.giftId, shared));
    const sharedSplit = sharedClaims.filter((r) => r.paymentId === splitSp);
    const sharedGrouped = sharedClaims.filter(
      (r) => r.paymentId !== null && [grpA, grpB].includes(r.paymentId),
    );
    const claimedInSplit = sharedSplit.length > 0 ? 1 : 0;
    const claimedInGroup = sharedGrouped.length > 0 ? 1 : 0;
    expect(claimedInSplit + claimedInGroup).toBe(1);
    expect(sharedClaims.length).toBe(sharedSplit.length + sharedGrouped.length);
  }, 30_000);

  it("rejects splitting an already-resolved row → 409 not_pending", async () => {
    const giftA = await seedGift("600.00");
    const giftB = await seedGift("400.00");
    // Resolved by fact: already matched to a gift ⇒ derives match_confirmed.
    const resolvedGift = await seedGift("980.00");
    const spId = await seedStaged("980.00", { linkedGiftId: resolvedGift });

    const res = await api(`/api/staged-payments/${spId}/split`, {
      giftIds: [giftA, giftB],
    });

    expect(res.status).toBe(409);
    expect(res.json.error).toBe("not_pending");
    // No splits were created for the requested gifts (the seed's own ledger
    // row for `resolvedGift` is the only ledger row).
    const splits = await readSplits(spId);
    expect(splits.filter((s) => [giftA, giftB].includes(s.giftId)).length).toBe(0);
    expect(splits.every((s) => s.giftId === resolvedGift)).toBe(true);
  }, 30_000);
});
