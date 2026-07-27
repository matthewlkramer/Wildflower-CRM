-- 0212: remove QBO-inferred components that over-fill their deposit.
--
-- 0208 repaired three over-composed deposits (Arthur School FY24, Howley
-- MidAtlantic, Fidelity $80k) by deleting the duplicate QBO-line component,
-- but it left the staged payment in recompute scope: the fill-only recompute
-- re-created the unit (4a) and its component (4b) on the next run, putting
-- the deposits back over their amount. The recompute now caps 4b inserts at
-- the deposit's unexplained remainder (same release as this migration), so
-- this cleanup will not be undone again.
--
-- Scope: uncounted (gift_id IS NULL) qbo_inferred components on deposits
-- whose components sum past the deposit amount, where removing the component
-- brings the sum back within the deposit amount. The line's accounting
-- provenance is untouched: confirmed qbo_line_deposit / qbo_line_allocation
-- source_links on the staged payment remain.
--
-- Order matters: merge + Publish (deploys the recompute guard) BEFORE
-- applying, otherwise the next recompute re-creates these rows. Idempotent.
-- Prod-only data repair:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0212_remove_recompute_overfill_components.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

CREATE TEMP TABLE _0212_victims ON COMMIT DROP AS
SELECT c.id AS component_id, c.payment_unit_id, c.bank_deposit_id, c.amount
FROM bank_deposit_components c
JOIN payment_units u ON u.id = c.payment_unit_id
JOIN bank_deposits d ON d.id = c.bank_deposit_id
WHERE c.source = 'qbo_inferred'
  AND u.gift_id IS NULL
  AND (SELECT sum(x.amount) FROM bank_deposit_components x
       WHERE x.bank_deposit_id = c.bank_deposit_id) > d.amount + 0.005
  AND (SELECT sum(x.amount) FROM bank_deposit_components x
       WHERE x.bank_deposit_id = c.bank_deposit_id) - c.amount
      <= d.amount + 0.005;

DELETE FROM bank_deposit_components
WHERE id IN (SELECT component_id FROM _0212_victims);

DELETE FROM source_links
WHERE payment_unit_id IN (SELECT payment_unit_id FROM _0212_victims);

DELETE FROM payment_units
WHERE id IN (SELECT payment_unit_id FROM _0212_victims)
  AND gift_id IS NULL;

-- Post-conditions: the three known deposits sum exactly to their amounts.
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
      RAISE EXCEPTION '0212: % components sum to % (expected %)', r.id, r.comp_sum, r.amount;
    END IF;
  END LOOP;
END $$;
