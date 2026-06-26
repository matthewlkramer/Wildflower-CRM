-- Migration 0083: Add an OPTIONAL allocation pointer to the QuickBooks
-- cash-application ledger (payment_applications.gift_allocation_id).
--
-- WHY:
--   The CRM-only reconciliation worklist lists ONE ROW PER gift_allocation and
--   offers both "Link allocation → payment" and "Link gift → payment". The
--   cash-application ledger is per-GIFT (the tie/book-once math is and stays
--   per-gift), so the two actions used to be identical. This column records WHICH
--   allocation the reviewer chose on an allocation-scoped link, so the two
--   actions finally differ in substance, not just wording.
--
-- WHAT THIS FILE DOES:
--   0. Schema safety (idempotent): ADD COLUMN IF NOT EXISTS
--      payment_applications.gift_allocation_id (nullable) + its index.
--   No data backfill: this is a new, nullable, narrowing pointer. Existing ledger
--   rows correctly stay NULL (= recorded against the whole gift header), which is
--   exactly the prior behavior. The tie deriver never reads this column.
--
-- PUBLISH ORDERING (invariant #7): the new column ALSO reaches prod via the
--   normal Publish (drizzle) diff. This ADD COLUMN IF NOT EXISTS makes the file
--   self-contained and safe to run whether or not Publish has already added it.
--   FK is ON DELETE SET NULL so dropping an allocation degrades the row to
--   header-level instead of blocking the delete.
--
-- IDEMPOTENCY / SAFETY:
--   * ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe to re-run.
--   * NOTHING is dropped or backfilled. Pure additive.
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0083_payment_application_allocation_pointer.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.

-- ─── 0. Schema safety (idempotent) ─────────────────────────────────────────
ALTER TABLE payment_applications
  ADD COLUMN IF NOT EXISTS gift_allocation_id text
  REFERENCES gift_allocations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS payment_applications_gift_allocation_id_idx
  ON payment_applications (gift_allocation_id);

-- ─── 1. Operator report (non-aborting) ─────────────────────────────────────
DO $$
DECLARE
  n_total int;
  n_scoped int;
BEGIN
  SELECT count(*) INTO n_total  FROM payment_applications;
  SELECT count(*) INTO n_scoped FROM payment_applications WHERE gift_allocation_id IS NOT NULL;
  RAISE NOTICE '0083: ledger rows total=%, allocation-scoped=% (expect 0 right after rollout)',
    n_total, n_scoped;
END $$;
