-- 0205: fix the 2026-04-09 CSP deposit's composition (owner ruling
-- 2026-07-23: "two components/two gifts").
--
-- 0204 created a synthetic gift (csp-gift-mar26-opex-ic) for the $210,713.94
-- "MAR26 CSP OP EXP AND IC OCT TO MAR" deposit because no exact-amount gift
-- existed. In fact TWO existing CSP accounting records/gifts sum exactly to
-- it: $101,487.02 (csp-gift-u8lShRnmV5lpoRK4eMj3v) + $109,226.92
-- (csp-gift-_3nebfQ8NtS37AUHkoaKz) — the wire covered both draws.
--
-- This removes the synthetic gift/allocation/unit/component and gives the
-- deposit two components pointing at the two existing gifts' units.
--
-- Idempotent (deterministic ids, fill-only inserts, guarded deletes).
--
-- Apply after merge, by a human (no Publish needed — migration only):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0205_csp_mar26_two_component_fix.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

------------------------------------------------------------------------------
-- 1. Remove the 0204 synthetic records.
------------------------------------------------------------------------------
DELETE FROM bank_deposit_components WHERE id = 'bdc_csp_1e7808d2d64a202cd3296ffa';
DELETE FROM payment_units WHERE id = 'pu_csp-mar26-opex-ic';
DELETE FROM gift_allocations WHERE id = 'csp-ga-mar26-opex-ic';
DELETE FROM gifts_and_payments WHERE id = 'csp-gift-mar26-opex-ic';

------------------------------------------------------------------------------
-- 2. Two components: the deposit decomposes into the two existing CSP units.
------------------------------------------------------------------------------
INSERT INTO bank_deposit_components
  (id, bank_deposit_id, payment_unit_id, amount, source, needs_review,
   classification_source)
SELECT 'bdc_csp2_' || replace(m.unit_id, 'pu_', ''),
       'bdep_1e7808d2d64a202cd3296ffa', m.unit_id, m.amt, 'manual', false,
       'manual'
FROM (VALUES
  ('pu_u8lShRnmV5lpoRK4eMj3v', 101487.02),
  ('pu__3nebfQ8NtS37AUHkoaKz', 109226.92)
) AS m(unit_id, amt)
WHERE EXISTS (SELECT 1 FROM payment_units pu WHERE pu.id = m.unit_id)
ON CONFLICT (id) DO NOTHING;

------------------------------------------------------------------------------
-- 3. Post-conditions.
------------------------------------------------------------------------------
DO $$
DECLARE n int; s numeric;
BEGIN
  SELECT count(*), COALESCE(sum(amount), 0) INTO n, s
  FROM bank_deposit_components
  WHERE bank_deposit_id = 'bdep_1e7808d2d64a202cd3296ffa';
  IF n <> 2 OR s <> 210713.94 THEN
    RAISE EXCEPTION '0205: deposit has % components summing to % (expected 2 / 210713.94)', n, s;
  END IF;
  IF EXISTS (SELECT 1 FROM gifts_and_payments WHERE id = 'csp-gift-mar26-opex-ic') THEN
    RAISE EXCEPTION '0205: synthetic 0204 gift still present';
  END IF;
END $$;
