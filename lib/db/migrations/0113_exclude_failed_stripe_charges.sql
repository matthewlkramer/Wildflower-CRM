-- 0113 — Exclude failed Stripe charges from the review queue (backfill)
--
-- Context: charges whose raw Stripe status is 'failed' (e.g. a bounced ACH
-- debit that Stripe later retries as a NEW charge) were staged as pending real
-- money and could be confirmed onto gifts. The code now auto-classifies failed
-- charges as excluded/failed_charge at ingest AND flips a still-pending row
-- that fails after staging; this backfill applies the same rule to any rows
-- staged before the new code deployed (prod keeps syncing with the old code
-- until Publish).
--
-- Ordering: run AFTER Publish — the 'failed_charge' enum value ships with the
-- schema diff, so this file would fail with "invalid input value for enum"
-- before Publish.
--
-- Safety: idempotent; touches ONLY still-pending, auto-classified rows. Rows a
-- human has resolved (approved / reconciled / rejected / already excluded) or
-- pinned via manual re-include (classification_source = 'manual') are never
-- touched. In particular the wrongly-confirmed Dukes ACH charge
-- (py_1QRxpK..., status 'reconciled') is deliberately NOT touched here — it is
-- reverted in the app, and the revert path now lands failed charges in
-- Excluded automatically.
--
-- Verify by the reported row count (expected: 0 or a small handful — rows
-- staged between the last deploy and Publish), then spot-check:
--   SELECT id, status, exclusion_reason FROM stripe_staged_charges
--   WHERE raw_charge->>'status' = 'failed';

UPDATE stripe_staged_charges
SET status = 'excluded',
    exclusion_reason = 'failed_charge',
    updated_at = now()
WHERE status = 'pending'
  AND classification_source = 'auto'
  AND raw_charge->>'status' = 'failed';
