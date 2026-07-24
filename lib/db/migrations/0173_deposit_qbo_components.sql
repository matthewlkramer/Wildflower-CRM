-- 0173: provisional QBO accounting decomposition for Wells Fargo deposits.
--
-- These rows are accounting evidence only. They never create payment_units,
-- bank_deposit_components, or payment_applications and therefore never count
-- money or establish payment completeness.
--
-- Apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0173_deposit_qbo_components.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'deposit_qbo_match_basis'
  ) THEN
    CREATE TYPE deposit_qbo_match_basis AS ENUM (
      'deposit_header_exact',
      'deposit_header_ambiguous'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS deposit_qbo_components (
  id text PRIMARY KEY,
  bank_deposit_id text NOT NULL REFERENCES bank_deposits(id) ON DELETE RESTRICT,
  realm_id text NOT NULL,
  qb_deposit_id text NOT NULL,
  staged_payment_id text NOT NULL REFERENCES staged_payments(id) ON DELETE RESTRICT,
  amount numeric(14, 2) NOT NULL,
  match_basis deposit_qbo_match_basis NOT NULL,
  confirmed boolean NOT NULL DEFAULT false,
  confirmed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_qbo_components_amount_positive_chk CHECK (amount > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS deposit_qbo_components_staged_payment_id_uq
  ON deposit_qbo_components(staged_payment_id);
CREATE INDEX IF NOT EXISTS deposit_qbo_components_bank_deposit_id_idx
  ON deposit_qbo_components(bank_deposit_id);
CREATE INDEX IF NOT EXISTS deposit_qbo_components_qb_deposit_id_idx
  ON deposit_qbo_components(qb_deposit_id);

-- Before-state diagnostics. These are intentionally emitted by the migration
-- so the human applying it can retain the exact baseline in the run log.
SELECT
  count(*) FILTER (WHERE d.source = 'bank_csv_export') AS wf_deposits,
  count(*) FILTER (
    WHERE d.source = 'bank_csv_export'
      AND EXISTS (
        SELECT 1 FROM bank_deposit_components c
        WHERE c.bank_deposit_id = d.id
      )
  ) AS deposits_with_real_components,
  count(*) FILTER (
    WHERE d.source = 'bank_csv_export'
      AND EXISTS (
        SELECT 1
        FROM bank_deposit_components c
        JOIN payment_units pu ON pu.id = c.payment_unit_id
        JOIN staged_payments sp ON sp.id = pu.source_staged_payment_id
        WHERE c.bank_deposit_id = d.id
      )
      OR EXISTS (
        SELECT 1
        FROM stripe_payouts p
        JOIN staged_payments sp ON sp.settled_stripe_payout_id = p.id
        WHERE p.bank_deposit_id = d.id
      )
  ) AS deposits_with_accounting_cards
FROM bank_deposits d;

WITH candidate_lines AS (
  SELECT sp.id, sp.realm_id, sp.qb_deposit_id, sp.amount,
    (SELECT (h.qb_raw->>'TotalAmt')::numeric
     FROM staged_payments h
     WHERE h.realm_id = sp.realm_id
       AND h.qb_entity_id = sp.qb_deposit_id
       AND h.qb_entity_type IN ('deposit', 'deposit_header')
       AND h.qb_raw ? 'TotalAmt'
     ORDER BY h.id LIMIT 1) AS header_total,
    (SELECT COALESCE((h.qb_raw->>'TxnDate')::date, h.date_received)
     FROM staged_payments h
     WHERE h.realm_id = sp.realm_id
       AND h.qb_entity_id = sp.qb_deposit_id
       AND h.qb_entity_type IN ('deposit', 'deposit_header')
     ORDER BY h.id LIMIT 1) AS header_date
  FROM staged_payments sp
  WHERE sp.qb_deposit_id IS NOT NULL
    AND sp.qb_entity_type <> 'deposit_header'
    AND sp.amount > 0
    AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
),
matched AS (
  SELECT DISTINCT d.id
  FROM candidate_lines l
  JOIN bank_deposits d
    ON d.source = 'bank_csv_export'
   AND d.amount = l.header_total
   AND d.deposit_date = l.header_date
  WHERE NOT EXISTS (SELECT 1 FROM stripe_payouts p WHERE p.bank_deposit_id = d.id)
)
SELECT
  count(*) AS candidate_deposits,
  count(*) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM bank_deposit_components c WHERE c.bank_deposit_id = matched.id
  )) AS candidate_deposits_without_real_components
FROM matched;

WITH scope AS (
  SELECT sp.*
  FROM staged_payments sp
  WHERE sp.qb_deposit_id IS NOT NULL
    AND sp.qb_entity_type <> 'deposit_header'
    AND sp.amount IS NOT NULL AND sp.amount > 0
    AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
    AND NOT EXISTS (SELECT 1 FROM staged_payments child WHERE child.split_parent_id = sp.id)
),
depinfo AS (
  SELECT g.realm_id, g.qb_deposit_id,
    (SELECT (h.qb_raw->>'TotalAmt')::numeric
     FROM staged_payments h
     WHERE h.realm_id = g.realm_id AND h.qb_entity_id = g.qb_deposit_id
       AND h.qb_entity_type IN ('deposit', 'deposit_header')
       AND h.qb_raw ? 'TotalAmt'
     ORDER BY h.id LIMIT 1) AS total,
    (SELECT COALESCE((h.qb_raw->>'TxnDate')::date, h.date_received)
     FROM staged_payments h
     WHERE h.realm_id = g.realm_id AND h.qb_entity_id = g.qb_deposit_id
       AND h.qb_entity_type IN ('deposit', 'deposit_header')
     ORDER BY h.id LIMIT 1) AS txn_date
  FROM (SELECT DISTINCT realm_id, qb_deposit_id FROM scope) g
),
qside AS (
  SELECT *,
    count(*) OVER (PARTITION BY total, txn_date) AS class_n,
    row_number() OVER (PARTITION BY total, txn_date ORDER BY realm_id, qb_deposit_id) AS rn
  FROM depinfo
  WHERE total IS NOT NULL AND txn_date IS NOT NULL
),
bside AS (
  SELECT d.id, d.amount, d.deposit_date,
    count(*) OVER (PARTITION BY d.amount, d.deposit_date) AS class_n,
    row_number() OVER (PARTITION BY d.amount, d.deposit_date ORDER BY d.id) AS rn
  FROM bank_deposits d
  WHERE d.source = 'bank_csv_export'
    AND NOT EXISTS (SELECT 1 FROM stripe_payouts p WHERE p.bank_deposit_id = d.id)
),
pairs AS (
  SELECT q.realm_id, q.qb_deposit_id, b.id AS bank_deposit_id,
    (q.class_n > 1 OR b.class_n > 1) AS ambiguous
  FROM qside q
  JOIN bside b
    ON b.amount = q.total AND b.deposit_date = q.txn_date AND b.rn = q.rn
)
INSERT INTO deposit_qbo_components (
  id, bank_deposit_id, realm_id, qb_deposit_id, staged_payment_id,
  amount, match_basis
)
SELECT
  'dqc_' || m.id,
  p.bank_deposit_id,
  m.realm_id,
  m.qb_deposit_id,
  m.id,
  m.amount,
  CASE WHEN p.ambiguous
    THEN 'deposit_header_ambiguous'::deposit_qbo_match_basis
    ELSE 'deposit_header_exact'::deposit_qbo_match_basis
  END
FROM scope m
JOIN pairs p ON p.realm_id = m.realm_id AND p.qb_deposit_id = m.qb_deposit_id
WHERE NOT EXISTS (
  SELECT 1 FROM bank_deposit_components real_component
  WHERE real_component.source_staged_payment_id = m.id
)
ON CONFLICT (id) DO NOTHING;

-- After-state diagnostics.
SELECT
  count(*) AS provisional_component_rows,
  count(DISTINCT bank_deposit_id) AS deposits_with_provisional_qbo_components,
  count(DISTINCT bank_deposit_id) FILTER (
    WHERE bank_deposit_id IN (
      SELECT c.bank_deposit_id FROM bank_deposit_components c
    )
  ) AS deposits_overlapping_real_components,
  count(DISTINCT bank_deposit_id) FILTER (WHERE confirmed = false)
    AS deposits_with_unconfirmed_qbo_components,
  count(*) FILTER (WHERE match_basis = 'deposit_header_ambiguous')
    AS ambiguous_component_rows
FROM deposit_qbo_components;

SELECT count(*) AS deposits_with_any_accounting_card
FROM bank_deposits d
WHERE d.source = 'bank_csv_export'
  AND (
    EXISTS (
      SELECT 1 FROM bank_deposit_components c
      WHERE c.bank_deposit_id = d.id
    )
    OR EXISTS (
      SELECT 1 FROM deposit_qbo_components q
      WHERE q.bank_deposit_id = d.id
    )
  );

WITH lines AS (
  SELECT d.id AS bank_deposit_id, sp.exclusion_reason
  FROM bank_deposits d
  JOIN deposit_qbo_components q ON q.bank_deposit_id = d.id
  JOIN staged_payments sp ON sp.id = q.staged_payment_id
  WHERE d.source = 'bank_csv_export'
    AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
  UNION ALL
  SELECT d.id, sp.exclusion_reason
  FROM bank_deposits d
  JOIN bank_deposit_components c ON c.bank_deposit_id = d.id
  JOIN payment_units pu ON pu.id = c.payment_unit_id
  JOIN staged_payments sp ON sp.id = pu.source_staged_payment_id
  WHERE d.source = 'bank_csv_export'
)
SELECT count(*) AS deposits_with_all_excluded_qbo_lines
FROM (
  SELECT bank_deposit_id
  FROM lines
  GROUP BY bank_deposit_id
  HAVING bool_and(exclusion_reason IS NOT NULL)
) all_excluded;
