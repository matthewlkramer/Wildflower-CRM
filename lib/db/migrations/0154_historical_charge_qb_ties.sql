-- 0154 — Historical Stripe charge ↔ QuickBooks reconciliation repairs
-- (exports/stripe-payout-qb-audit.md, ratified case list).
--
-- ORDERING: run AFTER Publish has applied the 0153 schema diff
-- (staged_payments.split_parent_id + CHECK). The preflight block aborts
-- with a clear message if it has not.
--
-- Run (from the repo root):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0154_historical_charge_qb_ties.sql
--
-- psql -1 wraps the whole file in ONE transaction — no BEGIN/COMMIT here.
-- Idempotent: every write is keyed on deterministic ids and guarded so a
-- re-run is a no-op; the preflight aborts (rolling back everything) if any
-- referenced row is missing or in an unexpected state.
--
-- What this file does (all ids verified against production 2026-07-22):
--   1. SPLITS two QB rows that bundle several money events into synthetic
--      child reconciliation units (`<parent>:split:<n>`, workbench §7.2):
--        - hTKDdCKpK6t3dfJKqMtKV  "Scott Greenfield" payment  1661.70
--            = +1917.70 (donation net) − 256.00 (unrelated failed-payout
--              reversal the bookkeeper netted into the same row)
--        - lHqCV0qGyidp97JFzSoHc  "Misc Customer"    payment  1378.82
--            = 992.75 + 99.27 + 95.60 + 95.60 + 95.60 (five donations)
--   2. Writes CONFIRMED charge_qb_tie source_links for 19 charges
--      (6 promote existing machine proposals, 13 are new), plus the Tim
--      Welsh charge_fee_row claim on the −284.50 sibling deposit line.
--   3. Mirrors the charge-tie supersede ledger rule for the affected
--      cash applications (chargeTieSupersede.ts, precedent repair 0129):
--        - MOVE (exact-amount, gift not charge-booked): Fisher, Devon,
--          Levine, Bala, Berberian — copy the counted row to the charge
--          grain (match_method charge_tie_supersede), demote the QB row
--          to corroborating (amount kept, reversible).
--        - DEMOTE ONLY (gift already charge-booked — these are live
--          DOUBLE-COUNTS today): Cantoni 2021-12-31, Rivera, Greenfield.
--        - NOTHING (inexact override ties — booking stays on the QB row
--          by design): Essner, Welsh.
--   4. Settlement links:
--        - deletes the stale PROPOSED lump link that let the 2022-08-23
--          payout claim the 2022-07-22 deposit, and confirms that deposit
--          against the payout that actually produced it (Kuthart,
--          arrived 2022-07-21);
--        - confirms the failed 2022-02-02 payout (−256.00) against the
--          Greenfield −256.00 split unit (the reversal's QB evidence);
--        - marks the two negative balance-withdrawal payouts EXEMPT
--          (no QB deposit exists or is expected).
--
-- Deliberately NOT touched:
--   - Bakewell 194.87 (audit: leave as-is).
--   - Scholes ledger: the tied QB row (99.27, gift recAtdBMpZ03Of3Wc) and
--     the charge (gift recYHLtt4GT65pOQT) carry DIFFERENT gifts — a
--     pre-existing cross-gift duplicate a supersede move would turn into a
--     book-once violation. The tie is written (the money is the same);
--     the duplicate gifts need a human decision in the app.
--   - Kuthart-Aug ledger: repair 0129 already moved it; this file only
--     adds the missing tie evidence row.

-- ── Preflight: abort loudly if production is not in the expected state ──
DO $$
DECLARE
  bad text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'staged_payments' AND column_name = 'split_parent_id'
  ) THEN
    RAISE EXCEPTION '0154: staged_payments.split_parent_id missing - Publish the 0153 schema first';
  END IF;

  -- QB staged rows: exist with the audited amounts.
  SELECT string_agg(e.id || ' (expected ' || e.amt || ')', ', ') INTO bad
  FROM (VALUES
    ('XZw9NG1_Ta4lyaPAW5Ya5', 4794.70),
    ('B1evhNJEr56l6WHGqhwXF',  496.38),
    ('Gn7KE2VfTEL6CxWRp2Tky',  239.45),
    ('Qojw5ATkwUaaFZynCYkvR',   47.65),
    ('K-CiqhhjiV8dUOuafpuGe',   47.65),
    ('PMjE01PWL3VXLBZXhIgj1',  248.19),
    ('eY58cEjOB9rluJXXrT9d8',  248.19),
    ('8ol1fhqpgJa1AMPN81FLd', 5099.38),
    ('Qp01YNiqbD7dNTHnwOKUZ',   99.27),
    ('r5x-zmGk8bNc_vgfMJ9qT', 5300.00),
    ('NJV3d5ekiQFDHcCbyfzEZ', -284.50),
    ('oPmu9CQS38V8-QNcxET2u',   49.64),
    ('v3fh5q1adJWuN7NCs04os',   24.82),
    ('EIo2GwmRIRiooNtDHyoAu',   18.88),
    ('vDhl4PxRGQV9xKBwFytfq',   49.64),
    ('hTKDdCKpK6t3dfJKqMtKV', 1661.70),
    ('lHqCV0qGyidp97JFzSoHc', 1378.82)
  ) AS e(id, amt)
  WHERE NOT EXISTS (
    SELECT 1 FROM staged_payments p WHERE p.id = e.id AND p.amount = e.amt
  );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0154: QB staged rows missing or amount changed: %', bad;
  END IF;

  -- Charges: exist.
  SELECT string_agg(e.id, ', ') INTO bad
  FROM (VALUES
    ('ch_3K4WUdAhXr9x8yiR0GgEw5Py'), ('ch_3K4Zq5AhXr9x8yiR1k3hoQVV'),
    ('ch_3K6ZwYAhXr9x8yiR1InFVHaE'), ('ch_3K7Mf3AhXr9x8yiR1Zofog9p'),
    ('ch_3K7hO4AhXr9x8yiR0avGRHJU'), ('ch_3KCrHoAhXr9x8yiR1qEM78H6'),
    ('ch_3KO2ePAhXr9x8yiR1TxWHAeF'), ('ch_3K6hokAhXr9x8yiR04ht7hoq'),
    ('ch_3LoArlAhXr9x8yiR0dtsBBji'), ('ch_1DnaPrAhXr9x8yiRQ7GuxXDq'),
    ('ch_3LYudbAhXr9x8yiR1rzT97il'), ('ch_3LlfhrAhXr9x8yiR0LdlCLMj'),
    ('ch_3LmQ5eAhXr9x8yiR0iMbqF8n'), ('ch_3Ka9uFAhXr9x8yiR05Xfum56'),
    ('ch_3LmFRdAhXr9x8yiR0VicBd8V'), ('ch_3Lm1o5AhXr9x8yiR06m8a8K0'),
    ('ch_3Llz4zAhXr9x8yiR1mQOZct6'), ('ch_3LmGW2AhXr9x8yiR1GTkkPU4'),
    ('ch_3LmLikAhXr9x8yiR1OxWYIRW')
  ) AS e(id)
  WHERE NOT EXISTS (SELECT 1 FROM stripe_staged_charges c WHERE c.id = e.id);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0154: Stripe charges missing: %', bad;
  END IF;

  -- No affected charge may already carry a CONFIRMED tie to a DIFFERENT row.
  SELECT string_agg(sl.id || ' -> ' || sl.qb_staged_payment_id, ', ') INTO bad
  FROM (VALUES
    ('srcl_ct_ch_3K4WUdAhXr9x8yiR0GgEw5Py', 'XZw9NG1_Ta4lyaPAW5Ya5'),
    ('srcl_ct_ch_3K4Zq5AhXr9x8yiR1k3hoQVV', 'B1evhNJEr56l6WHGqhwXF'),
    ('srcl_ct_ch_3K6ZwYAhXr9x8yiR1InFVHaE', 'Gn7KE2VfTEL6CxWRp2Tky'),
    ('srcl_ct_ch_3K7Mf3AhXr9x8yiR1Zofog9p', 'Qojw5ATkwUaaFZynCYkvR'),
    ('srcl_ct_ch_3K7hO4AhXr9x8yiR0avGRHJU', 'K-CiqhhjiV8dUOuafpuGe'),
    ('srcl_ct_ch_3KCrHoAhXr9x8yiR1qEM78H6', 'PMjE01PWL3VXLBZXhIgj1'),
    ('srcl_ct_ch_3KO2ePAhXr9x8yiR1TxWHAeF', 'eY58cEjOB9rluJXXrT9d8'),
    ('srcl_ct_ch_3K6hokAhXr9x8yiR04ht7hoq', '8ol1fhqpgJa1AMPN81FLd'),
    ('srcl_ct_ch_3LoArlAhXr9x8yiR0dtsBBji', 'Qp01YNiqbD7dNTHnwOKUZ'),
    ('srcl_ct_ch_1DnaPrAhXr9x8yiRQ7GuxXDq', 'r5x-zmGk8bNc_vgfMJ9qT'),
    ('srcl_ct_ch_3LYudbAhXr9x8yiR1rzT97il', 'oPmu9CQS38V8-QNcxET2u'),
    ('srcl_ct_ch_3LlfhrAhXr9x8yiR0LdlCLMj', 'v3fh5q1adJWuN7NCs04os'),
    ('srcl_ct_ch_3LmQ5eAhXr9x8yiR0iMbqF8n', 'EIo2GwmRIRiooNtDHyoAu'),
    ('srcl_ct_ch_3Ka9uFAhXr9x8yiR05Xfum56', 'hTKDdCKpK6t3dfJKqMtKV:split:1'),
    ('srcl_ct_ch_3LmFRdAhXr9x8yiR0VicBd8V', 'lHqCV0qGyidp97JFzSoHc:split:1'),
    ('srcl_ct_ch_3Lm1o5AhXr9x8yiR06m8a8K0', 'lHqCV0qGyidp97JFzSoHc:split:2'),
    ('srcl_ct_ch_3Llz4zAhXr9x8yiR1mQOZct6', 'lHqCV0qGyidp97JFzSoHc:split:3'),
    ('srcl_ct_ch_3LmGW2AhXr9x8yiR1GTkkPU4', 'lHqCV0qGyidp97JFzSoHc:split:4'),
    ('srcl_ct_ch_3LmLikAhXr9x8yiR1OxWYIRW', 'lHqCV0qGyidp97JFzSoHc:split:5')
  ) AS e(id, qb)
  JOIN source_links sl ON sl.id = e.id
  WHERE sl.lifecycle = 'confirmed' AND sl.qb_staged_payment_id <> e.qb;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0154: charge already confirmed-tied elsewhere: %', bad;
  END IF;

  -- Existing split children (re-run) must match the planned breakdown, and
  -- the parents must have no UNEXPECTED children.
  SELECT string_agg(p.id || ' (amount ' || p.amount || ')', ', ') INTO bad
  FROM staged_payments p
  LEFT JOIN (VALUES
    ('hTKDdCKpK6t3dfJKqMtKV:split:1', 1917.70),
    ('hTKDdCKpK6t3dfJKqMtKV:split:2', -256.00),
    ('lHqCV0qGyidp97JFzSoHc:split:1',  992.75),
    ('lHqCV0qGyidp97JFzSoHc:split:2',   99.27),
    ('lHqCV0qGyidp97JFzSoHc:split:3',   95.60),
    ('lHqCV0qGyidp97JFzSoHc:split:4',   95.60),
    ('lHqCV0qGyidp97JFzSoHc:split:5',   95.60)
  ) AS e(id, amt) ON e.id = p.id
  WHERE p.split_parent_id IN ('hTKDdCKpK6t3dfJKqMtKV', 'lHqCV0qGyidp97JFzSoHc')
    AND (e.id IS NULL OR p.amount <> e.amt);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0154: parents carry unexpected split children: %', bad;
  END IF;

  -- Greenfield cash application: still the audited row, either untouched on
  -- the parent (first run) or already re-anchored on the child (re-run).
  IF NOT EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.id = '5c4ad0c5-a095-4d8d-9214-5a6c8d87e00f'
      AND pa.gift_id = 'recpUAlMLQGu6NvfL'
      AND pa.amount_applied = 1661.70
      AND (
        (pa.payment_id = 'hTKDdCKpK6t3dfJKqMtKV' AND pa.link_role = 'counted')
        OR (pa.payment_id = 'hTKDdCKpK6t3dfJKqMtKV:split:1'
            AND pa.link_role = 'corroborating')
      )
  ) THEN
    RAISE EXCEPTION '0154: Greenfield application 5c4ad0c5 not in an expected state';
  END IF;

  -- Supersede-move sources: the audited counted rows (or their already-
  -- demoted re-run state) must still say what the audit ratified.
  SELECT string_agg(e.app_id, ', ') INTO bad
  FROM (VALUES
    ('f789ee02-ebb8-4e4e-b150-753d445e2391', 'XZw9NG1_Ta4lyaPAW5Ya5', 'recONiprww19VBU9z', 4794.70),
    ('c9e716f7-27c8-47e5-a248-c79068d0ecf4', 'B1evhNJEr56l6WHGqhwXF', 'recQ8WHkFswkNGQfL',  496.38),
    ('33a65b76-02c3-49f7-bbbc-d9b47b2723cc', 'Gn7KE2VfTEL6CxWRp2Tky', 'reczWTBPIWDUOlOKL',  239.45),
    ('92a24633-bf2e-4fb2-93c2-cbe512a93e34', 'Qojw5ATkwUaaFZynCYkvR', 'recVPAw4NsGEEIcGA',   47.65),
    ('3e93ab6c-d8b9-462b-b3de-0efdbb0b145f', 'K-CiqhhjiV8dUOuafpuGe', 'recVA9A5tkkhQHk6o',   47.65),
    ('3def179e-4e24-4e63-8c64-ba0b178927cc', 'PMjE01PWL3VXLBZXhIgj1', 'recdckIDvvWkcYh5K',  248.19),
    ('b2cee29f-3979-4ed1-8ce2-d6dcb48cb6b9', 'v3fh5q1adJWuN7NCs04os', 'recqa7ZjXEUcVJfqE',   24.82)
  ) AS e(app_id, qb_id, gift_id, amt)
  WHERE NOT EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.id = e.app_id
      AND pa.payment_id = e.qb_id
      AND pa.gift_id = e.gift_id
      AND pa.amount_applied = e.amt
  );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0154: audited cash applications missing or changed: %', bad;
  END IF;

  -- Kuthart redirect: the stale lump link must still be PROPOSED (or gone),
  -- and nothing unexpected may claim the 2022-07-22 deposit.
  IF EXISTS (
    SELECT 1 FROM settlement_links
    WHERE id = 'sl_po_1LZn4TAhXr9x8yiR6RRhNpMe' AND lifecycle <> 'proposed'
  ) THEN
    RAISE EXCEPTION '0154: sl_po_1LZn4T... is no longer a proposal - re-review the Kuthart redirect';
  END IF;
  IF EXISTS (
    SELECT 1 FROM settlement_links
    WHERE deposit_staged_payment_id = 'vDhl4PxRGQV9xKBwFytfq'
      AND payout_id NOT IN ('po_1LZn4TAhXr9x8yiR6RRhNpMe',
                            'po_1LNrqqAhXr9x8yiRHddBDFTz')
  ) THEN
    RAISE EXCEPTION '0154: the 49.64 deposit is claimed by an unexpected payout';
  END IF;
END $$;

-- ── 1. Split the two bundled QB rows into reconciliation units ──────────
-- Mirrors splitStagedPaymentIntoUnits (deterministic ids, parent fields
-- copied, qb_entity_id NULL, classifier/entity pinned to manual).

INSERT INTO staged_payments (
  id, split_parent_id, realm_id, qb_entity_type, qb_deposit_id, amount,
  date_received, payer_name, line_description, qb_deposit_to_account_name,
  classification_source, entity_id, entity_source
)
SELECT
  p.id || ':split:' || u.n, p.id, p.realm_id, p.qb_entity_type,
  p.qb_deposit_id, u.amount, p.date_received,
  COALESCE(u.payer_override, p.payer_name), p.line_description,
  p.qb_deposit_to_account_name, 'manual', p.entity_id, 'manual'
FROM staged_payments p
CROSS JOIN (VALUES
  (1,  1917.70, NULL),
  (2,  -256.00, 'Stripe failed-payout reversal (po_1KOaP5AhXr9x8yiRj2jIRKcN)')
) AS u(n, amount, payer_override)
WHERE p.id = 'hTKDdCKpK6t3dfJKqMtKV'
ON CONFLICT (id) DO NOTHING;

INSERT INTO staged_payments (
  id, split_parent_id, realm_id, qb_entity_type, qb_deposit_id, amount,
  date_received, payer_name, line_description, qb_deposit_to_account_name,
  classification_source, entity_id, entity_source
)
SELECT
  p.id || ':split:' || u.n, p.id, p.realm_id, p.qb_entity_type,
  p.qb_deposit_id, u.amount, p.date_received,
  COALESCE(u.payer_override, p.payer_name), p.line_description,
  p.qb_deposit_to_account_name, 'manual', p.entity_id, 'manual'
FROM staged_payments p
CROSS JOIN (VALUES
  (1, 992.75, 'Mark Ethier'),
  (2,  99.27, 'Brinda Sen'),
  (3,  95.60, 'Lindsey sudbury'),
  (4,  95.60, 'Stephanie Branca'),
  (5,  95.60, 'Kirsti Forrest')
) AS u(n, amount, payer_override)
WHERE p.id = 'lHqCV0qGyidp97JFzSoHc'
ON CONFLICT (id) DO NOTHING;

-- ── 2. Greenfield: re-anchor the human cash application onto the donation
-- unit and demote it (the gift is ALREADY counted on the charge at
-- 2000.00 — today this row double-counts the gift). Amount kept, per the
-- supersede rule (demotion is reversible and never rewrites amounts).
UPDATE payment_applications
SET payment_id = 'hTKDdCKpK6t3dfJKqMtKV:split:1',
    link_role = 'corroborating',
    note = COALESCE(note || ' | ', '')
      || 'migration 0154: re-anchored from split parent hTKDdCKpK6t3dfJKqMtKV; demoted by charge-tie supersede (gift counted on charge ch_3Ka9uFAhXr9x8yiR05Xfum56)',
    updated_at = now()
WHERE id = '5c4ad0c5-a095-4d8d-9214-5a6c8d87e00f'
  AND payment_id = 'hTKDdCKpK6t3dfJKqMtKV';

-- ── 3. Confirmed charge ↔ QB ties (+ the Welsh fee-row claim) ────────────
-- Mirrors upsertConfirmedChargeTie / upsertChargeFeeRowLink. Re-run no-op:
-- the conflict update only fires when something actually differs.
INSERT INTO source_links (
  id, link_type, stripe_charge_id, qb_staged_payment_id,
  lifecycle, provenance, confirmed_by_user_id, confirmed_at, note
)
VALUES
  ('srcl_ct_ch_3K4WUdAhXr9x8yiR0GgEw5Py', 'charge_qb_tie', 'ch_3K4WUdAhXr9x8yiR0GgEw5Py', 'XZw9NG1_Ta4lyaPAW5Ya5', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Shelly Fisher net 4794.70'),
  ('srcl_ct_ch_3K4Zq5AhXr9x8yiR1k3hoQVV', 'charge_qb_tie', 'ch_3K4Zq5AhXr9x8yiR1k3hoQVV', 'B1evhNJEr56l6WHGqhwXF', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Dana Devon net 496.38'),
  ('srcl_ct_ch_3K6ZwYAhXr9x8yiR1InFVHaE', 'charge_qb_tie', 'ch_3K6ZwYAhXr9x8yiR1InFVHaE', 'Gn7KE2VfTEL6CxWRp2Tky', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Jan Levine net 239.45'),
  ('srcl_ct_ch_3K7Mf3AhXr9x8yiR1Zofog9p', 'charge_qb_tie', 'ch_3K7Mf3AhXr9x8yiR1Zofog9p', 'Qojw5ATkwUaaFZynCYkvR', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Denise Bala net 47.65'),
  ('srcl_ct_ch_3K7hO4AhXr9x8yiR0avGRHJU', 'charge_qb_tie', 'ch_3K7hO4AhXr9x8yiR0avGRHJU', 'K-CiqhhjiV8dUOuafpuGe', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Josh Berberian net 47.65'),
  ('srcl_ct_ch_3KCrHoAhXr9x8yiR1qEM78H6', 'charge_qb_tie', 'ch_3KCrHoAhXr9x8yiR1qEM78H6', 'PMjE01PWL3VXLBZXhIgj1', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Erica Cantoni Dec net 248.19'),
  ('srcl_ct_ch_3KO2ePAhXr9x8yiR1TxWHAeF', 'charge_qb_tie', 'ch_3KO2ePAhXr9x8yiR1TxWHAeF', 'eY58cEjOB9rluJXXrT9d8', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Erica Cantoni Jan net 248.19'),
  ('srcl_ct_ch_3K6hokAhXr9x8yiR04ht7hoq', 'charge_qb_tie', 'ch_3K6hokAhXr9x8yiR04ht7hoq', '8ol1fhqpgJa1AMPN81FLd', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Anne Essner - amount mismatch ratified (charge net 4963.76 vs QB 5099.38); drift is derived at read'),
  ('srcl_ct_ch_3LoArlAhXr9x8yiR0dtsBBji', 'charge_qb_tie', 'ch_3LoArlAhXr9x8yiR0dtsBBji', 'Qp01YNiqbD7dNTHnwOKUZ', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Ali Scholes net 99.27 booked as Raphael Gang (c). NOTE: QB row and charge carry different gifts (recAtdBMpZ03Of3Wc vs recYHLtt4GT65pOQT) - possible duplicate gifts, needs human review'),
  ('srcl_ct_ch_1DnaPrAhXr9x8yiRQ7GuxXDq', 'charge_qb_tie', 'ch_1DnaPrAhXr9x8yiRQ7GuxXDq', 'r5x-zmGk8bNc_vgfMJ9qT', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Tim Welsh - QB booked 5300.00 gross-basis vs charge gross 5165.60; mismatch ratified, drift derived at read; sibling -284.50 fee line claimed as fee row'),
  ('srcl_fee_ch_1DnaPrAhXr9x8yiRQ7GuxXDq', 'charge_fee_row', 'ch_1DnaPrAhXr9x8yiRQ7GuxXDq', 'NJV3d5ekiQFDHcCbyfzEZ', 'confirmed', 'system_confirmed', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Tim Welsh -284.50 fee/adjustment line (5300.00 - 284.50 = 5015.50 charge net)'),
  ('srcl_ct_ch_3LYudbAhXr9x8yiR1rzT97il', 'charge_qb_tie', 'ch_3LYudbAhXr9x8yiR1rzT97il', 'oPmu9CQS38V8-QNcxET2u', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Annie Kuthart Aug net 49.64 - completes the repair-0129 retroactive supersede with the tie evidence row'),
  ('srcl_ct_ch_3LlfhrAhXr9x8yiR0LdlCLMj', 'charge_qb_tie', 'ch_3LlfhrAhXr9x8yiR0LdlCLMj', 'v3fh5q1adJWuN7NCs04os', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Jade Rivera net 24.82 booked as Jaders F'),
  ('srcl_ct_ch_3LmQ5eAhXr9x8yiR0iMbqF8n', 'charge_qb_tie', 'ch_3LmQ5eAhXr9x8yiR0iMbqF8n', 'EIo2GwmRIRiooNtDHyoAu', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Yvonne Baicich net 18.88 booked as Misc Customer'),
  ('srcl_ct_ch_3Ka9uFAhXr9x8yiR05Xfum56', 'charge_qb_tie', 'ch_3Ka9uFAhXr9x8yiR05Xfum56', 'hTKDdCKpK6t3dfJKqMtKV:split:1', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Scott Greenfield net 1917.70 - donation unit of the split 1661.70 row'),
  ('srcl_ct_ch_3LmFRdAhXr9x8yiR0VicBd8V', 'charge_qb_tie', 'ch_3LmFRdAhXr9x8yiR0VicBd8V', 'lHqCV0qGyidp97JFzSoHc:split:1', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Mark Ethier net 992.75 - unit of the split Misc Customer 1378.82 row'),
  ('srcl_ct_ch_3Lm1o5AhXr9x8yiR06m8a8K0', 'charge_qb_tie', 'ch_3Lm1o5AhXr9x8yiR06m8a8K0', 'lHqCV0qGyidp97JFzSoHc:split:2', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Brinda Sen net 99.27 - unit of the split Misc Customer 1378.82 row'),
  ('srcl_ct_ch_3Llz4zAhXr9x8yiR1mQOZct6', 'charge_qb_tie', 'ch_3Llz4zAhXr9x8yiR1mQOZct6', 'lHqCV0qGyidp97JFzSoHc:split:3', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Lindsey sudbury net 95.60 - unit of the split Misc Customer 1378.82 row'),
  ('srcl_ct_ch_3LmGW2AhXr9x8yiR1GTkkPU4', 'charge_qb_tie', 'ch_3LmGW2AhXr9x8yiR1GTkkPU4', 'lHqCV0qGyidp97JFzSoHc:split:4', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Stephanie Branca net 95.60 - unit of the split Misc Customer 1378.82 row'),
  ('srcl_ct_ch_3LmLikAhXr9x8yiR1OxWYIRW', 'charge_qb_tie', 'ch_3LmLikAhXr9x8yiR1OxWYIRW', 'lHqCV0qGyidp97JFzSoHc:split:5', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): Kirsti Forrest net 95.60 - unit of the split Misc Customer 1378.82 row')
ON CONFLICT (id) DO UPDATE SET
  qb_staged_payment_id = EXCLUDED.qb_staged_payment_id,
  lifecycle = EXCLUDED.lifecycle,
  provenance = EXCLUDED.provenance,
  confirmed_by_user_id = EXCLUDED.confirmed_by_user_id,
  confirmed_at = now(),
  note = EXCLUDED.note,
  updated_at = now()
WHERE source_links.lifecycle <> 'confirmed'
   OR source_links.qb_staged_payment_id IS DISTINCT FROM EXCLUDED.qb_staged_payment_id;

-- ── 4. Charge-tie supersede: MOVE the five exact-amount counted rows to
-- the charge grain (copy amount + confirming human, per chargeTieSupersede
-- and the repair-0129 precedent) ...
INSERT INTO payment_applications (
  id, evidence_source, stripe_charge_id, gift_id, gift_allocation_id,
  amount_applied, link_role, match_method, confirmed_by_user_id,
  confirmed_at, note, created_the_gift
)
SELECT
  m.new_id, 'stripe', m.charge_id, src.gift_id, src.gift_allocation_id,
  src.amount_applied, 'counted', 'charge_tie_supersede',
  src.confirmed_by_user_id, src.confirmed_at,
  'charge_tie_supersede:' || m.qb_id
    || ' | migration 0154: moved from the tied QB row by retroactive charge-tie supersede',
  false
FROM (VALUES
  ('pacts_0154_fisher',    'ch_3K4WUdAhXr9x8yiR0GgEw5Py', 'XZw9NG1_Ta4lyaPAW5Ya5', 'f789ee02-ebb8-4e4e-b150-753d445e2391'),
  ('pacts_0154_devon',     'ch_3K4Zq5AhXr9x8yiR1k3hoQVV', 'B1evhNJEr56l6WHGqhwXF', 'c9e716f7-27c8-47e5-a248-c79068d0ecf4'),
  ('pacts_0154_levine',    'ch_3K6ZwYAhXr9x8yiR1InFVHaE', 'Gn7KE2VfTEL6CxWRp2Tky', '33a65b76-02c3-49f7-bbbc-d9b47b2723cc'),
  ('pacts_0154_bala',      'ch_3K7Mf3AhXr9x8yiR1Zofog9p', 'Qojw5ATkwUaaFZynCYkvR', '92a24633-bf2e-4fb2-93c2-cbe512a93e34'),
  ('pacts_0154_berberian', 'ch_3K7hO4AhXr9x8yiR0avGRHJU', 'K-CiqhhjiV8dUOuafpuGe', '3e93ab6c-d8b9-462b-b3de-0efdbb0b145f')
) AS m(new_id, charge_id, qb_id, src_app_id)
JOIN payment_applications src ON src.id = m.src_app_id
ON CONFLICT (id) DO NOTHING;

-- ... then demote every superseded QB-side counted row to corroborating
-- (amount kept — reversible). Includes the two DEMOTE-ONLY double-count
-- fixes (Cantoni Dec, Rivera), whose gifts are already counted on their
-- charges at gross.
UPDATE payment_applications
SET link_role = 'corroborating',
    note = COALESCE(note || ' | ', '')
      || 'migration 0154: demoted by charge-tie supersede (booking moved to / already on the tied Stripe charge)',
    updated_at = now()
WHERE id IN (
  'f789ee02-ebb8-4e4e-b150-753d445e2391',
  'c9e716f7-27c8-47e5-a248-c79068d0ecf4',
  '33a65b76-02c3-49f7-bbbc-d9b47b2723cc',
  '92a24633-bf2e-4fb2-93c2-cbe512a93e34',
  '3e93ab6c-d8b9-462b-b3de-0efdbb0b145f',
  '3def179e-4e24-4e63-8c64-ba0b178927cc',
  'b2cee29f-3979-4ed1-8ce2-d6dcb48cb6b9'
)
AND link_role = 'counted';

-- ── 5. Settlement links ──────────────────────────────────────────────────
-- Kuthart redirect: drop the stale machine proposal that let the
-- 2022-08-23 payout claim the 2022-07-22 deposit (that payout's donation
-- is individually booked and tied above)...
DELETE FROM settlement_links
WHERE id = 'sl_po_1LZn4TAhXr9x8yiR6RRhNpMe'
  AND lifecycle = 'proposed';

-- ...and settle the deposit against the payout that actually produced it,
-- plus the failed-payout recovery and the two exempt withdrawals.
INSERT INTO settlement_links (
  id, payout_id, deposit_staged_payment_id, lifecycle, provenance,
  confirmed_by_user_id, confirmed_at, note
)
VALUES
  ('sl_po_1LNrqqAhXr9x8yiRHddBDFTz', 'po_1LNrqqAhXr9x8yiRHddBDFTz', 'vDhl4PxRGQV9xKBwFytfq', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): 49.64 Stripe deposit 2022-07-22 belongs to this payout (arrived 2022-07-21), not the 2022-08-23 payout the matcher proposed'),
  ('sl_po_1KOaP5AhXr9x8yiRj2jIRKcN', 'po_1KOaP5AhXr9x8yiRj2jIRKcN', 'hTKDdCKpK6t3dfJKqMtKV:split:2', 'confirmed', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): failed payout -256.00 recovered via the reversal netted into the 2022-05-31 Scott Greenfield QB payment (split unit 2)'),
  ('sl_po_1IBVSCAhXr9x8yiR7U5OZnaG', 'po_1IBVSCAhXr9x8yiR7U5OZnaG', NULL, 'exempt', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): -0.45 balance-withdrawal payout - no QB deposit exists or is expected'),
  ('sl_po_1Q4FSoAhXr9x8yiRWJGUmxr1', 'po_1Q4FSoAhXr9x8yiRWJGUmxr1', NULL, 'exempt', 'human', 'usr_matthew_kramer', now(), 'migration 0154 (audit): -1023.21 balance-withdrawal payout - no QB deposit exists or is expected')
ON CONFLICT (id) DO UPDATE SET
  deposit_staged_payment_id = EXCLUDED.deposit_staged_payment_id,
  lifecycle = EXCLUDED.lifecycle,
  provenance = EXCLUDED.provenance,
  confirmed_by_user_id = EXCLUDED.confirmed_by_user_id,
  confirmed_at = now(),
  note = EXCLUDED.note,
  updated_at = now()
WHERE settlement_links.lifecycle IS DISTINCT FROM EXCLUDED.lifecycle
   OR settlement_links.deposit_staged_payment_id IS DISTINCT FROM EXCLUDED.deposit_staged_payment_id;
