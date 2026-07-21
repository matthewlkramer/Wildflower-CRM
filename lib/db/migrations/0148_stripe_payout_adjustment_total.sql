-- 0148: stripe_payouts.adjustment_total — net of adjustment-type balance
-- transactions (fee refunds, payment_failure_refund reversals, payout_failure
-- recoveries) settling inside a payout. Backfill is NOT done here: rollups are
-- re-derived from Stripe by the admin "full re-pull" (POST /stripe/resync-full)
-- after this ships, which also corrects net_total to the true ledger net and
-- clears the 5 phantom "Settlement gaps" workbench rows.
--
-- ORDERING: apply this file BEFORE Publish. The new code reads AND writes
-- adjustment_total (workbench-clusters hydration + every payout upsert), so if
-- the code ships first the clusters page 500s and Stripe sync fails until the
-- column exists. ADD COLUMN IF NOT EXISTS is harmless to the old running code.
-- Full order: (1) this psql file → (2) Publish → (3) admin "Full re-pull".
-- Idempotent; safe to re-run. No BEGIN/COMMIT (applied with psql -1).

ALTER TABLE stripe_payouts
  ADD COLUMN IF NOT EXISTS adjustment_total numeric(14, 2);
