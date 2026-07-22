import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-backed guard for the on-demand donor re-match backfill
 * (`rematchStagedPayments`). Donor auto-matching only runs at INGEST time inside
 * `syncQuickbooks`; the 30-min scheduler never re-scores. So a staged payment
 * pulled before its CRM donor existed (or whose donor was created/renamed later)
 * sits donor-less in the "QBO only" review queue forever — even when an exact
 * name match now exists. `rematchStagedPayments` is the manual, admin-triggered
 * pass that re-scores those rows.
 *
 * Two things this proves against the real dev Postgres:
 *   1. It picks up BOTH `unmatched` AND `suggested` donor-less rows. The
 *      `suggested` half is the easy-to-miss case: a row that once surfaced a weak
 *      hint but never persisted a donor FK would have been skipped by an
 *      `unmatched`-only filter, leaving obvious matches stuck in the queue.
 *   2. It is DONOR-ONLY and non-destructive: an exact name hit sets the donor FK
 *      + `match_status` (high ⇒ `matched`), but it NEVER touches a row that a
 *      human already resolved (one with a donor FK), and it leaves a genuine
 *      no-match row untouched.
 *
 * `rematchStagedPayments` scans every donor-less pending row in the DB, so the
 * assertions here are scoped to this run's unique realm/org ids; other dev rows
 * it may legitimately re-hint are irrelevant to these expectations.
 *
 * Mirrors the rest of the QuickBooks integration suite: unique run prefix,
 * children-first cleanup, and skips automatically when no real DATABASE_URL is
 * configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `qbrem_${Date.now()}`;
const REALM_ID = `${RUN}_realm`;

// A distinctive, run-prefixed org name so the staged payer name is an exact,
// unambiguous trigram winner (similarity 1.0) — i.e. the matcher's `high` tier.
const ORG_ID = `${RUN}_org`;
const ORG_NAME = `${RUN} Zzyx Rematch Acme Holdings`;
// A second, unrelated org used as a human-resolved donor whose name does NOT
// match the payer name — so if the no-clobber guard ever failed, the matcher
// would visibly repoint it to ORG_ID.
const ORG2_ID = `${RUN}_org2`;
const ORG2_NAME = `${RUN} Qwop Unrelated Foundation`;

type Db = typeof import("@workspace/db");
let db: Db["db"];
let stagedPayments: Db["stagedPayments"];
let organizations: Db["organizations"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let rematchStagedPayments: (typeof import("../lib/quickbooksSync"))["rematchStagedPayments"];

type StagedInsert = Db["stagedPayments"]["$inferInsert"];

// A donor-less `unmatched` row whose payer name exactly matches ORG_NAME.
const UNMATCHED_HIT = `${RUN}_unmatched_hit`;
// A donor-less `suggested` row, same exact payer name — the broadened-scope case.
const SUGGESTED_HIT = `${RUN}_suggested_hit`;
// A donor-less `unmatched` row whose payer name matches nothing.
const NO_MATCH = `${RUN}_no_match`;
// A human-resolved row: already carries a donor (ORG2), even though its payer
// name would match ORG. It must be left completely untouched.
const HUMAN_RESOLVED = `${RUN}_human_resolved`;

let summary: Awaited<ReturnType<typeof rematchStagedPayments>>;

async function seed(
  id: string,
  opts: {
    payerName: string | null;
    matchStatus: "unmatched" | "suggested";
    organizationId?: string | null;
  },
): Promise<void> {
  await db.insert(stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "sales_receipt",
    qbEntityId: id,
    qbLineId: "",
    amount: "500.00",
    payerName: opts.payerName,
    classificationSource: "auto",
    matchStatus: opts.matchStatus,
    organizationId: opts.organizationId ?? null,
  } satisfies StagedInsert);
}

async function readRow(id: string): Promise<
  | {
      organizationId: string | null;
      individualGiverPersonId: string | null;
      householdId: string | null;
      matchStatus: string;
      matchScore: number | null;
    }
  | undefined
> {
  const [row] = await db
    .select({
      organizationId: stagedPayments.organizationId,
      individualGiverPersonId: stagedPayments.individualGiverPersonId,
      householdId: stagedPayments.householdId,
      matchStatus: stagedPayments.matchStatus,
      matchScore: stagedPayments.matchScore,
    })
    .from(stagedPayments)
    .where(eqFn(stagedPayments.id, id));
  return row;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  const sync = await import("../lib/quickbooksSync");
  db = dbMod.db;
  stagedPayments = dbMod.stagedPayments;
  organizations = dbMod.organizations;
  eqFn = drizzle.eq;
  rematchStagedPayments = sync.rematchStagedPayments;

  await db.insert(organizations).values([
    { id: ORG_ID, name: ORG_NAME },
    { id: ORG2_ID, name: ORG2_NAME },
  ]);

  await seed(UNMATCHED_HIT, { payerName: ORG_NAME, matchStatus: "unmatched" });
  await seed(SUGGESTED_HIT, { payerName: ORG_NAME, matchStatus: "suggested" });
  await seed(NO_MATCH, {
    payerName: `${RUN} no such donor anywhere`,
    matchStatus: "unmatched",
  });
  await seed(HUMAN_RESOLVED, {
    payerName: ORG_NAME, // would match ORG, but it's already human-resolved to ORG2
    matchStatus: "suggested",
    organizationId: ORG2_ID,
  });

  // Single scan — the assertions below all read the post-rematch state.
  // `rematchStagedPayments` runs under the shared QuickBooks sync lock and
  // no-ops (`ran: false`) when another suite in the parallel run happens to
  // hold it at that instant. Retry with a short backoff until the lock is
  // free — the assertions all require a scan that actually ran.
  summary = await rematchStagedPayments();
  for (let attempt = 0; !summary.ran && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    summary = await rematchStagedPayments();
  }
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await db.delete(stagedPayments).where(eqFn(stagedPayments.realmId, REALM_ID));
  await db.delete(organizations).where(eqFn(organizations.id, ORG_ID));
  await db.delete(organizations).where(eqFn(organizations.id, ORG2_ID));
});

describe.skipIf(!HAS_DB)("rematchStagedPayments — donor re-match backfill", () => {
  it("runs and reports it scanned + matched rows", () => {
    expect(summary.ran).toBe(true);
    // At minimum the two exact-name hits this run seeded.
    expect(summary.matched).toBeGreaterThanOrEqual(2);
    expect(summary.scanned).toBeGreaterThanOrEqual(summary.matched);
  });

  it("re-matches a donor-less UNMATCHED row to its exact-name donor (high tier)", async () => {
    const row = await readRow(UNMATCHED_HIT);
    expect(row?.organizationId).toBe(ORG_ID);
    expect(row?.individualGiverPersonId).toBeNull();
    expect(row?.householdId).toBeNull();
    expect(row?.matchStatus).toBe("matched");
    expect(row?.matchScore).not.toBeNull();
  });

  it("ALSO re-matches a donor-less SUGGESTED row (the broadened scope)", async () => {
    const row = await readRow(SUGGESTED_HIT);
    expect(row?.organizationId).toBe(ORG_ID);
    expect(row?.matchStatus).toBe("matched");
  });

  it("leaves a genuine no-match row untouched (still donor-less + unmatched)", async () => {
    const row = await readRow(NO_MATCH);
    expect(row?.organizationId).toBeNull();
    expect(row?.individualGiverPersonId).toBeNull();
    expect(row?.householdId).toBeNull();
    expect(row?.matchStatus).toBe("unmatched");
  });

  it("never clobbers a human-resolved row that already carries a donor", async () => {
    const row = await readRow(HUMAN_RESOLVED);
    // Donor stays the human-set ORG2 even though the payer name matches ORG.
    expect(row?.organizationId).toBe(ORG2_ID);
  });
});
