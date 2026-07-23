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
  clearPaymentApplicationsForRealm,
  qbCountedRowsForPayment,
  qbSoleGiftIdForPayment,
} from "./paymentApplicationsTestUtil";
import { stagedStatusSql } from "../lib/derivedStatus";
import { getTableColumns } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * End-to-end coverage for the QuickBooks multi-match operator path
 * (docs/adr-linear-money-model.md — the replacement for group-then-match).
 *
 * Unlike the rest of this suite (pure functions / compiled SQL with no live
 * database), this exercises the real route handlers against the dev Postgres so
 * it can assert the actual DB state transitions the SQL preserve-on-conflict
 * unit tests can't see: matching 2+ staged rows that share one bank deposit to
 * ONE existing gift inside the fee band (one counted `payment_applications`
 * ledger row per member — the ADR's core invariant: the counted ledger rows
 * alone express the combined outcome), fee-band rejection, zero-amount member
 * rejection, PER-ROW revert (no group semantics), and the 410 tombstones on
 * the retired /group, /group-reconcile and /:id/eject-from-group endpoints.
 *
 * The only seam we mock is the Clerk auth gate (`requireAuth`) — we inject a
 * seeded test user so the handlers run with a real `appUser`; everything else
 * (transactions, locking, tolerance math, partial-unique index) is the genuine
 * production code. All seeded rows use a unique run prefix and are cleaned up.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `qb_mm_test_user_${Date.now()}`,
}));

// Replace the Clerk-backed auth gate with one that injects our seeded user.
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    // role matches the seeded DB user; some routes gate on appUser.role via
    // requireFinance.
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));

const RUN = `qbmm_${Date.now()}`;
const ORG_ID = `${RUN}_org`;
const PERSON_ID = `${RUN}_person`;
const HOUSEHOLD_ID = `${RUN}_household`;
const REALM_ID = `${RUN}_realm`;
const DEPOSIT_ID = `${RUN}_dep`;
const DONOR_XOR_CONSTRAINT = "gifts_and_payments_donor_xor";

type Db = typeof import("@workspace/db");

let db: Db["db"];
let schema: {
  users: Db["users"];
  organizations: Db["organizations"];
  people: Db["people"];
  households: Db["households"];
  giftsAndPayments: Db["giftsAndPayments"];
  stagedPayments: Db["stagedPayments"];
  stripeStagedCharges: Db["stripeStagedCharges"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let sqlFn: (typeof import("drizzle-orm"))["sql"];
let server: Server;
let baseUrl = "";

// A monotonically increasing suffix so each test gets fresh, uniquely-ordered
// staged-row ids (deterministic ordering lets us assert the sorted id lists the
// route returns).
let gen = 0;
function nextGiftId(): string {
  gen += 1;
  return `${RUN}_gift_${String(gen).padStart(3, "0")}`;
}
function stagedId(giftId: string, label: string): string {
  return `${giftId}_sp_${label}`;
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

type DonorFields = {
  organizationId?: string | null;
  individualGiverPersonId?: string | null;
  householdId?: string | null;
};

async function seedGift(amount: string): Promise<string> {
  const id = nextGiftId();
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
  });
  return id;
}

/** Seed a gift carrying a specific single donor (Donor XOR). */
async function seedGiftWithDonor(
  amount: string,
  donor: DonorFields,
): Promise<string> {
  const id = nextGiftId();
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: donor.organizationId ?? null,
    individualGiverPersonId: donor.individualGiverPersonId ?? null,
    householdId: donor.householdId ?? null,
  });
  return id;
}

/**
 * Seed a gift with NO donor. The gifts_and_payments_donor_xor CHECK constraint
 * forbids zero-donor rows, so we briefly drop it, insert the malformed gift,
 * and immediately re-add the constraint as NOT VALID (still enforced for any
 * new rows, just not re-validated against the existing one). The constraint is
 * fully re-validated in afterAll once the malformed row is gone.
 */
async function seedNoDonorGift(amount: string): Promise<string> {
  const id = nextGiftId();
  // The ALTERs take an AccessExclusiveLock on gifts_and_payments. Under the
  // fully parallel test suite a *waiting* AccessExclusiveLock queues every
  // later reader behind it, which has caused deadlocks in unrelated test
  // files. Run the whole drop→insert→re-add sequence in ONE transaction with
  // a short lock_timeout so the ALTER fails fast (and we retry) instead of
  // camping in the lock queue, and so the constraint is never observably
  // missing outside this transaction.
  const attempt = () =>
    db.transaction(async (tx) => {
      await tx.execute(sqlFn`SET LOCAL lock_timeout = '500ms'`);
      await tx.execute(
        sqlFn`ALTER TABLE gifts_and_payments DROP CONSTRAINT IF EXISTS ${sqlFn.raw(
          DONOR_XOR_CONSTRAINT,
        )}`,
      );
      await tx.insert(schema.giftsAndPayments).values({ id, amount });
      await tx.execute(
        sqlFn`ALTER TABLE gifts_and_payments ADD CONSTRAINT ${sqlFn.raw(
          DONOR_XOR_CONSTRAINT,
        )} CHECK (num_nonnulls(organization_id, individual_giver_person_id, household_id) = 1) NOT VALID`,
      );
    });
  let lastErr: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      await attempt();
      return id;
    } catch (err) {
      lastErr = err;
      const e = err as { code?: string; cause?: { code?: string } } | null;
      const code = e?.code ?? e?.cause?.code;
      // 55P03 lock_not_available (lock_timeout), 40P01 deadlock_detected.
      if (code !== "55P03" && code !== "40P01") throw err;
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
    }
  }
  throw lastErr;
}

/**
 * Seed a pending staged row. Defaults to the run's single shared deposit and
 * no payer; tests exercising the coherence key override the deposit/payer to
 * build deliberately incoherent selections.
 */
async function seedStaged(
  giftId: string,
  label: string,
  amount: string,
  opts: { depositId?: string | null; payerName?: string | null } = {},
): Promise<string> {
  const id = stagedId(giftId, label);
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    qbLineId: label,
    amount,
    qbDepositId: opts.depositId === undefined ? DEPOSIT_ID : opts.depositId,
    payerName: opts.payerName ?? null,
    organizationId: ORG_ID,
  });
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

const seededGiftIds: string[] = [];
// Stripe charge ids seeded for the Stripe-precedence regression; their gift
// pointers (RESTRICT) are cleared in afterAll before the charges are deleted.
const seededChargeIds: string[] = [];

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
    giftsAndPayments: dbMod.giftsAndPayments,
    stagedPayments: dbMod.stagedPayments,
    stripeStagedCharges: dbMod.stripeStagedCharges,
  };
  eqFn = drizzle.eq;
  inArrayFn = drizzle.inArray;
  sqlFn = drizzle.sql;

  // Seed the user the mocked auth gate injects (FK target for
  // matchConfirmedByUserId / approvedByUserId) and the donor org.
  await db.insert(schema.users).values({
    id: TEST_USER_ID,
    clerkId: `clerk_${TEST_USER_ID}`,
    email: `${TEST_USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: `QB Multi-Match Test Org ${RUN}`,
  });
  // Donor targets for the individual-giver / household adoption cases.
  await db.insert(schema.people).values({
    id: PERSON_ID,
    fullName: `QB Multi-Match Test Person ${RUN}`,
  });
  await db.insert(schema.households).values({
    id: HOUSEHOLD_ID,
    name: `QB Multi-Match Test Household ${RUN}`,
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
  // D4: a reconciled gift references its QB staged evidence via
  // final_amount_qb_staged_payment_id (RESTRICT), so the gift→staged pointer
  // must be cleared before the staged rows can be deleted. Delete the staged
  // rows, then the gifts (which cascade-clears any allocation-review rows).
  await clearPaymentApplicationsForRealm(REALM_ID);
  await db
    .delete(schema.stagedPayments)
    .where(eqFn(schema.stagedPayments.realmId, REALM_ID));
  if (seededGiftIds.length) {
    await db
      .delete(schema.giftsAndPayments)
      .where(inArrayFn(schema.giftsAndPayments.id, seededGiftIds));
  }
  // Stripe charges are deleted last: the reset above nulled the gift's RESTRICT
  // pointer and the gifts are now gone, so nothing references them anymore.
  if (seededChargeIds.length) {
    await db
      .delete(schema.stripeStagedCharges)
      .where(inArrayFn(schema.stripeStagedCharges.id, seededChargeIds));
  }
  // The no-donor case may have left the donor-XOR constraint NOT VALID. With the
  // malformed gift now deleted, fully re-validate it to restore the dev DB's
  // pristine schema state (a no-op if it was never dropped).
  try {
    await db.execute(
      sqlFn`ALTER TABLE gifts_and_payments VALIDATE CONSTRAINT ${sqlFn.raw(
        DONOR_XOR_CONSTRAINT,
      )}`,
    );
  } catch {
    // Best-effort: never let constraint restoration mask test results.
  }
  await db
    .delete(schema.people)
    .where(eqFn(schema.people.id, PERSON_ID));
  await db
    .delete(schema.households)
    .where(eqFn(schema.households.id, HOUSEHOLD_ID));
  await db
    .delete(schema.organizations)
    .where(eqFn(schema.organizations.id, ORG_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, TEST_USER_ID));
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    // Surface the reason in the runner instead of silently passing.
    console.warn(
      "[quickbooks-multi-match] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)(
  "QuickBooks multi-match + per-row revert + retired group endpoints (integration)",
  () => {
    it("matches members sharing a deposit to one in-band gift WITHOUT writing a unit group", async () => {
      // Gift 100.00; two deposit members 50 + 50 = 100 → inside the fee band.
      const giftId = await seedGift("100.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "50.00");
      const bId = await seedStaged(giftId, "b", "50.00");

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        // Pass out of order to prove the route de-dupes and sorts.
        stagedPaymentIds: [bId, aId],
      });

      expect(res.status).toBe(200);
      expect(res.json.gift.id).toBe(giftId);
      expect(res.json.stagedPaymentIds).toEqual([aId, bId].sort());
      // The retired response field must not come back.
      expect(res.json.representativeStagedPaymentId).toBeUndefined();

      const a = await readStaged(aId);
      const b = await readStaged(bId);

      // Every member carries its own counted ledger row applying its amount
      // to the gift; the donor was adopted from the gift.
      for (const row of [a, b]) {
        expect(row.status).toBe("match_confirmed");
        expect(await qbSoleGiftIdForPayment(row.id)).toBe(giftId);
        expect(row.organizationId).toBe(ORG_ID);
      }

    }, 30_000);

    it("adopts an individual-giver donor and nulls the other donor FKs", async () => {
      // Gift donor is an individual giver; staged rows seed with an org donor,
      // which must be replaced by the gift's individual donor on match.
      const giftId = await seedGiftWithDonor("80.00", {
        individualGiverPersonId: PERSON_ID,
      });
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "40.00");
      const bId = await seedStaged(giftId, "b", "40.00");

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [bId, aId],
      });

      expect(res.status).toBe(200);
      expect(res.json.stagedPaymentIds).toEqual([aId, bId].sort());

      const a = await readStaged(aId);
      const b = await readStaged(bId);

      for (const row of [a, b]) {
        // The individual donor is stamped; the other two FKs are nulled.
        expect(row.individualGiverPersonId).toBe(PERSON_ID);
        expect(row.organizationId).toBeNull();
        expect(row.householdId).toBeNull();
        expect(row.status).toBe("match_confirmed");
        expect(await qbSoleGiftIdForPayment(row.id)).toBe(giftId);
      }
    }, 30_000);

    it("adopts a household donor and nulls the other donor FKs", async () => {
      const giftId = await seedGiftWithDonor("80.00", {
        householdId: HOUSEHOLD_ID,
      });
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "40.00");
      const bId = await seedStaged(giftId, "b", "40.00");

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [bId, aId],
      });

      expect(res.status).toBe(200);

      const a = await readStaged(aId);
      const b = await readStaged(bId);

      for (const row of [a, b]) {
        // The household donor is stamped; the other two FKs are nulled.
        expect(row.householdId).toBe(HOUSEHOLD_ID);
        expect(row.organizationId).toBeNull();
        expect(row.individualGiverPersonId).toBeNull();
        expect(row.status).toBe("match_confirmed");
        expect(await qbSoleGiftIdForPayment(row.id)).toBe(giftId);
      }
    }, 30_000);

    it("leaves a Stripe-sourced gift's final amount untouched when QB reconciles", async () => {
      // The gift's final amount is already sourced from a Stripe charge (GROSS
      // is authoritative). QB reconciling the same money must record the QB rows
      // as `reconciled` EVIDENCE but never overwrite the gift's Stripe amount.
      const chargeId = `${RUN}_charge_a`;
      await db.insert(schema.stripeStagedCharges).values({
        id: chargeId,
        stripeAccountId: `${RUN}_acct`,
      });
      seededChargeIds.push(chargeId);

      const giftId = await seedGiftWithDonor("100.00", {
        organizationId: ORG_ID,
      });
      seededGiftIds.push(giftId);

      const aId = await seedStaged(giftId, "a", "50.00");
      const bId = await seedStaged(giftId, "b", "50.00");

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [bId, aId],
      });
      expect(res.status).toBe(200);

      // The QB evidence is reconciled (linkage recorded) ...
      const a = await readStaged(aId);
      const b = await readStaged(bId);
      expect(a.status).toBe("match_confirmed");
      expect(b.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(aId)).toBe(giftId);
      expect(await qbSoleGiftIdForPayment(bId)).toBe(giftId);

      // ... but the gift stays Stripe-sourced — QB never overrides GROSS.
      const [gift] = await db
        .select()
        .from(schema.giftsAndPayments)
        .where(eqFn(schema.giftsAndPayments.id, giftId));
      expect(gift.amount).toBe("100.00");
    }, 30_000);

    it("rejects matching to a gift with no donor and leaves rows untouched", async () => {
      // Gift carries zero donors → no donor to adopt → 400 link_invalid.
      const giftId = await seedNoDonorGift("60.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "30.00");
      const bId = await seedStaged(giftId, "b", "30.00");

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("link_invalid");

      // Rows untouched — still pending, no gift links, donor still the seed org.
      const a = await readStaged(aId);
      const b = await readStaged(bId);
      for (const row of [a, b]) {
        expect(row.status).toBe("pending");
        expect(await qbCountedRowsForPayment(row.id)).toHaveLength(0);
        expect(row.organizationId).toBe(ORG_ID);
      }
    }, 30_000);

    it("rejects an out-of-tolerance combined total with 400 amount_mismatch (no override) without touching the rows", async () => {
      // Gift 200.00 vs combined 100.00 → 200 > 100*1.1+1 = 111 → over band.
      // There is no confirm-override anymore: the selection is rejected outright
      // and the operator must correct the gift amount to the combined total.
      const giftId = await seedGift("200.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "50.00");
      const bId = await seedStaged(giftId, "b", "50.00");

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("amount_mismatch");
      expect(res.json.details).toMatchObject({
        combinedTotal: 100,
        giftAmount: 200,
      });

      // Rows untouched — still pending, no gift links.
      const a = await readStaged(aId);
      const b = await readStaged(bId);
      for (const row of [a, b]) {
        expect(row.status).toBe("pending");
        expect(await qbCountedRowsForPayment(row.id)).toHaveLength(0);
      }
    }, 30_000);

    it("matches an out-of-tolerance selection once the gift amount is corrected to the combined total (the appreciated-stock case)", async () => {
      // Stock gift booked at 1,000,000 but the sale proceeds came to a hair
      // over (1,012,780.49) — above the fee band, which only tolerates the
      // deposit landing BELOW the gift. There is no override: the operator must
      // correct the gift's amount to the combined total, then match.
      const giftId = await seedGift("1000000.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "512780.49");
      const bId = await seedStaged(giftId, "b", "500000.00");

      const blocked = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });
      expect(blocked.status).toBe(400);
      expect(blocked.json.error).toBe("amount_mismatch");
      expect(blocked.json.details).toMatchObject({
        combinedTotal: 1012780.49,
        giftAmount: 1000000,
      });

      // Correct the gift's amount to the combined total, then match.
      await db
        .update(schema.giftsAndPayments)
        .set({ amount: "1012780.49" })
        .where(eqFn(schema.giftsAndPayments.id, giftId));

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(200);
      expect(res.json.stagedPaymentIds).toEqual([aId, bId].sort());

      const a = await readStaged(aId);
      const b = await readStaged(bId);
      for (const row of [a, b]) {
        expect(row.status).toBe("match_confirmed");
        expect(await qbSoleGiftIdForPayment(row.id)).toBe(giftId);
      }
    }, 30_000);

    it("rejects a selection containing a zero-amount member with 400 zero_amount_member", async () => {
      // A $0.00 evidence row carries no money to book — a counted ledger row
      // of 0 would violate the positive-amount application invariant, so the
      // route rejects the whole selection before any fee-band math.
      const giftId = await seedGift("50.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "50.00");
      const zId = await seedStaged(giftId, "b", "0.00");

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, zId],
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("zero_amount_member");

      // Nothing was booked for either row.
      for (const id of [aId, zId]) {
        const row = await readStaged(id);
        expect(row.status).toBe("pending");
        expect(await qbCountedRowsForPayment(id)).toHaveLength(0);
      }
    }, 30_000);

    it("reverts PER ROW: reverting one multi-matched member leaves the others matched", async () => {
      // With no unit group written, there are no group semantics to revert:
      // each member's counted ledger row is undone individually via the normal
      // revert path (docs/adr-linear-money-model.md).
      const giftId = await seedGift("90.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "30.00");
      const bId = await seedStaged(giftId, "b", "30.00");
      const cId = await seedStaged(giftId, "c", "30.00");

      const matched = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId, cId],
      });
      expect(matched.status).toBe(200);
      expect(matched.json.stagedPaymentIds).toEqual([aId, bId, cId].sort());

      // Revert ONE member: only that row returns to pending.
      const reverted = await api(`/api/staged-payments/${bId}/revert`);
      expect(reverted.status).toBe(200);

      const b = await readStaged(bId);
      expect(b.status).toBe("pending");
      expect(await qbCountedRowsForPayment(bId)).toHaveLength(0);
      expect(b.approvedByUserId).toBeNull();
      expect(b.matchConfirmedAt).toBeNull();

      // The other two members stay matched to the gift.
      for (const id of [aId, cId]) {
        const row = await readStaged(id);
        expect(row.status).toBe("match_confirmed");
        expect(await qbSoleGiftIdForPayment(id)).toBe(giftId);
      }

      // Reverting the remaining members individually clears everything; the
      // pre-existing gift is never deleted by a revert.
      for (const id of [aId, cId]) {
        const r = await api(`/api/staged-payments/${id}/revert`);
        expect(r.status).toBe(200);
      }
      for (const id of [aId, bId, cId]) {
        const row = await readStaged(id);
        expect(row.status).toBe("pending");
        expect(await qbCountedRowsForPayment(id)).toHaveLength(0);
      }
      const [gift] = await db
        .select()
        .from(schema.giftsAndPayments)
        .where(eqFn(schema.giftsAndPayments.id, giftId));
      expect(gift).toBeTruthy();
    }, 30_000);

    // ─── retired endpoints ───────────────────────────────────────────────
    // Group behavior is fully retired (docs/adr-linear-money-model.md §7
    // step 3): nothing reads unit_groups / unit_group_members anymore, and
    // the plain per-row revert IS what ejection used to do (undo THIS
    // member's counted row only), so the endpoints are 410 tombstones.

    it("the retired eject endpoint answers 410 and leaves a reconciled row untouched", async () => {
      const giftId = await seedGift("100.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "50.00");
      const bId = await seedStaged(giftId, "b", "50.00");

      const matched = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });
      expect(matched.status).toBe(200);

      const res = await api(`/api/staged-payments/${bId}/eject-from-group`);
      expect(res.status).toBe(410);
      expect(res.json.error).toBe("group_creation_retired");

      // Nothing changed: both rows stay reconciled.
      for (const id of [aId, bId]) {
        const row = await readStaged(id);
        expect(row.status).toBe("match_confirmed");
        expect(await qbSoleGiftIdForPayment(id)).toBe(giftId);
      }
    }, 30_000);

    it("the retired /group and /group-reconcile endpoints answer 410 group_creation_retired and touch nothing", async () => {
      const giftId = await seedGift("100.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "50.00");
      const bId = await seedStaged(giftId, "b", "50.00");

      const group = await api("/api/staged-payments/group", {
        stagedPaymentIds: [aId, bId],
      });
      expect(group.status).toBe(410);
      expect(group.json.error).toBe("group_creation_retired");

      const groupReconcile = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });
      expect(groupReconcile.status).toBe(410);
      expect(groupReconcile.json.error).toBe("group_creation_retired");

      // Nothing was written: rows still pending, no ledger rows.
      for (const id of [aId, bId]) {
        const row = await readStaged(id);
        expect(row.status).toBe("pending");
        expect(await qbCountedRowsForPayment(id)).toHaveLength(0);
      }
    }, 30_000);
  },
);
