-- 0188: correct two over-composed bank deposits created by the 0172 backfill.
--
-- Migration 0172 planted one component at the whole bank-deposit amount when
-- only one QBO Deposit line had been identified. The fill-only recompute then
-- added the other QBO line as a second component, leaving both deposits
-- over-allocated. The counted ledger currently nets to the correct gift
-- amounts, but the bank-spine composition is wrong.
--
-- For Arthur Rock ($1,500,000; QBO Deposit #29390), resize the 0172 component
-- and its payment unit/application to the true $750,000 line, promote the
-- second $750,000 application from corroborating to counted, and remove the
-- stale provisional QBO component.
--
-- For Howley ($120,000; QBO Deposit #35303), apply the same correction to the
-- $80,000 0172 line and promote the $40,000 corroborating application.
--
-- This is a human-gated, idempotent data correction. Every mutation is scoped
-- to the expected current value or role, so a rerun is a no-op.
--
-- Apply only after review:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0188_fix_overcomposed_deposits.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

UPDATE bank_deposit_components
SET amount = 750000
WHERE id = 'bdc_0172_recPuB4akP0d4AZsN'
  AND amount = 1500000;

UPDATE payment_units
SET gross_amount = 750000,
    net_amount = 750000,
    updated_at = now()
WHERE id = 'pu_8r4tQubAh23RqksEG7OU-'
  AND gross_amount = 1500000
  AND net_amount = 1500000;

UPDATE payment_applications
SET amount_applied = 750000,
    updated_at = now()
WHERE id = '72afed25-5f26-4625-847b-0b1e2d4a4a70'
  AND amount_applied = 1500000
  AND link_role = 'counted';

UPDATE payment_applications
SET link_role = 'counted',
    updated_at = now()
WHERE id = 'e598d172-c72b-487b-93e2-727a80a30e88'
  AND link_role = 'corroborating';

UPDATE bank_deposit_components
SET amount = 80000
WHERE id = 'bdc_0172_recnuRi71Ka63HceZ'
  AND amount = 120000;

UPDATE payment_units
SET gross_amount = 80000,
    net_amount = 80000,
    updated_at = now()
WHERE id = 'pu_rvGhMvR-GdgMw18HYQdcw'
  AND gross_amount = 120000
  AND net_amount = 120000;

UPDATE payment_applications
SET amount_applied = 80000,
    updated_at = now()
WHERE payment_unit_id = 'pu_rvGhMvR-GdgMw18HYQdcw'
  AND link_role = 'counted'
  AND amount_applied = 120000;

UPDATE payment_applications
SET link_role = 'counted',
    updated_at = now()
WHERE payment_unit_id = 'pu_5L1YqDSwMIyqx1pnx_0Hl'
  AND link_role = 'corroborating'
  AND amount_applied = 40000;

DELETE FROM deposit_qbo_components
WHERE id IN (
  'dqc_fe20NzJrK3GYkpymmM9VD',
  'dqc_5L1YqDSwMIyqx1pnx_0Hl'
);

SELECT
  d.id AS bank_deposit_id,
  d.amount AS deposit_amount,
  COALESCE(SUM(c.amount), 0) AS component_amount,
  COUNT(DISTINCT pa.id) FILTER (WHERE pa.link_role = 'counted') AS counted_application_count,
  COUNT(DISTINCT pa.id) FILTER (WHERE pa.link_role = 'corroborating') AS corroborating_application_count,
  (
    SELECT COUNT(*)
    FROM deposit_qbo_components dqc
    WHERE dqc.bank_deposit_id = d.id
  ) AS remaining_deposit_qbo_components
FROM bank_deposits d
LEFT JOIN bank_deposit_components c
  ON c.bank_deposit_id = d.id
LEFT JOIN payment_applications pa
  ON pa.payment_unit_id = c.payment_unit_id
WHERE d.id IN (
  'bdep_80e541c591cbfe438a97fbf2',
  'bdep_0f2f008c03fed2cf015acab8'
)
GROUP BY d.id, d.amount
ORDER BY d.id;
