-- 0116: Per-charge dismissal memory for charge-grain Stripe↔QuickBooks tie
-- proposals (Task: per-row reject on the Settlement report's "Missing deposit"
-- cards).
--
-- Adds stripe_staged_charges.dismissed_qb_staged_payment_ids — the QB
-- staged_payments ids a reviewer explicitly REJECTED as a proposed tie for
-- this charge. The idempotent charge-grain proposal pass (runChargeTiePass)
-- skips a dismissed charge↔QB pair so a rejected proposal never comes back;
-- the QB row remains a candidate for OTHER charges, and a manual human
-- "Tie selected" still overrides a dismissal. Null/empty = nothing dismissed.
--
-- Additive and idempotent; safe to re-run. No data backfill: the column starts
-- NULL everywhere (no dismissals recorded yet).
-- Apply (from the repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0116_charge_qb_tie_dismissals.sql

ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS dismissed_qb_staged_payment_ids text[];
