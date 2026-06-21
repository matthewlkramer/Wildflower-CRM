-- Migration 0062: Staged-payment funding source + same-physical-gift grouping
--
-- Adds, on staged_payments, the schema behind:
--   1. enum  staged_payment_funding_source
--            (stripe | brokerage | daf | donorbox | paypal | wire_ach |
--             check | cash | employer_match | other)
--   2. enum  staged_payment_funding_source_provenance (auto | manual)
--   3. col   staged_payments.funding_source             (enum, NULLABLE)
--   4. col   staged_payments.funding_source_provenance  (enum, NOT NULL default 'auto')
--   5. col   staged_payments.source_group_id            (text, NULLABLE)
--   6. index staged_payments_funding_source_idx
--   7. index staged_payments_source_group_id_idx
--
-- funding_source = WHERE the money came from / how it rendered (Stripe,
-- brokerage, DAF, ...). It is DISTINCT from qb_payment_method (the QB
-- PaymentMethodRef instrument like "Visa") and from the DERIVED reconciliation
-- "funding lane" (which tracks reconcile progress, not origin). It is
-- auto-seeded at ingest and human-correctable; funding_source_provenance
-- protects a manually-set value from re-pull clobber (mirrors entity_source).
--
-- source_group_id = a shared opaque id tying separately-entered QuickBooks
-- records that are really ONE physical gift, grouping FREELY across different
-- bank deposits AND dates. Pure human review state — the sync never writes it.
--
-- WHY A HAND-APPLIED FILE (not relying on the Publish schema diff alone):
--   drizzle-kit push currently ABORTS on a PRE-EXISTING, unrelated drift in
--   this DB (opportunities `conditions_met` tri-state), which would skip ALL
--   additive changes — including these columns. This file applies the additive
--   schema changes idempotently without touching the drifted column.
--
-- SAFETY / IDEMPOTENCY:
--   * Enum types guarded with pg_type checks; columns/indexes use IF NOT
--     EXISTS — re-running is a no-op.
--   * Purely additive: creates two enums + three columns + two indexes.
--     Touches no existing data and drops nothing.
--   * Every existing row lands at funding_source = NULL (unknown) and
--     funding_source_provenance = 'auto'. Run the backfill afterwards to seed
--     the inferred source for historical rows:
--       pnpm --filter @workspace/api-server run backfill:funding-source
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0062_staged_payment_funding_source_grouping.sql

BEGIN;

-- 1. funding source enum -----------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'staged_payment_funding_source') THEN
    CREATE TYPE staged_payment_funding_source AS ENUM (
      'stripe',
      'brokerage',
      'daf',
      'donorbox',
      'paypal',
      'wire_ach',
      'check',
      'cash',
      'employer_match',
      'other'
    );
  END IF;
END
$$;

-- 2. funding source provenance enum -----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'staged_payment_funding_source_provenance') THEN
    CREATE TYPE staged_payment_funding_source_provenance AS ENUM (
      'auto',
      'manual'
    );
  END IF;
END
$$;

-- 3. funding_source column (nullable) ---------------------------------------
ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS funding_source staged_payment_funding_source;

-- 4. funding_source_provenance column ---------------------------------------
ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS funding_source_provenance
    staged_payment_funding_source_provenance NOT NULL DEFAULT 'auto';

-- 5. source_group_id column (nullable) --------------------------------------
ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS source_group_id text;

-- 6. indexes ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS staged_payments_funding_source_idx
  ON staged_payments (funding_source);
CREATE INDEX IF NOT EXISTS staged_payments_source_group_id_idx
  ON staged_payments (source_group_id);

-- Verification:
--   SELECT column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'staged_payments'
--      AND column_name IN ('funding_source','funding_source_provenance','source_group_id')
--    ORDER BY column_name;
--   -- Expect funding_source NULLABLE (no default); funding_source_provenance
--   -- NOT NULL default 'auto'; source_group_id NULLABLE.
--
--   SELECT unnest(enum_range(NULL::staged_payment_funding_source));
--   -- Expect: stripe, brokerage, daf, donorbox, paypal, wire_ach, check,
--   --         cash, employer_match, other.

COMMIT;
