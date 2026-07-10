-- 0110: Drop the `issues_to_address` columns (notes now live in cleanup_queue).
--
-- Superseded by cleanup_queue rows minted by 0109. Apply 0109 FIRST, then this
-- file, AFTER Publish, on prod THEN dev back-to-back with NO Publish between.
--
-- Each is a plain scalar `text` column — no index, FK, enum, CHECK, or default
-- depends on it — so nothing else is auto-dropped.
--
-- Idempotent: DROP COLUMN IF EXISTS → a second run is a no-op.

ALTER TABLE staged_payments DROP COLUMN IF EXISTS issues_to_address;
ALTER TABLE stripe_payouts DROP COLUMN IF EXISTS issues_to_address;
ALTER TABLE gifts_and_payments DROP COLUMN IF EXISTS issues_to_address;
