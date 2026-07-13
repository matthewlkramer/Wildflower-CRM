import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * DB-backed coverage for the settlement-bundle SYNC hooks
 * (ensureBundleDraftsForAnchors / refreshOpenBundleDrafts in
 * lib/reconciliationBundleSync.ts), which each money sync (Stripe / QuickBooks /
 * Donorbox) calls to keep drafts in step with fresh source state.
 *
 * The contract under test:
 *   - ensure GENERATES a draft for a settlement anchor that has none,
 *   - ensure is a fingerprint NO-OP when the source is unchanged,
 *   - ensure REFRESHES an un-overridden open draft when the source drifts
 *     (new cached derivation + fingerprint) WITHOUT bumping the revision,
 *   - ensure NEVER clobbers a human-edited draft: its overrides, cached
 *     derivation, fingerprint, and revision are all preserved even when the
 *     source drifts,
 *   - ensure leaves TERMINAL (confirmed / superseded) drafts untouched,
 *   - refreshOpenBundleDrafts refreshes open un-overridden drafts on drift while
 *     skipping overridden + terminal ones.
 *
 * These call the hook functions directly (the sync workers' seam) against a live
 * DB. No money is ever booked by ensure/refresh, so cleanup only removes the
 * seeded payout/charges + drafts. Skips automatically when no real DATABASE_URL
 * is configured.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const RUN = `reconbundlesync_${Date.now()}`;
const ACCOUNT_ID = `${RUN}_acct`;

type Db = typeof import("@workspace/db");
type SyncMod = typeof import("../lib/reconciliationBundleSync");
let db: Db["db"];
let schema: {
  stripePayouts: Db["stripePayouts"];
  stripeStagedCharges: Db["stripeStagedCharges"];
  reconciliationBundleDrafts: Db["reconciliationBundleDrafts"];
};
let eqFn: (typeof import("drizzle-orm"))["eq"];
let andFn: (typeof import("drizzle-orm"))["and"];
let inArrayFn: (typeof import("drizzle-orm"))["inArray"];
let ensureBundleDraftsForAnchors: SyncMod["ensureBundleDraftsForAnchors"];
let refreshOpenBundleDrafts: SyncMod["refreshOpenBundleDrafts"];

const payoutIds: string[] = [];
const chargeIds: string[] = [];
const draftIds: string[] = [];
let seq = 0;
const nextId = (p: string) => `${RUN}_${p}_${String(++seq).padStart(3, "0")}`;

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
  opts: { gross?: string } = {},
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
    payerName: `Zztest Bundle Payer ${RUN}`,
    payerEmail: `${RUN}-payer@example.invalid`,
  });
  chargeIds.push(id);
  return id;
}

async function readDraftByAnchor(payoutId: string) {
  const [row] = await db
    .select()
    .from(schema.reconciliationBundleDrafts)
    .where(
      andFn(
        eqFn(schema.reconciliationBundleDrafts.anchorType, "stripe_payout"),
        eqFn(schema.reconciliationBundleDrafts.anchorId, payoutId),
      ),
    );
  if (row && !draftIds.includes(row.id)) draftIds.push(row.id);
  return row;
}

async function readDraft(id: string) {
  const [row] = await db
    .select()
    .from(schema.reconciliationBundleDrafts)
    .where(eqFn(schema.reconciliationBundleDrafts.id, id));
  return row;
}

const anchor = (payoutId: string) =>
  [{ anchorType: "stripe_payout" as const, anchorId: payoutId }];

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbMod = await import("@workspace/db");
  const drizzle = await import("drizzle-orm");
  const syncMod = await import("../lib/reconciliationBundleSync");
  db = dbMod.db;
  schema = {
    stripePayouts: dbMod.stripePayouts,
    stripeStagedCharges: dbMod.stripeStagedCharges,
    reconciliationBundleDrafts: dbMod.reconciliationBundleDrafts,
  };
  eqFn = drizzle.eq;
  andFn = drizzle.and;
  inArrayFn = drizzle.inArray;
  ensureBundleDraftsForAnchors = syncMod.ensureBundleDraftsForAnchors;
  refreshOpenBundleDrafts = syncMod.refreshOpenBundleDrafts;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
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
}, 60_000);

beforeEach(() => {
  if (!HAS_DB) {
    console.warn(
      "[reconciliation-bundle-sync] skipped: no live DATABASE_URL configured",
    );
  }
});

describe.skipIf(!HAS_DB)("Reconciliation bundle sync hooks (integration)", () => {
  it("generates a draft for a new payout anchor, then no-ops when unchanged", async () => {
    const payoutId = await seedPayout();
    await seedCharge(payoutId);

    const first = await ensureBundleDraftsForAnchors(anchor(payoutId));
    expect(first.created).toBe(1);
    expect(first.refreshed).toBe(0);

    const draft = await readDraftByAnchor(payoutId);
    expect(draft?.status).toBe("open");
    expect(draft?.revision).toBe(1);
    expect(draft?.overrides).toEqual({});
    expect(draft?.sourceFingerprint).toBeTruthy();
    expect((draft?.derivedProposal as any)?.rows).toHaveLength(1);

    // Re-running with no source change is a pure fingerprint no-op.
    const again = await ensureBundleDraftsForAnchors(anchor(payoutId));
    expect(again.created).toBe(0);
    expect(again.refreshed).toBe(0);
    expect(again.skipped).toBe(1);
  });

  it("refreshes an un-overridden open draft when the source drifts (no revision bump)", async () => {
    const payoutId = await seedPayout();
    await seedCharge(payoutId);
    await ensureBundleDraftsForAnchors(anchor(payoutId));
    const before = await readDraftByAnchor(payoutId);
    expect((before?.derivedProposal as any)?.rows).toHaveLength(1);

    // Drift the source: a second charge changes the fingerprint.
    await seedCharge(payoutId);
    const res = await ensureBundleDraftsForAnchors(anchor(payoutId));
    expect(res.refreshed).toBe(1);

    const after = await readDraft(before!.id);
    expect(after?.sourceFingerprint).not.toBe(before?.sourceFingerprint);
    expect((after?.derivedProposal as any)?.rows).toHaveLength(2);
    // A sync refresh never bumps the revision (that's reserved for human edits).
    expect(after?.revision).toBe(1);
    expect(after?.overrides).toEqual({});
  });

  it("never clobbers a human-overridden draft, even when the source drifts", async () => {
    const payoutId = await seedPayout();
    const chargeId = await seedCharge(payoutId);
    await ensureBundleDraftsForAnchors(anchor(payoutId));
    const draft = await readDraftByAnchor(payoutId);

    // Simulate a human edit: persist an override + bump the revision the way the
    // derive endpoint would.
    const overrides = {
      rows: {
        [chargeId]: {
          rowKey: chargeId,
          giftKind: "exclude" as const,
          exclusionReason: "membership" as const,
        },
      },
    };
    await db
      .update(schema.reconciliationBundleDrafts)
      .set({ overrides, revision: 2 })
      .where(eqFn(schema.reconciliationBundleDrafts.id, draft!.id));
    const edited = await readDraft(draft!.id);
    const editedFp = edited?.sourceFingerprint;

    // Drift the source AFTER the human edit.
    await seedCharge(payoutId);
    const res = await ensureBundleDraftsForAnchors(anchor(payoutId));
    expect(res.refreshed).toBe(0);
    expect(res.skipped).toBe(1);

    const after = await readDraft(draft!.id);
    expect(after?.overrides).toEqual(overrides);
    expect(after?.revision).toBe(2);
    // Overridden draft keeps its stored fingerprint so the confirm drift guard
    // stays armed for the editor.
    expect(after?.sourceFingerprint).toBe(editedFp);
  });

  it("leaves terminal (confirmed) drafts untouched", async () => {
    const payoutId = await seedPayout();
    await seedCharge(payoutId);
    await ensureBundleDraftsForAnchors(anchor(payoutId));
    const draft = await readDraftByAnchor(payoutId);

    await db
      .update(schema.reconciliationBundleDrafts)
      .set({ status: "confirmed" })
      .where(eqFn(schema.reconciliationBundleDrafts.id, draft!.id));
    const confirmedFp = (await readDraft(draft!.id))?.sourceFingerprint;

    // Drift the source — a confirmed draft must still be skipped.
    await seedCharge(payoutId);
    const res = await ensureBundleDraftsForAnchors(anchor(payoutId));
    expect(res.skipped).toBe(1);
    expect(res.refreshed).toBe(0);

    const after = await readDraft(draft!.id);
    expect(after?.status).toBe("confirmed");
    expect(after?.sourceFingerprint).toBe(confirmedFp);
  });

  it("refreshOpenBundleDrafts refreshes open un-overridden drafts on drift", async () => {
    const payoutId = await seedPayout();
    await seedCharge(payoutId);
    await ensureBundleDraftsForAnchors(anchor(payoutId));
    const before = await readDraftByAnchor(payoutId);

    // Drift the source, then refresh via the global open-draft pass.
    await seedCharge(payoutId);
    const res = await refreshOpenBundleDrafts();
    expect(res.refreshed).toBeGreaterThanOrEqual(1);

    const after = await readDraft(before!.id);
    expect(after?.sourceFingerprint).not.toBe(before?.sourceFingerprint);
    expect((after?.derivedProposal as any)?.rows).toHaveLength(2);
    expect(after?.revision).toBe(1);
  });
});
