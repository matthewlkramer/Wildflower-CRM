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
 * End-to-end coverage for the QuickBooks multi-match GUARDRAILS.
 *
 * Companion to `quickbooks-multi-match.integration.test.ts` (which covers
 * the happy path + revert). This file asserts the route's coherence-key +
 * rejection paths each return the right status/error AND (for rejections) leave
 * every row untouched:
 *   - DIFFERENT deposits, NO/empty payer               → 400 not_groupable
 *   - no deposit AND different payer                   → 400 not_groupable
 *   - no deposit, SAME payer + date                    → 200, reconciled
 *   - same payer+date but DIFFERENT non-null deposits  → confirm gate, then 200
 *   - same payer, DIFFERENT dates, no confirm flag     → 400 multi_date_confirmation_required
 *   - same payer, DIFFERENT dates, confirmMultiDate    → 200, reconciled
 *   - same payer, one real + one null date (mixed)     → multi-date gate applies
 *   - one row already resolved/approved                → 409 not_pending
 *   - gift already linked to a staged row outside selection → 409 link_conflict
 *   - fewer than two rows                              → 400 selection_too_small
 *
 * Same seam as the companion suite: only the Clerk auth gate (`requireAuth`) is
 * mocked to inject a seeded test user; transactions, locking, the deposit/
 * tolerance guards and the partial-unique index are the real production code.
 * All seeded rows use a unique run prefix and are cleaned up.
 *
 * Skips automatically when no real DATABASE_URL is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const { TEST_USER_ID } = vi.hoisted(() => ({
  TEST_USER_ID: `qb_grpg_test_user_${Date.now()}`,
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

const RUN = `qbgrpg_${Date.now()}`;
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

async function seedGift(amount: string): Promise<string> {
  const id = nextGiftId();
  await db.insert(schema.giftsAndPayments).values({
    id,
    amount,
    organizationId: ORG_ID,
  });
  seededGiftIds.push(id);
  return id;
}

/**
 * Seed a staged row. `depositId` is required so each test can opt into the
 * same/different/null deposit it needs; `linkedGiftId` and `autoApplied`
 * default to a clean pending row (status is DERIVED from the ledger — there is
 * no stored column, and the legacy staged gift-link columns are @deprecated,
 * never written). A `linkedGiftId` seeds the counted `payment_applications`
 * ledger row production would have booked.
 */
async function seedStaged(
  giftId: string,
  label: string,
  amount: string,
  opts: {
    depositId: string | null;
    autoApplied?: boolean;
    linkedGiftId?: string | null;
    payerName?: string | null;
    dateReceived?: string | null;
  },
): Promise<string> {
  const id = stagedId(giftId, label);
  await db.insert(schema.stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "deposit",
    qbEntityId: id,
    qbLineId: label,
    amount,
    qbDepositId: opts.depositId,
    autoApplied: opts.autoApplied ?? false,
    payerName: opts.payerName ?? null,
    dateReceived: opts.dateReceived ?? null,
    organizationId: ORG_ID,
  });
  if (opts.linkedGiftId) {
    await db.insert(schema.paymentApplications).values({
      id: `${id}_pa_${opts.linkedGiftId}`,
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

const seededGiftIds: string[] = [];

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
    name: `QB Group Guard Test Org ${RUN}`,
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
  // Clear the ledger first, then delete the staged rows, then the gifts
  // (which cascade-clears any allocation-review rows).
  await clearPaymentApplicationsForRealm(REALM_ID);
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
      "[quickbooks-multi-match-guards] skipped: no live DATABASE_URL configured",
    );
  }
});

/** Assert a staged row is still a clean, untouched pending row. */
async function expectUntouchedPending(id: string) {
  const row = await readStaged(id);
  expect(row.status).toBe("pending");
  expect(await qbCountedRowsForPayment(id)).toHaveLength(0);
  expect(row.approvedByUserId).toBeNull();
  expect(row.matchConfirmedAt).toBeNull();
}

describe.skipIf(!HAS_DB)(
  "QuickBooks multi-match guardrails (integration)",
  () => {
    it("rejects rows from DIFFERENT deposits with 400 not_groupable and changes nothing", async () => {
      const giftId = await seedGift("100.00");
      // Combined 100 == gift, so only the deposit guard (which runs first) can
      // be the reason for rejection.
      const aId = await seedStaged(giftId, "a", "50.00", {
        depositId: `${RUN}_depA`,
      });
      const bId = await seedStaged(giftId, "b", "50.00", {
        depositId: `${RUN}_depB`,
      });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("not_groupable");

      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);
    }, 30_000);

    it("rejects rows with NO deposit with 400 not_groupable and changes nothing", async () => {
      const giftId = await seedGift("100.00");
      const aId = await seedStaged(giftId, "a", "50.00", { depositId: null });
      const bId = await seedStaged(giftId, "b", "50.00", { depositId: null });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("not_groupable");

      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);
    }, 30_000);

    it("accepts rows with NO deposit that share the same payer + date → 200 and reconciles the group", async () => {
      const giftId = await seedGift("120000.00");
      const aId = await seedStaged(giftId, "a", "80000.00", {
        depositId: null,
        payerName: "The Howley Foundation",
        dateReceived: "2025-07-25",
      });
      const bId = await seedStaged(giftId, "b", "40000.00", {
        depositId: null,
        payerName: "The Howley Foundation",
        dateReceived: "2025-07-25",
      });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(200);

      // Both rows flip to reconciled, each with its own counted ledger row.
      const a = await readStaged(aId);
      const b = await readStaged(bId);
      expect(a.status).toBe("match_confirmed");
      expect(b.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(aId)).toBe(giftId);
      expect(await qbSoleGiftIdForPayment(bId)).toBe(giftId);
    }, 30_000);

    it("gates same payer + date but DIFFERENT non-null deposits behind confirmMultiDate, then reconciles", async () => {
      // Real stock-sale gifts settle as one bank deposit per sale, so the same
      // payer legitimately spans multiple distinct deposits. Grouping is allowed
      // but — because crossing a deposit boundary could collapse two genuinely
      // separate same-payer gifts — it requires the operator's explicit
      // confirmation first (same gate as the multi-date case), even when the
      // dates coincide.
      const giftId = await seedGift("100.00");
      const aId = await seedStaged(giftId, "a", "50.00", {
        depositId: `${RUN}_depX`,
        payerName: "Same Payer",
        dateReceived: "2025-01-01",
      });
      const bId = await seedStaged(giftId, "b", "50.00", {
        depositId: `${RUN}_depY`,
        payerName: "Same Payer",
        dateReceived: "2025-01-01",
      });

      const blocked = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });
      expect(blocked.status).toBe(400);
      expect(blocked.json.error).toBe("multi_date_confirmation_required");
      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);

      const ok = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
        confirmMultiDate: true,
      });
      expect(ok.status).toBe(200);
      const a = await readStaged(aId);
      const b = await readStaged(bId);
      expect(a.status).toBe("match_confirmed");
      expect(b.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(aId)).toBe(giftId);
      expect(await qbSoleGiftIdForPayment(bId)).toBe(giftId);
    }, 30_000);

    it("reconciles same payer across DIFFERENT deposits AND dates with confirmMultiDate (the Arthur Rock case)", async () => {
      // The motivating real case: a series of stock sales from one donor over
      // ~24 days, EACH settling as its own bank deposit. Distinct deposits +
      // distinct dates, grouped to one gift after explicit confirmation.
      const giftId = await seedGift("1000000.00");
      const aId = await seedStaged(giftId, "a", "600000.00", {
        depositId: `${RUN}_arA`,
        payerName: "Arthur Rock Foundation",
        dateReceived: "2018-05-22",
      });
      const bId = await seedStaged(giftId, "b", "400000.00", {
        depositId: `${RUN}_arB`,
        payerName: "Arthur Rock Foundation",
        dateReceived: "2018-06-15",
      });

      const blocked = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });
      expect(blocked.status).toBe(400);
      expect(blocked.json.error).toBe("multi_date_confirmation_required");
      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);

      const ok = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
        confirmMultiDate: true,
      });
      expect(ok.status).toBe(200);
      const a = await readStaged(aId);
      const b = await readStaged(bId);
      expect(a.status).toBe("match_confirmed");
      expect(b.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(aId)).toBe(giftId);
      expect(await qbSoleGiftIdForPayment(bId)).toBe(giftId);
    }, 30_000);

    it("needs confirmMultiDate then a corrected gift amount when the Arthur Rock group spans dates/deposits AND its proceeds exceed the gift", async () => {
      // The true production case: appreciated-stock sales over ~24 days, each a
      // separate deposit (needs confirmMultiDate), whose combined proceeds
      // ($1,012,780.49) land ABOVE the $1,000,000 booked gift, outside the fee
      // band. The first attempt surfaces the multi-date gate; confirming only
      // that then trips the amount gate (no override); correcting the gift's
      // amount to the combined total and re-confirming the multi-date span
      // reconciles.
      const giftId = await seedGift("1000000.00");
      const aId = await seedStaged(giftId, "a", "512780.49", {
        depositId: `${RUN}_arBothA`,
        payerName: "Arthur Rock Foundation",
        dateReceived: "2018-05-22",
      });
      const bId = await seedStaged(giftId, "b", "500000.00", {
        depositId: `${RUN}_arBothB`,
        payerName: "Arthur Rock Foundation",
        dateReceived: "2018-06-15",
      });

      const noFlags = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });
      expect(noFlags.status).toBe(400);
      expect(noFlags.json.error).toBe("multi_date_confirmation_required");
      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);

      const dateOnly = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
        confirmMultiDate: true,
      });
      expect(dateOnly.status).toBe(400);
      expect(dateOnly.json.error).toBe("amount_mismatch");
      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);

      // Correct the gift's amount to the combined total, then re-confirm the
      // multi-date span.
      await db
        .update(schema.giftsAndPayments)
        .set({ amount: "1012780.49" })
        .where(inArrayFn(schema.giftsAndPayments.id, [giftId]));

      const corrected = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
        confirmMultiDate: true,
      });
      expect(corrected.status).toBe(200);
      const a = await readStaged(aId);
      const b = await readStaged(bId);
      expect(a.status).toBe("match_confirmed");
      expect(b.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(aId)).toBe(giftId);
      expect(await qbSoleGiftIdForPayment(bId)).toBe(giftId);
    }, 30_000);

    it("rejects same payer but DIFFERENT dates without confirmMultiDate (400 multi_date_confirmation_required) and changes nothing", async () => {
      // A series of stock sales from one donor over several days. Same payer,
      // no deposit, but different dates: groupable in principle, yet the caller
      // must explicitly acknowledge the multi-date span first.
      const giftId = await seedGift("1000000.00");
      const aId = await seedStaged(giftId, "a", "600000.00", {
        depositId: null,
        payerName: "Arthur Rock",
        dateReceived: "2018-05-22",
      });
      const bId = await seedStaged(giftId, "b", "400000.00", {
        depositId: null,
        payerName: "Arthur Rock",
        dateReceived: "2018-06-15",
      });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("multi_date_confirmation_required");

      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);
    }, 30_000);

    it("accepts same payer + DIFFERENT dates WITH confirmMultiDate → 200 and reconciles the group", async () => {
      const giftId = await seedGift("1000000.00");
      const aId = await seedStaged(giftId, "a", "600000.00", {
        depositId: null,
        payerName: "Arthur Rock",
        dateReceived: "2018-05-22",
      });
      const bId = await seedStaged(giftId, "b", "400000.00", {
        depositId: null,
        payerName: "Arthur Rock",
        dateReceived: "2018-06-15",
      });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
        confirmMultiDate: true,
      });

      expect(res.status).toBe(200);

      const a = await readStaged(aId);
      const b = await readStaged(bId);
      expect(a.status).toBe("match_confirmed");
      expect(b.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(aId)).toBe(giftId);
      expect(await qbSoleGiftIdForPayment(bId)).toBe(giftId);
    }, 30_000);

    it("treats a null date as its own distinct date: one real + one null date needs confirmMultiDate", async () => {
      // The client counts null as a distinct date bucket; the server must agree
      // or a mixed null/real-date group opens no confirm dialog yet always 400s.
      const giftId = await seedGift("100.00");
      const aId = await seedStaged(giftId, "a", "50.00", {
        depositId: null,
        payerName: "Mixed Date Donor",
        dateReceived: "2025-01-01",
      });
      const bId = await seedStaged(giftId, "b", "50.00", {
        depositId: null,
        payerName: "Mixed Date Donor",
        dateReceived: null,
      });

      const blocked = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });
      expect(blocked.status).toBe(400);
      expect(blocked.json.error).toBe("multi_date_confirmation_required");
      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);

      const ok = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
        confirmMultiDate: true,
      });
      expect(ok.status).toBe(200);
      const a = await readStaged(aId);
      expect(a.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(aId)).toBe(giftId);
    }, 30_000);

    it("rejects rows sharing ONE deposit but with DIFFERENT payers with 400 not_groupable", async () => {
      // A single bank deposit can batch checks from genuinely different donors.
      // The coherence key is payer-first, so two different payers never group —
      // even inside one deposit. This guards a raw API call from collapsing two
      // donors into one gift, and keeps the server in lockstep with the client,
      // which keys each row by payer and disables selection across payers.
      const giftId = await seedGift("100.00");
      const depositId = `${RUN}_dep_mixed`;
      const aId = await seedStaged(giftId, "a", "50.00", {
        depositId,
        payerName: "Donor One",
        dateReceived: "2025-01-01",
      });
      const bId = await seedStaged(giftId, "b", "50.00", {
        depositId,
        payerName: "Donor Two",
        dateReceived: "2025-01-01",
      });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
        confirmMultiDate: true,
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("not_groupable");

      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);
    }, 30_000);

    it("rejects when a member is already linked to a gift with 409 not_pending and changes nothing", async () => {
      const giftId = await seedGift("100.00");
      const otherGiftId = await seedGift("50.00");
      const depositId = `${RUN}_dep_np`;
      const pendingId = await seedStaged(giftId, "a", "50.00", { depositId });
      // A row is rejected because it already carries a gift link (which derives
      // match_confirmed). The not_pending guard runs before the deposit/
      // tolerance guards, so a shared deposit + matching total prove the
      // rejection is specifically the link.
      const resolvedId = await seedStaged(giftId, "b", "50.00", {
        depositId,
        linkedGiftId: otherGiftId,
      });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [pendingId, resolvedId],
      });

      expect(res.status).toBe(409);
      expect(res.json.error).toBe("not_pending");

      // The still-pending row is untouched.
      await expectUntouchedPending(pendingId);
      // The already-linked row is left exactly as seeded.
      const resolved = await readStaged(resolvedId);
      expect(resolved.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(resolvedId)).toBe(otherGiftId);
    }, 30_000);

    it("accepts an FK-stranded auto-applied row with no gift link and reconciles the whole group", async () => {
      // Repro of the prod bug: a member was auto-matched to a gift, then that
      // gift was deleted, and the gift-link FK's ON DELETE SET NULL cleared the
      // link — stranding the row with auto_applied=true but all three gift
      // links null. With derived status such a row correctly reads `pending`
      // (a proposal requires a live gift link) and must be groupable, not
      // rejected with 409 not_pending.
      const giftId = await seedGift("100.00");
      const depositId = `${RUN}_dep_legacy_ok`;
      const pendingId = await seedStaged(giftId, "a", "50.00", { depositId });
      const strandedId = await seedStaged(giftId, "b", "50.00", {
        depositId,
        autoApplied: true,
      });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [pendingId, strandedId],
      });

      expect(res.status).toBe(200);

      // Both members flip to reconciled and tie to the group's gift via their
      // own counted ledger rows.
      const a = await readStaged(pendingId);
      const b = await readStaged(strandedId);
      expect(a.status).toBe("match_confirmed");
      expect(b.status).toBe("match_confirmed");
      expect(await qbSoleGiftIdForPayment(pendingId)).toBe(giftId);
      expect(await qbSoleGiftIdForPayment(strandedId)).toBe(giftId);
    }, 30_000);

    it("rejects when the gift is already linked outside the group with 409 link_conflict", async () => {
      // Gift the group would reconcile to, sized to pass the tolerance guard.
      const giftId = await seedGift("100.00");
      const depositId = `${RUN}_dep_lc`;
      const aId = await seedStaged(giftId, "a", "50.00", { depositId });
      const bId = await seedStaged(giftId, "b", "50.00", { depositId });
      // A staged row OUTSIDE the group already linked to the same gift — its
      // own deposit doesn't matter; the conflict query keys on the gift link.
      const outsiderId = await seedStaged(giftId, "out", "100.00", {
        depositId: `${RUN}_dep_other`,
        autoApplied: true,
        linkedGiftId: giftId,
      });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [aId, bId],
      });

      expect(res.status).toBe(409);
      expect(res.json.error).toBe("link_conflict");

      // The two group members are untouched.
      await expectUntouchedPending(aId);
      await expectUntouchedPending(bId);
      // The outsider keeps its existing link, unchanged (an unconfirmed
      // auto-match derives match_proposed).
      const outsider = await readStaged(outsiderId);
      expect(await qbSoleGiftIdForPayment(outsiderId)).toBe(giftId);
      expect(outsider.status).toBe("match_proposed");
    }, 30_000);

    it("rejects a single-row array at the schema layer with 400 validation_error and changes nothing", async () => {
      // A literal one-element array never reaches the route's
      // selection_too_small guard: the request schema (minItems: 2) rejects it
      // first.
      const giftId = await seedGift("50.00");
      const onlyId = await seedStaged(giftId, "a", "50.00", {
        depositId: `${RUN}_dep_small`,
      });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [onlyId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("validation_error");

      await expectUntouchedPending(onlyId);
    }, 30_000);

    it("collapses duplicate ids to one row → 400 selection_too_small and changes nothing", async () => {
      // Two distinct ids pass the schema's minItems:2, but the route de-dupes
      // before counting, so the same row twice is a selection of one — this is
      // the path that actually reaches the route's selection_too_small guard.
      const giftId = await seedGift("50.00");
      const onlyId = await seedStaged(giftId, "a", "50.00", {
        depositId: `${RUN}_dep_dup`,
      });

      const res = await api("/api/staged-payments/multi-match", {
        giftId,
        stagedPaymentIds: [onlyId, onlyId],
      });

      expect(res.status).toBe(400);
      expect(res.json.error).toBe("selection_too_small");

      await expectUntouchedPending(onlyId);
    }, 30_000);
  },
);
