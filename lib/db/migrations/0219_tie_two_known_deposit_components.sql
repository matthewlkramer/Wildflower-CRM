-- 0219: Tie two known-but-unconnected payments into their bank deposit
-- compositions (reviewed 2026-07-28).
--
-- Two multi-part ATM check deposits had only one component identified; the
-- missing component in each case is an existing, gift-tied payment unit whose
-- QBO Payment evidence matches the composition gap exactly (amount + date):
--
--   bdep_d4b477c8ee046e3dec755fa1 (2017-08-24, $400,250.00, covered $250.00)
--     + pu_HKbdYWATKdwxojr-3IHg4  Strategic Grant Partners  $400,000.00
--   bdep_01600aa855faded33d0823d6 (2019-12-10, $55,000.00, covered $30,000.00)
--     + pu_WJIIm2DiNCi6-hhm44G-F  Mardag Foundation          $25,000.00
--
-- source = 'manual' (human-reviewed tie); source_staged_payment_id keeps the
-- QBO provenance. Idempotent: re-running is a no-op once the components exist.
-- Applied with psql -1 (file-level transaction; no BEGIN/COMMIT here).

-- ── Preflight: abort unless each pair is either already tied or still an
--    exact-gap fit ─────────────────────────────────────────────────────────
DO $$
DECLARE
  r RECORD;
  v_gap numeric;
  v_already boolean;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('bdep_d4b477c8ee046e3dec755fa1', 'pu_HKbdYWATKdwxojr-3IHg4',  400000.00::numeric),
      ('bdep_01600aa855faded33d0823d6', 'pu_WJIIm2DiNCi6-hhm44G-F',   25000.00::numeric)
    ) AS t(dep_id, unit_id, amt)
  LOOP
    -- unit must exist with the expected gross amount
    IF NOT EXISTS (
      SELECT 1 FROM payment_units pu
      WHERE pu.id = r.unit_id AND pu.gross_amount = r.amt
    ) THEN
      RAISE EXCEPTION '0219 preflight: payment unit % missing or amount <> %', r.unit_id, r.amt;
    END IF;

    -- already tied to THIS deposit → idempotent skip is fine
    SELECT EXISTS (
      SELECT 1 FROM bank_deposit_components c
      WHERE c.payment_unit_id = r.unit_id AND c.bank_deposit_id = r.dep_id
    ) INTO v_already;

    IF v_already THEN
      CONTINUE;
    END IF;

    -- tied to a DIFFERENT deposit → never overwrite; abort
    IF EXISTS (
      SELECT 1 FROM bank_deposit_components c WHERE c.payment_unit_id = r.unit_id
    ) THEN
      RAISE EXCEPTION '0219 preflight: unit % is already a component of another deposit', r.unit_id;
    END IF;

    -- remaining gap on the deposit must still equal the unit amount exactly
    SELECT d.amount - COALESCE(
             (SELECT sum(c.amount) FROM bank_deposit_components c
              WHERE c.bank_deposit_id = d.id AND c.exclusion_reason IS NULL), 0)
      INTO v_gap
    FROM bank_deposits d WHERE d.id = r.dep_id;

    IF v_gap IS NULL THEN
      RAISE EXCEPTION '0219 preflight: deposit % not found', r.dep_id;
    END IF;
    IF v_gap <> r.amt THEN
      RAISE EXCEPTION '0219 preflight: deposit % gap is %, expected %', r.dep_id, v_gap, r.amt;
    END IF;
  END LOOP;
END $$;

-- ── The two component rows ────────────────────────────────────────────────
INSERT INTO bank_deposit_components
  (id, bank_deposit_id, payment_unit_id, amount, source,
   source_staged_payment_id, needs_review, created_at, updated_at)
VALUES
  ('bdc_0219_HKbdYWATKdwxojr-3IHg4', 'bdep_d4b477c8ee046e3dec755fa1',
   'pu_HKbdYWATKdwxojr-3IHg4', 400000.00, 'manual',
   'HKbdYWATKdwxojr-3IHg4', false, now(), now()),
  ('bdc_0219_WJIIm2DiNCi6-hhm44G-F', 'bdep_01600aa855faded33d0823d6',
   'pu_WJIIm2DiNCi6-hhm44G-F', 25000.00, 'manual',
   'WJIIm2DiNCi6-hhm44G-F', false, now(), now())
ON CONFLICT (payment_unit_id) DO NOTHING;

-- ── Postflight: both deposits must now be fully composed ─────────────────
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT d.id, d.amount,
           COALESCE((SELECT sum(c.amount) FROM bank_deposit_components c
                     WHERE c.bank_deposit_id = d.id AND c.exclusion_reason IS NULL), 0) AS covered
    FROM bank_deposits d
    WHERE d.id IN ('bdep_d4b477c8ee046e3dec755fa1', 'bdep_01600aa855faded33d0823d6')
  LOOP
    IF r.covered <> r.amount THEN
      RAISE EXCEPTION '0219 postflight: deposit % covered % <> amount %', r.id, r.covered, r.amount;
    END IF;
    RAISE NOTICE '0219: deposit % fully composed (% = %)', r.id, r.covered, r.amount;
  END LOOP;
END $$;
