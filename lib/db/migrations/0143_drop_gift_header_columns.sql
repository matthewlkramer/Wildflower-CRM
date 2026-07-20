-- Migration 0143: Drop retired gift header columns
-- (renumbered from 0140 on 2026-07-20 to resolve a triple-0140 numbering
-- collision; the drops are already in effect in prod — re-running is a no-op)
--
-- Drops columns that have been fully retired:
--   - gifts_and_payments.type (gift type is now fully DERIVED at query time
--     by deriveGiftTypeExpr in api-server; loan_or_grant is the sole loan signal)
--   - gifts_and_payments.quickbooks_tie_status (now LIVE-DERIVED at query time
--     by deriveGiftQbTieLiveExpr; never persisted, never stale)
--   - gifts_and_payments.final_amount_stripe_charge_id (Stripe linkage is
--     authoritative on payment_applications ledger; backfilled by migration 0130)
--   - gifts_and_payments.coding_form_circle (folded into gifts.tags by 0131)
--   - gifts_and_payments.coding_form_series (folded into gifts.tags by 0131)
--   - gifts_and_payments.coding_form_additional_notes (folded into gifts.tags by 0131)
--   - gifts_and_payments.coding_form_memo (folded into gifts.tags by 0131)
--
-- Also drops the index on the retired quickbooks_tie_status column.
--
-- SAFE TO RE-RUN (all statements use IF EXISTS).
-- Apply AFTER the new api-server build is deployed (the deployed build no longer
-- reads or writes any of these columns).
--
-- Run against prod:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0143_drop_gift_header_columns.sql

-- Drop the index first (before the column it depends on)
DROP INDEX IF EXISTS gifts_and_payments_quickbooks_tie_status_idx;

-- Drop the FK constraint on final_amount_stripe_charge_id before dropping the column
ALTER TABLE gifts_and_payments
  DROP CONSTRAINT IF EXISTS gifts_and_payments_final_amount_stripe_charge_id_fkey;

-- Drop all seven retired columns
ALTER TABLE gifts_and_payments
  DROP COLUMN IF EXISTS type,
  DROP COLUMN IF EXISTS quickbooks_tie_status,
  DROP COLUMN IF EXISTS final_amount_stripe_charge_id,
  DROP COLUMN IF EXISTS coding_form_circle,
  DROP COLUMN IF EXISTS coding_form_series,
  DROP COLUMN IF EXISTS coding_form_additional_notes,
  DROP COLUMN IF EXISTS coding_form_memo;
