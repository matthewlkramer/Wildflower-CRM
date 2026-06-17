-- Migration 0041: staged_payments.matched_rule_id
--
-- Adds a nullable FK column to staged_payments that records which
-- admin-editable quickbooks_handling_rules row caused the payment to be
-- auto-excluded or auto-created+approved at ingest / apply time.
--
-- NULL for:
--   * rows classified by the legacy code-only classifier (classifyStagedPayment)
--   * rows manually classified by a fundraiser
--   * rows that matched no rule at all
--
-- SET NULL on rule delete so audit rows are never orphaned.
--
-- IDEMPOTENCY: the ADD COLUMN is guarded by IF NOT EXISTS so re-running is safe.
-- The FK constraint also uses IF NOT EXISTS so it can be applied before or after
-- a Publish (which also creates the column via the Drizzle diff).

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS matched_rule_id text
    REFERENCES quickbooks_handling_rules(id) ON DELETE SET NULL;
