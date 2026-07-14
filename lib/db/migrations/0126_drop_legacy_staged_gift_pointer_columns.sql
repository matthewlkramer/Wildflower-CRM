-- 0126: Drop the retired legacy gift-pointer columns from the three staged
-- money tables. The counted payment_applications ledger has been the sole
-- gift-link source since the read cutover; these columns were never read and
-- their last (null-clearing) writes have been removed from the code.
--
-- Idempotent: every statement is IF EXISTS. No BEGIN/COMMIT — apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0126_drop_legacy_staged_gift_pointer_columns.sql
--
-- Safety probe (optional, run first): confirm no non-null values remain.
--   SELECT
--     (SELECT count(*) FROM staged_payments
--       WHERE matched_gift_id IS NOT NULL
--          OR created_gift_id IS NOT NULL
--          OR group_reconciled_gift_id IS NOT NULL) AS staged,
--     (SELECT count(*) FROM stripe_staged_charges
--       WHERE matched_gift_id IS NOT NULL OR created_gift_id IS NOT NULL) AS stripe,
--     (SELECT count(*) FROM donorbox_donations
--       WHERE matched_gift_id IS NOT NULL OR created_gift_id IS NOT NULL) AS donorbox;
-- All three counts must be 0 (the pointer→ledger backfill ran long ago and the
-- null-clear code paths kept them empty). Note: coding_form_rows.matched_gift_id
-- is a DIFFERENT, live column — untouched here.

-- Indexes on the dropped columns (DROP COLUMN would drop them implicitly, but
-- be explicit so the intent is reviewable).
DROP INDEX IF EXISTS staged_payments_matched_gift_id_uq;
DROP INDEX IF EXISTS staged_payments_created_gift_id_uq;
DROP INDEX IF EXISTS staged_payments_group_reconciled_gift_id_idx;
DROP INDEX IF EXISTS stripe_staged_charges_matched_gift_id_uq;
DROP INDEX IF EXISTS stripe_staged_charges_created_gift_id_uq;
DROP INDEX IF EXISTS donorbox_donations_matched_gift_id_uq;
DROP INDEX IF EXISTS donorbox_donations_created_gift_id_uq;

ALTER TABLE staged_payments
  DROP COLUMN IF EXISTS matched_gift_id,
  DROP COLUMN IF EXISTS created_gift_id,
  DROP COLUMN IF EXISTS group_reconciled_gift_id;

ALTER TABLE stripe_staged_charges
  DROP COLUMN IF EXISTS matched_gift_id,
  DROP COLUMN IF EXISTS created_gift_id;

ALTER TABLE donorbox_donations
  DROP COLUMN IF EXISTS matched_gift_id,
  DROP COLUMN IF EXISTS created_gift_id;
