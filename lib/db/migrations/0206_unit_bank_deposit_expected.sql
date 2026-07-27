-- 0206: payment_units.bank_deposit_expected — a unit-level marker that this
-- payment's money will never appear as a bank_deposit_components tie because
-- it was deposited outside the covered bank-export accounts. Successor of the
-- entity-level "no payment expected" idea at the DEPOSIT-EVIDENCE plane: these
-- units DO have QBO evidence and gifts; only the bank line is out of coverage.
--
-- Backfills the 33 CSP federal-draw units (owner ruling 2026-07-23): their
-- wires land in an account outside the Wells Fargo exports; only some money
-- was later swept to a covered account via the ONLINE TRANSFER CSP deposits,
-- which are tied separately (0204/0205).
--
-- Apply after merge + Publish, by a human (dev first, then prod):
--   psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0206_unit_bank_deposit_expected.sql
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0206_unit_bank_deposit_expected.sql
--
-- Do not add BEGIN/COMMIT: this file is run with psql -1.

ALTER TABLE payment_units
  ADD COLUMN IF NOT EXISTS bank_deposit_expected boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS bank_deposit_note text;

UPDATE payment_units pu
SET bank_deposit_expected = false,
    bank_deposit_note = 'CSP federal draw deposited to an account outside the covered bank exports (owner ruling 2026-07-23)',
    updated_at = now()
FROM (VALUES
  ('pu_L5URHWp50jJGdqRrJ6f0f'),  -- 2024-04-04 $25,287.00
  ('pu_wFVO0IonkbtU9nQSmEFLV'),  -- 2024-04-04 $66,169.63
  ('pu_OKsMlEsoFMNqO_1RpaUxl'),  -- 2024-04-04 $154,696.09
  ('pu_VoZ5L6yXjdw7CKI931cD_'),  -- 2024-04-04 $64,742.49
  ('pu_EOICyRhWv8gMCkWe8iFPi'),  -- 2024-04-04 $79,654.79
  ('pu_NZUaTQC16nOJWTyFjG5LO'),  -- 2024-04-04 $93,652.12
  ('pu_81whqzPvgp7WP_BIYNTNG'),  -- 2024-04-04 $112,023.31
  ('pu_DqUmp6AVIBspVpguQLWyB'),  -- 2024-04-04 $71,799.11
  ('pu_CCiYD4RYV-sv2sNEAf4m8'),  -- 2024-04-04 $43,643.82
  ('pu_C_2i7NqGwoBTAnc0wQfOn'),  -- 2024-04-17 $2,722.75
  ('pu_gatsqoyHnZT_JFkdMKwQo'),  -- 2024-04-17 $48,636.12
  ('pu_P00l-73BbybvrS4FP4HsS'),  -- 2024-04-17 $12,101.65
  ('pu_r1rAZt0EYgCS89Imme7Gm'),  -- 2024-04-17 $30,124.45
  ('pu_EBA0tllBgxsg8uob7d2wz'),  -- 2024-04-17 $4,957.77
  ('pu_ikb4HCYUYfWEsTW0j9Nyb'),  -- 2024-04-17 $63.33
  ('pu_zVUbAl1_tNP17uHg7syzL'),  -- 2024-07-01 $124,613.68
  ('pu_6Idk3HWaJWuZU0HZdulNk'),  -- 2024-07-12 $57,237.06
  ('pu_XFLKF82PBX1pIAV1SleAm'),  -- 2024-07-15 $70,313.21
  ('pu_zuA5fwhoyj8Vlt9j9-c7G'),  -- 2024-08-05 $212,011.57
  ('pu_IqK33ws2upkhGu3GKQld8'),  -- 2024-11-08 $92,472.95
  ('pu_Wqy-YUL9-9c4hPxvX0do1'),  -- 2024-11-12 $64,141.56
  ('pu_UV-H_5mFOxk9x_fisaX-v'),  -- 2024-11-20 $201,240.99
  ('pu_rvuP94U3_cwsKZGQ5YXYV'),  -- 2024-11-29 $120,081.02
  ('pu_aDVfyRep5VM6XMGu-6sEe'),  -- 2025-01-21 $107,077.88
  ('pu_IPdbW_Ct7zw_32CVZqpjS'),  -- 2025-01-29 $151,558.88
  ('pu_MyHZkH0dOW2mLAOZ4yBzT'),  -- 2025-01-31 $74,979.82
  ('pu_7ZhnSvshBfUpkvYA6gg3W'),  -- 2025-03-14 $50,031.08
  ('pu_M3vNk_xdNgN3Ut_q9kyy6'),  -- 2025-03-17 $61,218.11
  ('pu_mQn0q4yHYHy4vmoLh-opQ'),  -- 2025-09-08 $35,841.30
  ('pu_trXDwBRNM9hyBZfFl0-ao'),  -- 2025-09-10 $171,139.91
  ('pu_KiG3oQn7K9OoY75Vgh3Gk'),  -- 2025-10-27 $159,572.64
  ('pu_YQ5BvmyQbZGsvozTMHTaM'),  -- 2025-11-07 $64,082.23
  ('pu_RnXPFMN36gDQ52D631RMW')   -- 2025-12-04 $52,197.64
) AS v(unit_id)
WHERE pu.id = v.unit_id AND pu.bank_deposit_expected = true;

-- Post-condition: no marked unit has (or later gains, at apply time) a
-- deposit component — the flag means "no bank line exists".
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM payment_units pu
  JOIN bank_deposit_components bdc ON bdc.payment_unit_id = pu.id
  WHERE pu.bank_deposit_expected = false;
  IF bad > 0 THEN
    RAISE EXCEPTION '0206: % units marked bank_deposit_expected=false already carry a deposit component', bad;
  END IF;
END $$;
