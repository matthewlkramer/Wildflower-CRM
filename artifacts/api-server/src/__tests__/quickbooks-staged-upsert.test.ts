import { describe, it, expect } from "vitest";

// `buildStagedLineUpsert` imports `@workspace/db`, whose module init throws
// unless DATABASE_URL is set. We never open a connection here (`.toSQL()` only
// compiles the statement), so a dummy URL is enough to clear that guard and
// keep the test runnable with no live database.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

const { buildStagedLineUpsert } = await import("../lib/quickbooksSync");

/**
 * Regression guard for the incremental-sync deposit-coding bug.
 *
 * Deposit-derived coding (account/class/memo) is folded onto a Payment/
 * SalesReceipt from the deposit that re-records it. Deposits are pulled by the
 * same LastUpdatedTime watermark as everything else, so on an incremental
 * re-sync a Payment can be re-pulled (it was edited) while its linked deposit is
 * OLDER than the watermark and therefore absent from the pull — making the
 * freshly-pulled coding arrays empty. The upsert must keep the stored coding in
 * that case instead of clobbering it with empties (preserve-on-conflict).
 *
 * The merge runs in SQL (CASE/coalesce in the ON CONFLICT DO UPDATE SET), so we
 * assert the compiled statement keeps the stored column as the fallback rather
 * than blindly assigning the incoming (possibly empty) value.
 */
describe("buildStagedLineUpsert — preserve-on-conflict coding", () => {
  const compiled = buildStagedLineUpsert({
    id: "test-id",
    realmId: "test-realm",
    qbEntityType: "payment",
    qbEntityId: "QB-123",
    qbLineId: "",
    amount: "100.00",
    lineItemNames: [],
    lineAccountNames: [],
    lineClasses: [],
    lineDescription: null,
  }).toSQL().sql;

  const lower = compiled.toLowerCase();

  it("only refreshes coding while a row is still pending/excluded (derived)", () => {
    expect(lower).toContain("where");
    // The guard is the DERIVED pending/excluded predicate (no stored status
    // column, and the legacy gift-link columns are @deprecated — never read):
    // pending = no counted ledger row + no confirmed settlement link;
    // excluded = exclusion_reason set.
    expect(lower).toContain("settlement_links");
    expect(lower).toContain("payment_applications");
    expect(lower).toContain("link_role");
    expect(lower).not.toContain("matched_gift_id\" is null");
    expect(lower).toContain('"staged_payments"."exclusion_reason" is not null');
  });

  for (const col of ["line_item_names", "line_account_names", "line_classes"]) {
    it(`keeps stored ${col} when the incoming pull has none`, () => {
      // Incoming wins only when non-empty…
      expect(lower).toContain(`cardinality(excluded.${col})`);
      expect(compiled).toContain(`excluded.${col}`);
      // …otherwise the stored column is the fallback (the ELSE branch).
      expect(compiled).toContain(`"staged_payments"."${col}"`);
    });
  }

  it("keeps the stored line_description when the incoming pull is empty/null", () => {
    expect(compiled).toContain("nullif(excluded.line_description, '')");
    expect(compiled).toContain('"staged_payments"."line_description"');
  });

  it("keeps the stored qb_deposit_id when the incoming pull is null", () => {
    // The bank Deposit that re-records a Payment can fall outside the
    // incremental watermark window, so a re-pull may carry a null deposit id.
    // Grouping depends on this id, so it must never be clobbered back to null.
    expect(compiled).toContain("coalesce(excluded.qb_deposit_id");
    expect(compiled).toContain('"staged_payments"."qb_deposit_id"');
  });

  it("still lets a non-empty incoming pull replace the stored coding", () => {
    // Guard against over-preservation: when the new pull DOES carry coding it
    // must win (the THEN branch references the incoming `excluded` value), so a
    // legitimately re-coded payment isn't frozen to its first-seen detail.
    for (const col of ["line_item_names", "line_account_names", "line_classes"]) {
      expect(lower).toMatch(
        new RegExp(`> 0 then excluded\\.${col}`),
      );
    }
    // Memo: a non-empty incoming memo (nullif keeps it) wins over the stored one.
    expect(compiled).toContain("coalesce(nullif(excluded.line_description, '')");
  });

  // The extended QB capture columns are read-only mirrors of the QB record;
  // each must coalesce the incoming value over the stored one (preserve-on-
  // conflict) so an absent field in an incremental pull never blanks a value
  // captured by an earlier full pull.
  const captureCols = [
    "qb_payer_type",
    "qb_payer_id",
    "qb_payment_method",
    "qb_check_number",
    "qb_deposit_to_account_name",
    "qb_doc_number",
    "qb_billing_address",
    "qb_transaction_memo",
    "qb_location",
    "qb_currency",
    "qb_exchange_rate",
    "qb_create_time",
    "qb_linked_txn",
    "qb_raw",
    "qb_raw_line",
  ];
  for (const col of captureCols) {
    it(`coalesces ${col} (incoming wins, stored is the fallback)`, () => {
      expect(compiled).toContain(`coalesce(excluded.${col}`);
      expect(compiled).toContain(`"staged_payments"."${col}"`);
    });
  }
});

/**
 * The full re-pull (enrichAllStatuses) must drop the status `setWhere` guard so
 * approved / rejected rows also receive the new read-only capture fields, while
 * the `set` clause still only touches QB facts — never review columns.
 */
describe("buildStagedLineUpsert — enrichAllStatuses (full re-pull)", () => {
  const base = {
    id: "test-id",
    realmId: "test-realm",
    qbEntityType: "payment" as const,
    qbEntityId: "QB-123",
    qbLineId: "",
    amount: "100.00",
    lineItemNames: [],
    lineAccountNames: [],
    lineClasses: [],
    lineDescription: null,
  };

  it("drops the pending/excluded guard when enriching all statuses", () => {
    const sql = buildStagedLineUpsert(base, { enrichAllStatuses: true })
      .toSQL()
      .sql.toLowerCase();
    // No derived-status guard at all: neither the pending arm's EXISTS probes…
    expect(sql).not.toContain("settlement_links");
    expect(sql).not.toContain("payment_applications");
    // …nor the excluded arm.
    expect(sql).not.toContain('"staged_payments"."exclusion_reason" is not null');
  });

  it("keeps the guard for a normal (incremental) sync", () => {
    const sql = buildStagedLineUpsert(base).toSQL().sql.toLowerCase();
    expect(sql).toContain("settlement_links");
    expect(sql).toContain('"staged_payments"."exclusion_reason" is not null');
  });

  it("never writes review columns on conflict (only QB facts + updatedAt)", () => {
    const sql = buildStagedLineUpsert(base, { enrichAllStatuses: true })
      .toSQL()
      .sql.toLowerCase();
    // The ON CONFLICT SET clause must not touch status / donor / match / gift /
    // approval columns — re-enrichment is read-only w.r.t. review state.
    const setClause = sql.slice(sql.indexOf("do update set"));
    for (const col of [
      '"status"',
      '"match_status"',
      '"matched_gift_id"',
      '"created_gift_id"',
      '"organization_id"',
      '"approved_at"',
      '"rejected_at"',
      '"exclusion_reason"',
    ]) {
      expect(setClause).not.toContain(`${col} =`);
    }
  });
});
