-- 0177: clean up eight legacy Stripe-funded, QBO-deposit-grain counted
-- payment_applications.
--
-- Background (docs/adr-bank-spine-money-model.md):
--   These eight rows are `payment_applications` counted onto a CRM gift from a
--   whole QBO *Deposit* record (funding_source='stripe', evidence_source=
--   'quickbooks'), created before deposits were broken into Stripe charges. In
--   the bank-spine model the counted grain is the Stripe *charge* unit, so
--   these deposit-grain hand-counts are legacy leftovers. None ever received a
--   payment_unit_id (0162 deliberately skips stripe-funded QBO rows).
--
-- Reviewed disposition (one-time, human-reviewed set — NOT a rule):
--   * #1 Tim & Liz Welsh — the Stripe charge exists (ch_1Dna…, net 5015.50 =
--     gift amount) and is counted nowhere else, so it is the only real
--     unit→gift link for this money. RE-POINT the application onto the charge
--     unit (evidence_source='stripe').
--   * #2/#3/#5/#8 — the matching Stripe charge is already counted onto another
--     (duplicate / mis-assigned) gift, so the QBO-deposit row is a redundant
--     double count. DELETE it; the duplicate gifts are handled in the workbench.
--   * #4/#6/#7 — no Stripe charge exists on file (loose bundle link / no
--     imported charge / recurring aggregate). DELETE the orphan hand-count.
--
-- Deleting a payment_applications row removes only the money→gift link; the
-- gift record itself is untouched.
--
-- APPLY:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0177_cleanup_stripe_deposit_grain_qbo_applications.sql
--
-- Idempotent: the re-point is guarded on the QBO source state and the deletes
-- are by id, so a second run is a no-op. Final assertions verify the end state.

CREATE TEMP TABLE cleanup_0177_rows (
  application_id text PRIMARY KEY,
  gift_id text NOT NULL,
  payment_id text NOT NULL,
  disposition text NOT NULL,          -- 'repoint' | 'delete'
  stripe_charge_id text,              -- only for the re-point row
  stripe_unit_id text,               -- only for the re-point row
  applied_amount numeric(14, 2)       -- only for the re-point row (= gift amount)
) ON COMMIT DROP;

INSERT INTO cleanup_0177_rows
  (application_id, gift_id, payment_id, disposition, stripe_charge_id, stripe_unit_id, applied_amount)
VALUES
  -- #1 re-point onto the real Stripe charge unit
  ('e53bed92-e79c-44fe-9b46-eb6ac4585e94', 'recPv9I7pNMcohfKT', 'r5x-zmGk8bNc_vgfMJ9qT',
   'repoint', 'ch_1DnaPrAhXr9x8yiRQ7GuxXDq', 'pu_ch_1DnaPrAhXr9x8yiRQ7GuxXDq', 5015.50),
  -- #2/#3/#5/#8 charge already counted on another gift -> delete redundant QBO count
  ('fd4133b0-1f3d-42af-940a-5cd87fefb3ac', 'rec5zYlQZnqKKbQCU', '4xofH29oI7mJehqCs_LnN', 'delete', NULL, NULL, NULL),
  ('ff39c455-0ee4-46ca-a248-9d572f9989c5', 'reckIVxI6eATh2iiR', 'mnQdPUGT8pfN7T2pdq969', 'delete', NULL, NULL, NULL),
  ('NcREIplmwERjlOYM1VpZp',                'O19isipf8UIhokCX94iCu', 'R2a_3l4HEIV7b4sWIAfjO', 'delete', NULL, NULL, NULL),
  ('ba9f21c5-f58c-4872-a005-3aa4516d19eb', 'recZSxsRDgJqrSDrn', 'HBMCx4zihjPifFJyzIUmN', 'delete', NULL, NULL, NULL),
  -- #4/#6/#7 no Stripe charge on file -> delete orphan hand-count
  ('ce3204e4-3e75-4b8d-a50d-49f043f6caed', 'recaLAe7qirGgQkzl', 'rIXQS0f1ZOEUu5XIGoUiM', 'delete', NULL, NULL, NULL),
  ('eba9ee95-82bc-44d7-b67d-265c0e73ce4d', 'recZ23F2OXVPavxjN', '3YMyUVHR5ujepsV6M9DdC', 'delete', NULL, NULL, NULL),
  ('E-V1bTcY_aEsppw-1LGM8',                'T2Bl-PstVN5e49wEjq2a2', 'vJMgivAfhF8cvJwrty_Zp', 'delete', NULL, NULL, NULL);

-- Before-state evidence.
SELECT
  r.disposition,
  pa.id AS application_id,
  pa.gift_id,
  g.name AS gift_name,
  pa.amount_applied,
  pa.evidence_source,
  pa.link_role,
  pa.payment_id,
  pa.stripe_charge_id,
  pa.payment_unit_id
FROM cleanup_0177_rows r
LEFT JOIN payment_applications pa ON pa.id = r.application_id
LEFT JOIN gifts_and_payments g ON g.id = r.gift_id
ORDER BY r.disposition, pa.amount_applied DESC NULLS LAST;

-- Safety gates for the single re-point (skip cleanly if already applied).
DO $$
DECLARE
  r RECORD;
BEGIN
  SELECT * INTO r FROM cleanup_0177_rows WHERE disposition = 'repoint';

  -- Only enforce when the row is still in its original QBO-deposit shape.
  IF EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.id = r.application_id AND pa.evidence_source = 'quickbooks'
  ) THEN
    -- The target Stripe charge and its unit must exist.
    IF NOT EXISTS (SELECT 1 FROM stripe_staged_charges c WHERE c.id = r.stripe_charge_id) THEN
      RAISE EXCEPTION '0177: re-point charge % not found', r.stripe_charge_id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM payment_units pu
      WHERE pu.id = r.stripe_unit_id AND pu.stripe_charge_id = r.stripe_charge_id
    ) THEN
      RAISE EXCEPTION '0177: re-point unit % not found for charge %', r.stripe_unit_id, r.stripe_charge_id;
    END IF;
    -- The charge/unit must not already carry a different counted application.
    IF EXISTS (
      SELECT 1 FROM payment_applications pa
      WHERE pa.link_role = 'counted'
        AND pa.id <> r.application_id
        AND (pa.stripe_charge_id = r.stripe_charge_id OR pa.payment_unit_id = r.stripe_unit_id)
    ) THEN
      RAISE EXCEPTION '0177: re-point charge/unit already counted elsewhere';
    END IF;
  END IF;
END
$$;

-- Re-point #1 onto the Stripe charge unit. Guarded on the original QBO state
-- so a re-run is a no-op.
UPDATE payment_applications pa
SET evidence_source = 'stripe',
    stripe_charge_id = r.stripe_charge_id,
    payment_unit_id = r.stripe_unit_id,
    payment_id = NULL,
    amount_applied = r.applied_amount,
    note = CASE
      WHEN pa.note IS NULL OR pa.note = ''
        THEN 'repair 0177: re-anchored from QBO Stripe deposit to the Stripe charge unit'
      ELSE pa.note || ' | repair 0177: re-anchored from QBO Stripe deposit to the Stripe charge unit'
    END,
    updated_at = now()
FROM cleanup_0177_rows r
WHERE pa.id = r.application_id
  AND r.disposition = 'repoint'
  AND pa.evidence_source = 'quickbooks';

-- Delete the seven redundant / orphan QBO-deposit-grain counts.
DELETE FROM payment_applications pa
USING cleanup_0177_rows r
WHERE pa.id = r.application_id
  AND r.disposition = 'delete';

-- After-state evidence.
SELECT
  r.disposition,
  r.application_id,
  pa.id IS NOT NULL AS still_present,
  pa.gift_id,
  pa.amount_applied,
  pa.evidence_source,
  pa.link_role,
  pa.stripe_charge_id,
  pa.payment_unit_id
FROM cleanup_0177_rows r
LEFT JOIN payment_applications pa ON pa.id = r.application_id
ORDER BY r.disposition, r.application_id;

-- Final assertions.
DO $$
DECLARE
  rp RECORD;
BEGIN
  -- The seven deletes are gone.
  IF EXISTS (
    SELECT 1 FROM payment_applications pa
    JOIN cleanup_0177_rows c0 ON c0.application_id = pa.id
    WHERE c0.disposition = 'delete'
  ) THEN
    RAISE EXCEPTION '0177: a delete target still exists';
  END IF;

  -- The re-point row is now a clean Stripe charge->gift counted link.
  SELECT * INTO rp FROM cleanup_0177_rows WHERE disposition = 'repoint';
  IF NOT EXISTS (
    SELECT 1 FROM payment_applications pa
    WHERE pa.id = rp.application_id
      AND pa.evidence_source = 'stripe'
      AND pa.link_role = 'counted'
      AND pa.stripe_charge_id = rp.stripe_charge_id
      AND pa.payment_unit_id = rp.stripe_unit_id
      AND pa.payment_id IS NULL
      AND pa.amount_applied = rp.applied_amount
  ) THEN
    RAISE EXCEPTION '0177: re-point row is not in the expected final shape';
  END IF;

  -- Counted payment-unit uniqueness still holds.
  IF EXISTS (
    SELECT 1 FROM payment_applications
    WHERE link_role = 'counted' AND payment_unit_id IS NOT NULL
    GROUP BY payment_unit_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0177: counted payment-unit uniqueness invariant failed';
  END IF;

  -- No stripe-funded QBO-deposit-grain counted applications remain.
  IF EXISTS (
    SELECT 1
    FROM payment_applications pa
    JOIN staged_payments sp ON sp.id = pa.payment_id
    WHERE pa.link_role = 'counted'
      AND pa.payment_unit_id IS NULL
      AND sp.funding_source = 'stripe'
  ) THEN
    RAISE EXCEPTION '0177: a stripe-funded QBO counted application without a unit still remains';
  END IF;
END
$$;
