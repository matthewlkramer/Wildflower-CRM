-- 0216: add staged_payment_exclusion_reason value 'non_wf'.
--
-- Deposit-level "not Wildflower's money" ruling: money that landed in the
-- account but belongs to some other party entirely (misdirected deposits,
-- funds held for others). Distinct from intercompany_transfer (movement
-- between the org's own entities) and returned_wire (the org's own outbound
-- wire bouncing back).
--
-- ADD VALUE cannot run inside a transaction block — run this file with
-- autocommit (no -1 flag):
--   psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0216_add_non_wf_exclusion_reason.sql
--
-- Idempotent: IF NOT EXISTS.

ALTER TYPE staged_payment_exclusion_reason ADD VALUE IF NOT EXISTS 'non_wf';
