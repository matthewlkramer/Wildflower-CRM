-- Migration 0104: Physically DROP the three retired off-books header booleans on
-- gifts_and_payments (Task #594). Off-books / payment-exempt now derives ONLY from
-- the allocation entities (entities.expects_payment = false), via giftIsOffBooksExpr()
-- in artifacts/api-server/src/lib/giftPaymentSummary.ts. This is the deferred column
-- DROP that follows the 0103 data backfill.
--
-- DROPS:
--   gifts_and_payments.designated_to_school      header flag — off-books now = allocation on direct_to_school
--   gifts_and_payments.off_books_fiscal_sponsor  header flag — off-books now = allocation on wildflower_foundation_tsne
--   gifts_and_payments.payment_expected          header flag — expects-payment now = any allocation on a payment-bearing entity
--
-- SAFE TO DROP — verified read-only against BOTH dev and prod, AND gated on 0103:
--   * 0103 repointed every header-off-books gift's allocations onto the matching
--     no-payment entity, and its final guard PROVES zero off-books -> on-books
--     flips. Apply 0103 BEFORE this file (0103 reads these columns).
--   * No indexes, FKs, or enum types depend on these plain boolean columns.
--   * The columns are no longer READ or WRITTEN by the new build: the derivation,
--     the audit-reconciliation route, the gift PATCH change-detection, and the
--     split-gift path all use the allocation-only expression; the OpenAPI spec no
--     longer exposes the fields; the UI toggles are gone.
--
-- IF EXISTS -> idempotent / re-runnable (a second run is a no-op).
--
-- ORDERING (prod) — Publish FIRST, THEN this SQL (same direction as 0094). The
-- columns are no longer written, but the currently-deployed prod build still
-- SELECTs them: select()/getTableColumns emit every schema column (the response is
-- scrubbed only AFTER the read). Dropping them before the schema-removal code
-- deploys would 500 every gift read. Publish diffs the dev-DB vs the prod-DB (NOT
-- the schema source), so keep BOTH DBs holding these columns THROUGH Publish (do
-- NOT drop dev alone first, or Publish would see a prod-only column and propose a
-- destructive prod drop that aborts the whole diff). Only AFTER the new code is
-- live in prod apply this file to prod AND dev, back-to-back, with NO Publish in
-- between.
--
-- Apply with psql -1 (wraps the file in ONE transaction; do NOT add BEGIN/COMMIT):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0104_drop_gift_offbooks_header_cols.sql   (prod)
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0104_drop_gift_offbooks_header_cols.sql   (dev)

ALTER TABLE gifts_and_payments
  DROP COLUMN IF EXISTS designated_to_school,
  DROP COLUMN IF EXISTS off_books_fiscal_sponsor,
  DROP COLUMN IF EXISTS payment_expected;

-- Verification (run by hand AFTER applying) -----------------------------------
--   -- All three columns gone (expect ZERO rows):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'gifts_and_payments'
--     AND column_name IN ('designated_to_school','off_books_fiscal_sponsor','payment_expected');
--
--   -- Off-books gifts still derivable from allocations (expect the 49 designated,
--   -- now on direct_to_school, plus any pre-existing no-payment-entity gifts):
--   SELECT count(*) FROM gifts_and_payments g
--   WHERE EXISTS (SELECT 1 FROM gift_allocations ga WHERE ga.gift_id = g.id)
--     AND NOT EXISTS (
--       SELECT 1 FROM gift_allocations ga LEFT JOIN entities e ON e.id = ga.entity_id
--       WHERE ga.gift_id = g.id AND (ga.entity_id IS NULL OR COALESCE(e.expects_payment, true) = true)
--     );
