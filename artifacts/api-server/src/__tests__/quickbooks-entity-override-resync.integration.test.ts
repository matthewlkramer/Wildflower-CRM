import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * DB-backed guard for the manual entity-attribution override surviving a
 * re-sync. Entity attribution (`staged_payments.entity_id`) is normally a
 * read-only derived QuickBooks fact that `detectEntity` refreshes on every
 * pull / reclassify. The ONE exception is a human-pinned attribution
 * (`entity_source = 'manual'`): that is review state, so it must NEVER be
 * clobbered by `detectEntity` — neither in the re-pull upsert CASE
 * (`buildStagedLineUpsert`) nor in `reclassifyStagedPayments`' conditional
 * `entitySet`.
 *
 * The two paths are normally only verified by typecheck (compiled SQL). This
 * exercises the genuine code against the dev Postgres so it asserts the actual
 * DB state: a pinned manual entity is preserved, a manual row CLEARED to NULL
 * stays NULL (the "Sunlight" / corrected-misattribution case — exactly how a
 * row is kept un-attributed across syncs), AND a normal `auto` row IS
 * re-attributed from its markers (proving the guard is targeted, not a blanket
 * freeze).
 *
 * Mirrors the rest of the QuickBooks integration suite: unique run prefix,
 * children-first cleanup, and skips automatically when no real DATABASE_URL is
 * configured. No HTTP/auth is needed — the guard lives in the sync lib, so we
 * call `buildStagedLineUpsert` + `reclassifyStagedPayments` directly (the
 * `/staged-payments/:id/set-entity` route simply writes
 * `entity_source = 'manual'`, which we seed here).
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `qbent_${Date.now()}`;
const REALM_ID = `${RUN}_realm`;

// Two real entity slugs that `detectEntity` produces from its markers
// (ENTITY_MARKERS). "embracing equity" → embracing_equity; "black wildflower"
// → black_wildflowers_fund. Both rows exist in the dev DB (FK targets).
const ENTITY_A = "embracing_equity"; // marker: "embracing equity"
const ENTITY_B = "black_wildflowers_fund"; // marker: "black wildflower"

type Db = typeof import("@workspace/db");
let db: Db["db"];
let stagedPayments: Db["stagedPayments"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let buildStagedLineUpsert: (typeof import("../lib/quickbooksSync"))["buildStagedLineUpsert"];
let reclassifyStagedPayments: (typeof import("../lib/quickbooksSync"))["reclassifyStagedPayments"];

type StagedInsert = Db["stagedPayments"]["$inferInsert"];

/** Seed one pending, auto-classified staged row. */
async function seed(
  id: string,
  opts: {
    entitySource: "auto" | "manual";
    entityId: string | null;
    /** Marker text placed in payer_name so detectEntity has something to find. */
    markerText: string | null;
  },
): Promise<void> {
  await db.insert(stagedPayments).values({
    id,
    realmId: REALM_ID,
    qbEntityType: "sales_receipt",
    qbEntityId: id,
    qbLineId: "",
    amount: "250.00",
    payerName: opts.markerText,
    status: "pending",
    classificationSource: "auto",
    entitySource: opts.entitySource,
    entityId: opts.entityId,
  } satisfies StagedInsert);
}

async function readEntity(
  id: string,
): Promise<{ entityId: string | null; entitySource: string } | undefined> {
  const [row] = await db
    .select({
      entityId: stagedPayments.entityId,
      entitySource: stagedPayments.entitySource,
    })
    .from(stagedPayments)
    .where(eqFn(stagedPayments.id, id));
  return row;
}

/**
 * Re-run the idempotent upsert for a staged row with an INCOMING (freshly
 * detected) entity attribution — simulating the next QuickBooks pull. Mirrors a
 * single staged unit re-pulled by `syncQuickbooks`.
 */
async function repull(id: string, incomingEntityId: string | null): Promise<void> {
  await buildStagedLineUpsert({
    id,
    realmId: REALM_ID,
    qbEntityType: "sales_receipt",
    qbEntityId: id,
    qbLineId: "",
    amount: "250.00",
    entityId: incomingEntityId,
  } satisfies StagedInsert);
}

// Re-pull rows.
const UP_PINNED = `${RUN}_up_pinned`;
const UP_CLEARED = `${RUN}_up_cleared`;
const UP_AUTO = `${RUN}_up_auto`;
// Reclassify rows.
const RC_PINNED = `${RUN}_rc_pinned`;
const RC_CLEARED = `${RUN}_rc_cleared`;
const RC_AUTO = `${RUN}_rc_auto`;

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  const sync = await import("../lib/quickbooksSync");
  db = dbMod.db;
  stagedPayments = dbMod.stagedPayments;
  eqFn = drizzle.eq;
  buildStagedLineUpsert = sync.buildStagedLineUpsert;
  reclassifyStagedPayments = sync.reclassifyStagedPayments;

  // Re-pull rows: a manual pin, a manual clear-to-null, and a plain auto row.
  await seed(UP_PINNED, {
    entitySource: "manual",
    entityId: ENTITY_A,
    markerText: null,
  });
  await seed(UP_CLEARED, {
    entitySource: "manual",
    entityId: null,
    markerText: "Embracing Equity Fund", // would auto-detect, but it's pinned null
  });
  await seed(UP_AUTO, {
    entitySource: "auto",
    entityId: null,
    markerText: null,
  });

  // Reclassify rows: same three shapes, but markers present so detectEntity has
  // a real attribution to (try to) apply during the reclassify pass.
  await seed(RC_PINNED, {
    entitySource: "manual",
    entityId: ENTITY_A,
    markerText: "Black Wildflowers donation", // detect would say ENTITY_B
  });
  await seed(RC_CLEARED, {
    entitySource: "manual",
    entityId: null,
    markerText: "Embracing Equity Fund", // detect would say ENTITY_A
  });
  await seed(RC_AUTO, {
    entitySource: "auto",
    entityId: null,
    markerText: "Embracing Equity Fund", // detect should set ENTITY_A
  });
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await db
    .delete(stagedPayments)
    .where(eqFn(stagedPayments.realmId, REALM_ID));
});

describe.skipIf(!HAS_DB)(
  "QuickBooks re-pull upsert — manual entity override",
  () => {
    it(
      "preserves a human-pinned entity even when the pull carries a different one",
      async () => {
        // The next pull's detector says ENTITY_B; the manual pin must win.
        await repull(UP_PINNED, ENTITY_B);
        const row = await readEntity(UP_PINNED);
        expect(row?.entityId).toBe(ENTITY_A);
        expect(row?.entitySource).toBe("manual");
      },
      30_000,
    );

    it(
      "keeps a manually-cleared (null) attribution null despite an incoming match",
      async () => {
        // The classic "Sunlight" case: pinned to NULL so re-sync can't attribute.
        await repull(UP_CLEARED, ENTITY_A);
        const row = await readEntity(UP_CLEARED);
        expect(row?.entityId).toBeNull();
        expect(row?.entitySource).toBe("manual");
      },
      30_000,
    );

    it(
      "DOES re-attribute a normal auto row from the incoming pull",
      async () => {
        await repull(UP_AUTO, ENTITY_A);
        const row = await readEntity(UP_AUTO);
        expect(row?.entityId).toBe(ENTITY_A);
        expect(row?.entitySource).toBe("auto");
      },
      30_000,
    );
  },
);

describe.skipIf(!HAS_DB)(
  "reclassifyStagedPayments — manual entity override",
  () => {
    it(
      "never re-files a manual row, but re-attributes an auto row from markers",
      async () => {
        await reclassifyStagedPayments();

        // Manual pin survives even though the marker text would detect ENTITY_B.
        const pinned = await readEntity(RC_PINNED);
        expect(pinned?.entityId).toBe(ENTITY_A);
        expect(pinned?.entitySource).toBe("manual");

        // Manual clear-to-null survives even though the marker would detect ENTITY_A.
        const cleared = await readEntity(RC_CLEARED);
        expect(cleared?.entityId).toBeNull();
        expect(cleared?.entitySource).toBe("manual");

        // The auto row IS re-attributed from its marker text.
        const auto = await readEntity(RC_AUTO);
        expect(auto?.entityId).toBe(ENTITY_A);
        expect(auto?.entitySource).toBe("auto");
      },
      30_000,
    );
  },
);
