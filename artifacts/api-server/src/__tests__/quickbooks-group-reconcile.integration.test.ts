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
 * End-to-end coverage for the QuickBooks deposit-grouping operator path.
 *
 * Unlike the rest of this suite (pure functions / compiled SQL with no live
 * database), this exercises the real route handlers against the dev Postgres so
 * it can assert the actual DB state transitions the SQL preserve-on-conflict
 * unit tests can't see: grouping 2+ staged rows that share one bank deposit,
 * reconciling the group to ONE existing gift inside the fee band (durable
 * `unit_group_members` membership + one counted `payment_applications` ledger
 * row per member), fee-band rejection, and the group-aware revert that reverts
 * the WHOLE group.
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
  TEST_USER_ID: `qb_grp_test_user_${Date.now()}`,
}));

// Replace the Clerk-backed auth gate with one that injects our seeded user.
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    // role matches the seeded DB user; some routes (e.g. the bare /group
    // action) gate on appUser.role via requireFinance.
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));

const RUN = `qbgrp_${Date.now()}`;
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
// staged-row ids (the route picks the lexicographically smallest id as the
// "representative", so deterministic ordering lets us assert which row it is).
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

/** Seed a pending staged row sharing the run's single deposit. */
async function seedStaged(
  giftId: string,
  label: string,
  amount: string,
): Promise<string> {
  const id = stagedId(giftId, label);
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    qbLineId: label,
    amount,
    qbDepositId: DEPOSIT_ID,
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
    name: `QB Group Test Org ${RUN}`,
  });
  // Donor targets for the individual-giver / household adoption cases.
  await db.insert(schema.people).values({
    id: PERSON_ID,
    fullName: `QB Group Test Person ${RUN}`,
  });
  await db.insert(schema.households).values({
    id: HOUSEHOLD_ID,
    name: `QB Group Test Household ${RUN}`,
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
      "[quickbooks-group-reconcile] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)(
  "QuickBooks deposit group-reconcile + group-aware revert (integration)",
  () => {
    it("groups members sharing a deposit and reconciles them to one in-band gift", async () => {
      // Gift 100.00; two deposit members 50 + 50 = 100 → inside the fee band.
      const giftId = await seedGift("100.00");
      seededGiftIds.push(giftId);
      const repId = await seedStaged(giftId, "a", "50.00");
      const memberId = await seedStaged(giftId, "b", "50.00");

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        // Pass out of order to prove the route picks the smallest id as rep.
        stagedPaymentIds: [memberId, repId],
      });

      expect(res.status).toBe(200);
      expect(res.json.representativeStagedPaymentId).toBe(repId);

      const rep = await readStaged(repId);
      const member = await readStaged(memberId);

      // Every member (representative included) carries its own counted ledger
      // row applying its amount to the group's gift.
      expect(rep.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(repId)).toBe(giftId);
      // The donor was adopted from the gift.
      expect(rep.organizationId).toBe(ORG_ID);

      expect(member.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(memberId)).toBe(giftId);
    }, 30_000);

    it("adopts an individual-giver donor and nulls the other donor FKs", async () => {
      // Gift donor is an individual giver; staged rows seed with an org donor,
      // which must be replaced by the gift's individual donor on reconcile.
      const giftId = await seedGiftWithDonor("80.00", {
        individualGiverPersonId: PERSON_ID,
      });
      seededGiftIds.push(giftId);
      const repId = await seedStaged(giftId, "a", "40.00");
      const memberId = await seedStaged(giftId, "b", "40.00");

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [memberId, repId],
      });

      expect(res.status).toBe(200);
      expect(res.json.representativeStagedPaymentId).toBe(repId);

      const rep = await readStaged(repId);
      const member = await readStaged(memberId);

      for (const row of [rep, member]) {
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
      const repId = await seedStaged(giftId, "a", "40.00");
      const memberId = await seedStaged(giftId, "b", "40.00");

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [memberId, repId],
      });

      expect(res.status).toBe(200);
      expect(res.json.representativeStagedPaymentId).toBe(repId);

      const rep = await readStaged(repId);
      const member = await readStaged(memberId);

      for (const row of [rep, member]) {
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

      const repId = await seedStaged(giftId, "a", "50.00");
      const memberId = await seedStaged(giftId, "b", "50.00");

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [memberId, repId],
      });
      expect(res.status).toBe(200);

      // The QB evidence is reconciled (linkage recorded) ...
      const rep = await readStaged(repId);
      const member = await readStaged(memberId);
      expect(rep.status).toBe("match_confirmed");
      expect(member.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(repId)).toBe(giftId);
      expect(await qbSoleGiftIdForPayment(memberId)).toBe(giftId);

      // ... but the gift stays Stripe-sourced — QB never overrides GROSS.
      const [gift] = await db
        .select()
        .from(schema.giftsAndPayments)
        .where(eqFn(schema.giftsAndPayments.id, giftId));
      expect(gift.amount).toBe("100.00");
    }, 30_000);

    it("rejects reconciling to a gift with no donor and leaves rows untouched", async () => {
      // Gift carries zero donors → no donor to adopt → 400 link_invalid.
      const giftId = await seedNoDonorGift("60.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "30.00");
      const bId = await seedStaged(giftId, "b", "30.00");

      const res = await api("/api/staged-payments/group-reconcile", {
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
      // There is no confirm-override anymore: the group is rejected outright and
      // the operator must correct the gift amount to the combined total.
      const giftId = await seedGift("200.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "50.00");
      const bId = await seedStaged(giftId, "b", "50.00");

      const res = await api("/api/staged-payments/group-reconcile", {
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

    it("reconciles an out-of-tolerance group once the gift amount is corrected to the combined total (the appreciated-stock case)", async () => {
      // Stock gift booked at 1,000,000 but the sale proceeds came to a hair
      // over (1,012,780.49) — above the fee band, which only tolerates the
      // deposit landing BELOW the gift. There is no override: the operator must
      // correct the gift's amount to the combined total, then reconcile.
      const giftId = await seedGift("1000000.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "512780.49");
      const bId = await seedStaged(giftId, "b", "500000.00");

      const blocked = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });
      expect(blocked.status).toBe(400);
      expect(blocked.json.error).toBe("amount_mismatch");
      expect(blocked.json.details).toMatchObject({
        combinedTotal: 1012780.49,
        giftAmount: 1000000,
      });

      // Correct the gift's amount to the combined total, then reconcile.
      await db
        .update(schema.giftsAndPayments)
        .set({ amount: "1012780.49" })
        .where(eqFn(schema.giftsAndPayments.id, giftId));

      const res = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(200);
      expect(res.json.representativeStagedPaymentId).toBe(
        [aId, bId].sort()[0],
      );

      const a = await readStaged(aId);
      const b = await readStaged(bId);
      for (const row of [a, b]) {
        expect(row.status).toBe("match_confirmed");
        expect(await qbSoleGiftIdForPayment(row.id)).toBe(giftId);
      }
    }, 30_000);

    it("group-aware revert clears the whole group back to pending", async () => {
      const giftId = await seedGift("90.00");
      seededGiftIds.push(giftId);
      const repId = await seedStaged(giftId, "a", "30.00");
      const m1Id = await seedStaged(giftId, "b", "30.00");
      const m2Id = await seedStaged(giftId, "c", "30.00");

      const grouped = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [repId, m1Id, m2Id],
      });
      expect(grouped.status).toBe(200);
      expect(grouped.json.representativeStagedPaymentId).toBe(repId);

      // Revert from a NON-representative member: the whole group must revert,
      // clearing every member's counted ledger rows.
      const reverted = await api(`/api/staged-payments/${m1Id}/revert`);
      expect(reverted.status).toBe(200);

      for (const id of [repId, m1Id, m2Id]) {
        const row = await readStaged(id);
        expect(row.status).toBe("pending");
        expect(await qbCountedRowsForPayment(id)).toHaveLength(0);
        expect(row.approvedByUserId).toBeNull();
        expect(row.matchConfirmedAt).toBeNull();
      }

      // The pre-existing gift is never deleted by a group revert.
      const [gift] = await db
        .select()
        .from(schema.giftsAndPayments)
        .where(eqFn(schema.giftsAndPayments.id, giftId));
      expect(gift).toBeTruthy();
    }, 30_000);

    // ─── single-member ejection ──────────────────────────────────────────
    // POST /staged-payments/:id/eject-from-group removes ONE member while the
    // rest of the group stays reconciled (the whole-group revert above is the
    // undo-everything path).

    async function groupMembershipIds(anyMemberId: string): Promise<string[]> {
      const rows = await db.execute(
        sqlFn`SELECT m2.source_id FROM unit_group_members m1
              JOIN unit_group_members m2 ON m2.group_id = m1.group_id
                AND m2.evidence_source = 'quickbooks'
              WHERE m1.evidence_source = 'quickbooks'
                AND m1.source_id = ${anyMemberId}`,
      );
      return (rows.rows as { source_id: string }[])
        .map((r) => r.source_id)
        .sort();
    }

    it("ejects one member from a 3-member group; the others stay reconciled and the gift is kept", async () => {
      const giftId = await seedGift("90.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "30.00");
      const bId = await seedStaged(giftId, "b", "30.00");
      const cId = await seedStaged(giftId, "c", "30.00");

      const grouped = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [aId, bId, cId],
      });
      expect(grouped.status).toBe(200);

      const res = await api(`/api/staged-payments/${bId}/eject-from-group`);
      expect(res.status).toBe(200);
      expect(res.json.giftId).toBe(giftId);
      expect(res.json.groupDissolved).toBe(false);
      expect(res.json.remainingStagedPaymentIds).toEqual([aId, cId].sort());
      // 60.00 remaining vs 90.00 gift → below the fee band.
      expect(res.json.remainingTotal).toBe("60.00");
      expect(res.json.giftAmount).toBe("90.00");
      expect(res.json.remainingInFeeBand).toBe(false);

      // Ejected row: pending again, zero counted ledger rows, donor kept.
      const ejected = await readStaged(bId);
      expect(ejected.status).toBe("pending");
      expect(await qbCountedRowsForPayment(bId)).toHaveLength(0);
      expect(ejected.approvedByUserId).toBeNull();
      expect(ejected.matchConfirmedAt).toBeNull();
      expect(ejected.organizationId).toBe(ORG_ID);
      // ... and out of the group.
      expect(await groupMembershipIds(bId)).toEqual([]);

      // The other two members stay reconciled to the same gift, still grouped.
      for (const id of [aId, cId]) {
        const row = await readStaged(id);
        expect(row.status).toBe("match_confirmed");
        expect(await qbSoleGiftIdForPayment(id)).toBe(giftId);
      }
      expect(await groupMembershipIds(aId)).toEqual([aId, cId].sort());

      // The gift survives with its human-entered amount untouched.
      const [gift] = await db
        .select()
        .from(schema.giftsAndPayments)
        .where(eqFn(schema.giftsAndPayments.id, giftId));
      expect(gift.amount).toBe("90.00");
    }, 30_000);

    it("ejecting from a 2-member group dissolves the group; the survivor stays reconciled as a direct match", async () => {
      const giftId = await seedGift("100.00");
      seededGiftIds.push(giftId);
      const aId = await seedStaged(giftId, "a", "50.00");
      const bId = await seedStaged(giftId, "b", "50.00");

      const grouped = await api("/api/staged-payments/group-reconcile", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });
      expect(grouped.status).toBe(200);

      const res = await api(`/api/staged-payments/${aId}/eject-from-group`);
      expect(res.status).toBe(200);
      expect(res.json.groupDissolved).toBe(true);
      expect(res.json.remainingStagedPaymentIds).toEqual([bId]);

      // Group fully gone for BOTH rows (a lone member is not a group).
      expect(await groupMembershipIds(aId)).toEqual([]);
      expect(await groupMembershipIds(bId)).toEqual([]);

      // Survivor keeps its counted ledger row — an equivalent direct match.
      const survivor = await readStaged(bId);
      expect(survivor.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(bId)).toBe(giftId);

      // Ejected row back to pending.
      const ejected = await readStaged(aId);
      expect(ejected.status).toBe("pending");
      expect(await qbCountedRowsForPayment(aId)).toHaveLength(0);

      // The survivor can still be fully reverted afterwards (normal direct
      // revert path — proves ejection left a coherent state behind).
      const reverted = await api(`/api/staged-payments/${bId}/revert`);
      expect(reverted.status).toBe(200);
      expect((await readStaged(bId)).status).toBe("pending");
    }, 30_000);

    it("409s: not in a group / group not reconciled / excluded / 404 missing", async () => {
      // Not in a group: a plain pending row.
      const giftId = await seedGift("50.00");
      seededGiftIds.push(giftId);
      const loneId = await seedStaged(giftId, "a", "50.00");
      const notInGroup = await api(
        `/api/staged-payments/${loneId}/eject-from-group`,
      );
      expect(notInGroup.status).toBe(409);
      expect(notInGroup.json.error).toBe("not_in_group");

      // Group not reconciled yet: build a bare group via the group action.
      const gift2 = await seedGift("100.00");
      seededGiftIds.push(gift2);
      const g1 = await seedStaged(gift2, "a", "50.00");
      const g2 = await seedStaged(gift2, "b", "50.00");
      const groupedOnly = await api("/api/staged-payments/group", {
        stagedPaymentIds: [g1, g2],
      });
      expect(groupedOnly.status).toBe(200);
      const notReconciled = await api(
        `/api/staged-payments/${g1}/eject-from-group`,
      );
      expect(notReconciled.status).toBe(409);
      expect(notReconciled.json.error).toBe("not_reconciled");

      // Excluded row.
      const gift3 = await seedGift("50.00");
      seededGiftIds.push(gift3);
      const exId = await seedStaged(gift3, "a", "50.00");
      await db
        .update(schema.stagedPayments)
        .set({ exclusionReason: "other" })
        .where(eqFn(schema.stagedPayments.id, exId));
      const excluded = await api(
        `/api/staged-payments/${exId}/eject-from-group`,
      );
      expect(excluded.status).toBe(409);
      expect(excluded.json.error).toBe("excluded");

      // Missing row.
      const missing = await api(
        `/api/staged-payments/${RUN}_nope/eject-from-group`,
      );
      expect(missing.status).toBe(404);
    }, 30_000);
  },
);
