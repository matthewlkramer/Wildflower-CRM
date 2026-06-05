-- Migration 0017: Add quickbooks_customer_id columns to donor entities
--
-- Adds a nullable text column `quickbooks_customer_id` to three tables so a CRM
-- donor (or a payment intermediary the money routes through) can be linked to
-- its QuickBooks Online Customer Id. This enables deterministic matching of
-- incoming QuickBooks payments to the correct CRM record instead of relying
-- solely on name/email heuristics.
--
--   organizations          — grant-makers and other external orgs (donors).
--   people                 — individual givers.
--   payment_intermediaries — DAFs / giving platforms money is routed through.
--
-- SAFETY / IDEMPOTENCY:
--   * Purely additive. ADD COLUMN IF NOT EXISTS makes re-running a no-op.
--   * The column is nullable with no default, so adding it is a metadata-only
--     change in PostgreSQL (no table rewrite, no row locks beyond a brief
--     ACCESS EXCLUSIVE to update the catalog) and touches no existing data.
--   * Nothing is backfilled or modified; existing rows get NULL.
--
-- Apply with:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0017_quickbooks_customer_id_columns.sql

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS quickbooks_customer_id text;

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS quickbooks_customer_id text;

ALTER TABLE payment_intermediaries
  ADD COLUMN IF NOT EXISTS quickbooks_customer_id text;
