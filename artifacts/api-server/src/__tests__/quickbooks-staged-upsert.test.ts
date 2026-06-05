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

  it("only refreshes coding while a row is still pending/excluded", () => {
    expect(lower).toContain("where");
    expect(lower).toMatch(/in \('pending', 'excluded'\)/);
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
});
