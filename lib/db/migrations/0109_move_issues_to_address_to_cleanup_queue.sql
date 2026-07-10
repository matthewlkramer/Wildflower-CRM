-- 0109: Move `issues_to_address` free-text notes into the Cleanup Queue.
--
-- The three money tables (staged_payments, stripe_payouts, gifts_and_payments)
-- each carry a free-text `issues_to_address` "something is off here" note from
-- the 0106 finance-review import. That per-row column is being retired in favour
-- of the polymorphic `cleanup_queue`. This file copies every non-empty note into
-- a cleanup_queue row BEFORE 0110 drops the columns.
--
-- Category: reason_code = 'issues_to_address' (a DISTINCT category, NOT
-- 'needs_research') so these notes (a) can never overwrite an existing
-- needs-research flag on the same record and (b) stay a recognisable bucket in
-- the queue. They still appear in the standard open-queue view (the list filters
-- by status, not reason_code).
--
-- Idempotent + order-independent:
--   * ON CONFLICT (target_type, target_id, reason_code) DO NOTHING — re-runs and
--     rows that were already flagged are no-ops (no note is ever clobbered).
--   * Each INSERT is guarded on the source column still existing, so running this
--     file AFTER 0110 has dropped the columns is a clean no-op rather than an
--     error.
-- Deterministic id (`cleanup_ita_<type>_<targetId>`) keeps the PK stable across
-- re-runs.
--
-- Apply order: 0109 (this file) BEFORE 0110. Apply AFTER Publish. `psql -1`
-- wraps the file in one transaction — do NOT add BEGIN/COMMIT.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staged_payments'
      AND column_name = 'issues_to_address'
  ) THEN
    EXECUTE $q$
      INSERT INTO cleanup_queue
        (id, target_type, target_id, reason_code, note, status,
         flagged_at, created_at, updated_at)
      SELECT 'cleanup_ita_sp_' || id, 'staged_payment', id, 'issues_to_address',
             btrim(issues_to_address), 'open', now(), now(), now()
      FROM staged_payments
      WHERE nullif(btrim(issues_to_address), '') IS NOT NULL
      ON CONFLICT (target_type, target_id, reason_code) DO NOTHING
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stripe_payouts'
      AND column_name = 'issues_to_address'
  ) THEN
    EXECUTE $q$
      INSERT INTO cleanup_queue
        (id, target_type, target_id, reason_code, note, status,
         flagged_at, created_at, updated_at)
      SELECT 'cleanup_ita_po_' || id, 'stripe_payout', id, 'issues_to_address',
             btrim(issues_to_address), 'open', now(), now(), now()
      FROM stripe_payouts
      WHERE nullif(btrim(issues_to_address), '') IS NOT NULL
      ON CONFLICT (target_type, target_id, reason_code) DO NOTHING
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'gifts_and_payments'
      AND column_name = 'issues_to_address'
  ) THEN
    EXECUTE $q$
      INSERT INTO cleanup_queue
        (id, target_type, target_id, reason_code, note, status,
         flagged_at, created_at, updated_at)
      SELECT 'cleanup_ita_g_' || id, 'gift', id, 'issues_to_address',
             btrim(issues_to_address), 'open', now(), now(), now()
      FROM gifts_and_payments
      WHERE nullif(btrim(issues_to_address), '') IS NOT NULL
      ON CONFLICT (target_type, target_id, reason_code) DO NOTHING
    $q$;
  END IF;
END $$;
