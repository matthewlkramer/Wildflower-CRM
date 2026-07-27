-- 0208: fix the three over-composed bank deposits (successor of the stale,
-- never-applied 0188 / PR #55, rewritten for the post-retirement model).
--
-- Shape (all three identical): migration-era logic sized one payment unit to
-- the WHOLE deposit (tied to the gift), and the fill-only recompute later
-- added a second component for one of the QBO Deposit's LINES — double
-- counting that line:
--
--   Arthur School FY24  bdep_80e541c591cbfe438a97fbf2  $1,500,000
--     bdc_0172_recPuB4akP0d4AZsN  $1,500,000  (unit→gift, keep)
--     bdc_fe20NzJrK3GYkpymmM9VD     $750,000  (duplicate QBO line, remove)
--   Howley MidAtlantic  bdep_0f2f008c03fed2cf015acab8    $120,000
--     bdc_0172_recnuRi71Ka63HceZ    $120,000  (unit→gift, keep)
--     bdc_5L1YqDSwMIyqx1pnx_0Hl      $40,000  (duplicate QBO line, remove)
--   Fidelity $80k       bdep_fdaf5e42f6f5ac0556ce564b     $80,000
--     bdc_vXurKXgrl7361WZxuOoQv      $80,000  (unit→gift, keep)
--     bdc_2FuX80J7AL1P1FH8GbuWs      $15,000  (duplicate QBO line, remove)
--
-- The duplicate line's accounting provenance is NOT lost: each staged payment
-- keeps its confirmed line-grain source_link (qbo_line_deposit /
-- qbo_line_allocation). Only the money-counting duplicates go: the component,
-- the orphan QBO-inferred unit (gift_id IS NULL), and that unit's links.
--
-- Idempotent (guarded deletes). Prod-only data repair; no Publish needed:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0208_fix_overcomposed_deposits.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

DELETE FROM bank_deposit_components
WHERE id IN ('bdc_fe20NzJrK3GYkpymmM9VD',
             'bdc_5L1YqDSwMIyqx1pnx_0Hl',
             'bdc_2FuX80J7AL1P1FH8GbuWs');

DELETE FROM source_links
WHERE payment_unit_id IN ('pu_fe20NzJrK3GYkpymmM9VD',
                          'pu_5L1YqDSwMIyqx1pnx_0Hl',
                          'pu_2FuX80J7AL1P1FH8GbuWs');

DELETE FROM payment_units
WHERE id IN ('pu_fe20NzJrK3GYkpymmM9VD',
             'pu_5L1YqDSwMIyqx1pnx_0Hl',
             'pu_2FuX80J7AL1P1FH8GbuWs')
  AND gift_id IS NULL;

-- Post-conditions: components now sum to each deposit's amount.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT d.id, d.amount, COALESCE(sum(b.amount), 0) comp_sum
    FROM bank_deposits d
    LEFT JOIN bank_deposit_components b ON b.bank_deposit_id = d.id
    WHERE d.id IN ('bdep_80e541c591cbfe438a97fbf2',
                   'bdep_0f2f008c03fed2cf015acab8',
                   'bdep_fdaf5e42f6f5ac0556ce564b')
    GROUP BY d.id
  LOOP
    IF r.comp_sum <> r.amount THEN
      RAISE EXCEPTION '0208: % components sum to % (expected %)', r.id, r.comp_sum, r.amount;
    END IF;
  END LOOP;
END $$;
