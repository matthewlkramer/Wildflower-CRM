-- 0074_staged_payment_sync_gap.sql
--
-- Adds the `sync_gap` annotation flag to staged_payments. Mirrors the existing
-- `needs_research` flag: a pure human-set annotation (this QuickBooks money
-- exists in the CRM as a gift but was missing from the QuickBooks export) with
-- NO side effects on reconcile status / matching. Additive and non-destructive.
--
-- Idempotent: safe to run more than once.

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS sync_gap boolean NOT NULL DEFAULT false;
