-- Migration 0093: Physically DROP the 7 orphaned legacy settlement-mirror columns
-- (+ their index) from stripe_payouts. qb_supersede_status is KEPT.
--
-- BACKGROUND. The authoritative Stripe payout <-> QuickBooks deposit settlement now
-- lives in the settlement_links table (lifecycle + deposit_staged_payment_id +
-- conflict_gift_id); the payout's reconciliation status is DERIVED on read via
-- payoutStatusFromLink / payoutStatusLabelSql. The 7 columns dropped here were the
-- legacy mirror that settlement_links replaced. Since the S5 read-flip they have
-- been WRITE-ONLY orphans: the live dual-write still populated them, but NO code
-- path read them. This task's code removes even those writes, leaving them fully
-- dead. This drops:
--   qb_reconciliation_status                 (+ index below)
--   proposed_qb_staged_payment_id            (FK -> staged_payments)
--   matched_qb_staged_payment_id             (FK -> staged_payments)
--   qb_conflict_staged_payment_id            (FK -> staged_payments)
--   qb_conflict_gift_id                      (FK -> gifts_and_payments)
--   qb_reconciliation_confirmed_by_user_id   (FK -> users)
--   qb_reconciliation_confirmed_at
--   stripe_payouts_qb_reconciliation_status_idx   (index on qb_reconciliation_status)
--
-- SAFE TO DROP: settlement_links is the SOLE authoritative home for every
-- payout<->deposit tie; every reader was flipped onto it (payoutStatusFromLink /
-- payoutStatusLabelSql) in a prior release. These columns are unread, and after
-- this task's code deploys they are also unwritten. This CANNOT move a counted
-- dollar: the columns never fed a gift, a paid-amount derivation, or a goal SUM —
-- those flow through gifts_and_payments / gift_allocations / payment_applications,
-- untouched here.
--
-- qb_reconciliation_status is a plain TEXT column (never a pg enum), so there is no
-- enum type to drop. qb_supersede_status is a DIFFERENT concern (the QB-lump
-- supersede audit) and is intentionally NOT dropped.
--
-- IF EXISTS -> idempotent / re-runnable (a second run is a no-op). Dropping a
-- column auto-removes its dependent FK constraints and any index that references
-- only it (so the index drop below is belt-and-suspenders, not strictly required).
--
-- ORDERING (prod) — Publish FIRST, THEN this SQL. This is the REVERSE of 0091.
-- These columns are still WRITTEN by the currently-deployed prod build (the legacy
-- dual-write), so dropping them BEFORE the new code deploys would 500 every payout
-- write. Publish diffs dev-DB vs prod-DB (not the schema source), so keep BOTH DBs
-- holding these columns THROUGH Publish (do NOT drop dev alone first, or Publish
-- would see prod-only columns and propose a destructive prod drop that aborts the
-- whole diff). Only AFTER the new code is live in prod (it no longer writes these
-- columns) apply this file to prod AND dev. See the runbook for the full sequence.
--
-- Apply with psql -1 (wraps the file in ONE transaction; do NOT add BEGIN/COMMIT
-- or it nests and warns):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0093_drop_stripe_payouts_recon_mirror.sql   (dev)
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0093_drop_stripe_payouts_recon_mirror.sql   (prod)

DROP INDEX IF EXISTS stripe_payouts_qb_reconciliation_status_idx;

ALTER TABLE stripe_payouts
  DROP COLUMN IF EXISTS qb_reconciliation_status,
  DROP COLUMN IF EXISTS proposed_qb_staged_payment_id,
  DROP COLUMN IF EXISTS matched_qb_staged_payment_id,
  DROP COLUMN IF EXISTS qb_conflict_staged_payment_id,
  DROP COLUMN IF EXISTS qb_conflict_gift_id,
  DROP COLUMN IF EXISTS qb_reconciliation_confirmed_by_user_id,
  DROP COLUMN IF EXISTS qb_reconciliation_confirmed_at;

-- Verification (run by hand AFTER applying) -----------------------------------
--   -- All 7 columns gone (expect zero rows) + the index gone:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'stripe_payouts'
--     AND column_name IN (
--       'qb_reconciliation_status','proposed_qb_staged_payment_id',
--       'matched_qb_staged_payment_id','qb_conflict_staged_payment_id',
--       'qb_conflict_gift_id','qb_reconciliation_confirmed_by_user_id',
--       'qb_reconciliation_confirmed_at');
--   SELECT to_regclass('public.stripe_payouts_qb_reconciliation_status_idx');  -- expect: NULL
--
--   -- qb_supersede_status is untouched (expect one row):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'stripe_payouts' AND column_name = 'qb_supersede_status';
--
--   -- settlement_links (the authoritative store) is untouched:
--   SELECT lifecycle, count(*) FROM settlement_links GROUP BY 1 ORDER BY 1;
