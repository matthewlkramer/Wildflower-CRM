import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-backed guard for the "Fiscally sponsored" queue split. Money attributed to
 * a fiscally sponsored Wildflower entity (FISCALLY_SPONSORED_ENTITY_IDS) is
 * pass-through for a sponsored project, not a Foundation gift, so it is parked
 * in its own queue and kept OUT of the default needs-review queue to declutter
 * day-to-day reconciliation.
 *
 * The split lives entirely in `queueWhere` (compiled drizzle SQL), so it is
 * otherwise only verified by typecheck. This exercises the genuine where-clauses
 * against the dev Postgres and asserts the actual partition:
 *   - a pending row attributed to a PARKED entity (embracing_equity /
 *     tierra_indigena) lands in `fiscally_sponsored` and is ABSENT from
 *     `needs_review`;
 *   - a pending row with a NULL entity (the Foundation default) stays in
 *     `needs_review` (the `entity_id NOT IN (...)` NULL-safety guard);
 *   - a pending row attributed to a fiscally sponsored entity that is NOT in the
 *     parking list (black_wildflowers_fund) ALSO stays in `needs_review` — the
 *     parking list, not the markers, decides what gets parked;
 *   - a non-pending (excluded) parked-entity row appears in NEITHER pending queue.
 *
 * Mirrors the rest of the QuickBooks integration suite: unique run prefix,
 * realm-scoped cleanup, and skips automatically when no real DATABASE_URL is
 * configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `qbfs_${Date.now()}`;
const REALM_ID = `${RUN}_realm`;

// Two entities in the parking list, one fiscally sponsored entity that is NOT
// parked (proves the parking list — not the markers — gates the queue), and the
// Foundation default (NULL entity_id).
const PARKED_A = "embracing_equity";
const PARKED_B = "tierra_indigena";
const SPONSORED_NOT_PARKED = "black_wildflowers_fund";

type Db = typeof import("@workspace/db");
let db: Db["db"];
let stagedPayments: Db["stagedPayments"];
let andFn: (typeof import("drizzle-orm"))["and"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let queueWhere: (typeof import("../routes/quickbooks/shared"))["queueWhere"];
let queueExpr: (typeof import("../routes/quickbooks/shared"))["queueExpr"];

type StagedInsert = Db["stagedPayments"]["$inferInsert"];

const PARKED_PENDING_A = `${RUN}_parked_a`;
const PARKED_PENDING_B = `${RUN}_parked_b`;
const NULL_PENDING = `${RUN}_null`;
const NOT_PARKED_PENDING = `${RUN}_notparked`;
const PARKED_EXCLUDED = `${RUN}_parked_excluded`;

async function seed(
  id: string,
  opts: { entityId: string | null; status: "pending" | "excluded" },
): Promise<void> {
  await db.insert(stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "sales_receipt",
    qbEntityId: id,
    qbLineId: "",
    amount: "100.00",
    status: opts.status,
    classificationSource: "auto",
    entitySource: "auto",
    entityId: opts.entityId,
  } satisfies StagedInsert);
}

/** IDs (within this run's realm) currently in the given queue. */
async function idsInQueue(
  queue: Parameters<typeof queueWhere>[0],
): Promise<Set<string>> {
  const rows = await db
    .select({ id: stagedPayments.id })
    .from(stagedPayments)
    .where(andFn(eqFn(stagedPayments.realmId, REALM_ID), queueWhere(queue)));
  return new Set(rows.map((r) => r.id));
}

/** Map of this run's row id → queueExpr-derived bucket label. */
async function bucketsById(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: stagedPayments.id, queue: queueExpr })
    .from(stagedPayments)
    .where(eqFn(stagedPayments.realmId, REALM_ID));
  return new Map(rows.map((r) => [r.id, r.queue]));
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  const shared = await import("../routes/quickbooks/shared");
  db = dbMod.db;
  stagedPayments = dbMod.stagedPayments;
  andFn = drizzle.and;
  eqFn = drizzle.eq;
  queueWhere = shared.queueWhere;
  queueExpr = shared.queueExpr;

  await seed(PARKED_PENDING_A, { entityId: PARKED_A, status: "pending" });
  await seed(PARKED_PENDING_B, { entityId: PARKED_B, status: "pending" });
  await seed(NULL_PENDING, { entityId: null, status: "pending" });
  await seed(NOT_PARKED_PENDING, {
    entityId: SPONSORED_NOT_PARKED,
    status: "pending",
  });
  await seed(PARKED_EXCLUDED, { entityId: PARKED_A, status: "excluded" });
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await db.delete(stagedPayments).where(eqFn(stagedPayments.realmId, REALM_ID));
});

describe.skipIf(!HAS_DB)("queueWhere — fiscally sponsored split", () => {
  it(
    "parks only pending, parked-entity money in the fiscally_sponsored queue",
    async () => {
      const fs = await idsInQueue("fiscally_sponsored");
      expect(fs.has(PARKED_PENDING_A)).toBe(true);
      expect(fs.has(PARKED_PENDING_B)).toBe(true);
      // NULL, not-parked, and the excluded parked row must NOT be here.
      expect(fs.has(NULL_PENDING)).toBe(false);
      expect(fs.has(NOT_PARKED_PENDING)).toBe(false);
      expect(fs.has(PARKED_EXCLUDED)).toBe(false);
    },
    30_000,
  );

  it(
    "keeps NULL-entity and non-parked money in needs_review, excludes parked money",
    async () => {
      const nr = await idsInQueue("needs_review");
      // Foundation default (NULL) stays in needs_review.
      expect(nr.has(NULL_PENDING)).toBe(true);
      // A fiscally sponsored entity that is NOT in the parking list stays too.
      expect(nr.has(NOT_PARKED_PENDING)).toBe(true);
      // Parked money is removed from needs_review (the whole point of the split).
      expect(nr.has(PARKED_PENDING_A)).toBe(false);
      expect(nr.has(PARKED_PENDING_B)).toBe(false);
    },
    30_000,
  );

  it(
    "leaves a non-pending parked row out of BOTH pending queues",
    async () => {
      const fs = await idsInQueue("fiscally_sponsored");
      const nr = await idsInQueue("needs_review");
      expect(fs.has(PARKED_EXCLUDED)).toBe(false);
      expect(nr.has(PARKED_EXCLUDED)).toBe(false);
      // It is, however, in the excluded queue.
      const ex = await idsInQueue("excluded");
      expect(ex.has(PARKED_EXCLUDED)).toBe(true);
    },
    30_000,
  );

  it(
    "derives the same buckets via queueExpr as queueWhere selects (no drift)",
    async () => {
      const b = await bucketsById();
      expect(b.get(PARKED_PENDING_A)).toBe("fiscally_sponsored");
      expect(b.get(PARKED_PENDING_B)).toBe("fiscally_sponsored");
      expect(b.get(NULL_PENDING)).toBe("needs_review");
      expect(b.get(NOT_PARKED_PENDING)).toBe("needs_review");
      expect(b.get(PARKED_EXCLUDED)).toBe("excluded");
    },
    30_000,
  );
});
