-- Migration 0117: Drop the STORED reconciliation status machinery — status is
-- now fully DERIVED from facts.
--
-- BACKGROUND. staged_payments and stripe_staged_charges no longer carry a
-- stored lifecycle status. A row's status is derived at read time from facts
-- (artifacts/api-server/src/lib/derivedStatus.ts is the single source of
-- truth), emitted in the new vocabulary
-- pending | match_proposed | match_confirmed | excluded:
--
--   excluded        ⇐ exclusion_reason IS NOT NULL
--   match_proposed  ⇐ auto_applied AND match_confirmed_at IS NULL AND a
--                     matched/created gift link
--   match_confirmed ⇐ any gift link (matched/created/group-reconciled), a
--                     CONFIRMED settlement link naming the row as the deposit
--                     lump (QB only), or a counted payment_applications ledger
--                     row anchored on the row (QB only — covers splits)
--   pending         ⇐ none of the above
--
-- "rejected" is removed from the model entirely (reject endpoints + the
-- rejected queue are gone). The one-time BACKFILL below maps any legacy
-- human-rejected row to the excluded lane (exclusion_reason = 'other') BEFORE
-- the status column is dropped, so a row a human already dispositioned can
-- never re-enter the live pending queue. It also heals the (never-observed)
-- anomaly of status = 'excluded' with a NULL exclusion_reason.
--
-- This drops:
--   staged_payments.status                                (+ its index)
--   staged_payments.rejected_at
--   staged_payments.rejected_by_user_id
--   stripe_staged_charges.status                          (+ its index)
--   stripe_staged_charges.rejected_at
--   stripe_staged_charges.rejected_by_user_id
--   stripe_staged_charges.dismissed_qb_staged_payment_ids
--   stripe_payouts.qb_supersede_status                    (+ its index)
--   reconciliation_proposals            (whole table — route + UI removed)
--   financial_correction_dismissals     (whole table — dismiss endpoint removed)
--
-- NOT dropped:
--   - the staged_payment_status pg enum TYPE — donorbox_donations.status still
--     uses it (Donorbox keeps its stored column; the API maps it to the new
--     vocabulary at the edge).
--   - match_status / match_score / match_confirmed_at / the three gift-link
--     columns — these are the FACTS the derivation reads.
--   - duplicate_dismissals, unit_groups, settlement_links, bundle drafts,
--     stripe_payouts.status — all still live.
--
-- IDEMPOTENT / re-runnable: the backfill runs only while the status columns
-- still exist (dynamic SQL guarded by information_schema), and every drop uses
-- IF EXISTS.
--
-- ORDERING (prod) — Publish FIRST, THEN this SQL, then the SAME file on dev,
-- back-to-back. The currently-deployed prod build still WRITES these columns
-- (approve/exclude/reject set status), so dropping them before the new code
-- deploys would 500 live writes. Publish diffs dev-DB vs prod-DB, so BOTH DBs
-- must keep holding the columns THROUGH Publish (do NOT drop dev alone first,
-- or Publish would propose a destructive prod drop that aborts the diff).
-- See the runbook (0117_derive_reconciliation_status_RUNBOOK.md).
--
-- Apply with psql -1 (wraps the file in ONE transaction; do NOT add
-- BEGIN/COMMIT or it nests and warns):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0117_derive_reconciliation_status.sql   (prod)
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0117_derive_reconciliation_status.sql   (dev)

-- BACKFILL: preserve human "rejected" dispositions as excluded/other before
-- the stored status is dropped. Runs inside the same psql -1 transaction as
-- the drops; skips (NOTICE) when the columns are already gone.
DO $$
DECLARE
  n bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'staged_payments'
      AND column_name = 'status'
  ) THEN
    EXECUTE $sql$
      UPDATE staged_payments
      SET exclusion_reason = 'other'
      WHERE status IN ('rejected', 'excluded')
        AND exclusion_reason IS NULL
    $sql$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'staged_payments: % legacy rejected/reason-less-excluded row(s) mapped to exclusion_reason = other.', n;
  ELSE
    RAISE NOTICE 'staged_payments.status already dropped — backfill skipped.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stripe_staged_charges'
      AND column_name = 'status'
  ) THEN
    EXECUTE $sql$
      UPDATE stripe_staged_charges
      SET exclusion_reason = 'other'
      WHERE status IN ('rejected', 'excluded')
        AND exclusion_reason IS NULL
    $sql$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'stripe_staged_charges: % legacy rejected/reason-less-excluded row(s) mapped to exclusion_reason = other.', n;
  ELSE
    RAISE NOTICE 'stripe_staged_charges.status already dropped — backfill skipped.';
  END IF;
END $$;

-- Column drops (dependent indexes — staged_payments_status_idx,
-- stripe_staged_charges_status_idx, stripe_payouts_supersede_status_idx —
-- drop automatically with their columns).
ALTER TABLE staged_payments
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS rejected_at,
  DROP COLUMN IF EXISTS rejected_by_user_id;

ALTER TABLE stripe_staged_charges
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS rejected_at,
  DROP COLUMN IF EXISTS rejected_by_user_id,
  DROP COLUMN IF EXISTS dismissed_qb_staged_payment_ids;

ALTER TABLE stripe_payouts
  DROP COLUMN IF EXISTS qb_supersede_status;

-- Dead aux stores (route + UI removed in this release).
DROP TABLE IF EXISTS reconciliation_proposals;
DROP TABLE IF EXISTS financial_correction_dismissals;

-- Verification (run by hand AFTER applying) -----------------------------------
--   -- Columns gone (expect 0 rows):
--   SELECT table_name, column_name FROM information_schema.columns
--   WHERE (table_name IN ('staged_payments','stripe_staged_charges')
--          AND column_name IN ('status','rejected_at','rejected_by_user_id',
--                              'dismissed_qb_staged_payment_ids'))
--      OR (table_name = 'stripe_payouts' AND column_name = 'qb_supersede_status');
--
--   -- Tables gone (expect NULL, NULL):
--   SELECT to_regclass('public.reconciliation_proposals'),
--          to_regclass('public.financial_correction_dismissals');
--
--   -- The enum type survives for Donorbox (expect 1 row):
--   SELECT typname FROM pg_type WHERE typname = 'staged_payment_status';
--
--   -- No row silently re-entered pending: note the backfill NOTICE counts
--   -- printed during apply ("N legacy rejected/reason-less-excluded row(s)
--   -- mapped") — those rows are now visible in the excluded queue under
--   -- reason 'other':
--   SELECT count(*) FROM staged_payments WHERE exclusion_reason = 'other';
--   SELECT count(*) FROM stripe_staged_charges WHERE exclusion_reason = 'other';
