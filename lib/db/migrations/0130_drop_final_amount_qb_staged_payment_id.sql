-- 0130: Drop the retired gifts_and_payments.final_amount_qb_staged_payment_id
-- column. The counted payment_applications ledger has been the sole QB
-- gift-link source since the read cutover (migration 0120 closed the parity
-- gap); the column was never written or read after that. Migration 0126 already
-- dropped the three staged_payments pointer columns (matched_gift_id /
-- created_gift_id / group_reconciled_gift_id). This completes the set.
--
-- Idempotent: DROP COLUMN IF EXISTS. No BEGIN/COMMIT — apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0130_drop_final_amount_qb_staged_payment_id.sql
--
-- Safety probe (optional, run first): confirm no non-null values remain.
--   SELECT count(*) FROM gifts_and_payments
--    WHERE final_amount_qb_staged_payment_id IS NOT NULL;
-- Count must be 0 (the ledger-backfill in migration 0120 and the null-clear
-- code path in the approve route kept this column empty after the read cutover).

ALTER TABLE gifts_and_payments
  DROP COLUMN IF EXISTS final_amount_qb_staged_payment_id;
