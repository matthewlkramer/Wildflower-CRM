-- 0192: physical retirement of the legacy QBO tie mechanisms
-- (docs/adr-qbo-evidence-grain.md §3).
--
-- ⚠ GATE: apply ONLY after
--   (1) 0189–0191 are applied and the 0191 reconcile passed, AND
--   (2) the read cutover has shipped (no code reads bank_deposit_qbo_register,
--       deposit_qbo_components, or staged_payments.settled_stripe_payout_id —
--       verify with the drop-audit playbook), AND
--   (3) a drift check confirms source_links row counts still match the legacy
--       tables at apply time.
--
-- Apply after Publish, by a human:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0192_retire_legacy_qbo_tie_tables.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

DROP TABLE IF EXISTS bank_deposit_qbo_register;
DROP TABLE IF EXISTS deposit_qbo_components;

ALTER TABLE staged_payments DROP COLUMN IF EXISTS settled_stripe_payout_id;

DROP TYPE IF EXISTS deposit_qbo_match_basis;
