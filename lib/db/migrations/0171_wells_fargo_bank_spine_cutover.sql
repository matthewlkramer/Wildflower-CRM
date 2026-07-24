-- 0171: re-source the bank spine from Wells Fargo CSV exports.
--
-- The CSV importer writes raw Wells Fargo evidence to bank_transactions with
-- source='bank_csv_export'. This migration projects only money-in rows,
-- moves the existing payout/component relationships to those deposits, and
-- retires the old QBO-register projection. QBO bank_transactions are retained
-- as accounting/bridge evidence.
--
-- APPLY ORDER:
--   1. Apply 0170 (DDL; this file must run before the importer).
--   2. Run `pnpm --filter @workspace/scripts run import:bank-csv`.
--   3. Apply this file (0171; data projection and cutover).
--
-- This file deliberately contains no enum additions or source-column DDL:
-- PostgreSQL does not allow using a newly-added enum value within the same
-- transaction that added it, and the repository applies migrations with
-- `psql -1`.

-- Project every Wells Fargo money-in row. A deterministic source id makes this
-- safe to re-run after the import or against an already partially projected DB.
INSERT INTO bank_deposits (
  id, source, source_bank_transaction_id, deposit_date, amount, currency,
  account, location, reference, memo
)
SELECT
  'bdep_' || substring(bt.id FROM 5),
  'bank_csv_export',
  bt.id,
  bt.txn_date,
  bt.deposit,
  'USD',
  bt.account,
  bt.location,
  bt.ref_no,
  bt.memo
FROM bank_transactions bt
WHERE bt.source = 'bank_csv_export'
  AND bt.deposit IS NOT NULL
  AND bt.deposit > 0
ON CONFLICT (id) DO UPDATE SET
  source = EXCLUDED.source,
  source_bank_transaction_id = EXCLUDED.source_bank_transaction_id,
  deposit_date = EXCLUDED.deposit_date,
  amount = EXCLUDED.amount,
  account = EXCLUDED.account,
  location = EXCLUDED.location,
  reference = EXCLUDED.reference,
  memo = EXCLUDED.memo,
  updated_at = now();

-- Existing relationships point at the retiring QBO projection. Clear them
-- before deleting components/deposits; all are deterministically recomputed
-- below against the Wells Fargo projection.
UPDATE stripe_payouts
SET bank_deposit_id = NULL,
    ambiguous_bank_match = false,
    bank_matched_at = NULL,
    updated_at = now()
WHERE bank_deposit_id IN (
  SELECT id FROM bank_deposits WHERE source = 'qbo_register_export'
);

DELETE FROM bank_deposit_components
WHERE bank_deposit_id IN (
  SELECT id FROM bank_deposits WHERE source = 'qbo_register_export'
);

-- Re-match paid Stripe payouts to Wells Fargo deposits. Equal amount/date
-- classes are paired deterministically and flagged, matching the runtime
-- bank-spine recompute policy.
WITH pside AS (
  SELECT p.id, p.amount, p.arrival_date,
    upper(COALESCE(p.currency, 'USD')) AS cur,
    count(*) OVER (PARTITION BY p.amount, p.arrival_date) AS class_n,
    row_number() OVER (PARTITION BY p.amount, p.arrival_date ORDER BY p.id) AS rn
  FROM stripe_payouts p
  WHERE p.status = 'paid' AND p.amount IS NOT NULL AND p.amount > 0
    AND p.bank_deposit_id IS NULL
),
dside AS (
  SELECT d.id, d.amount, d.deposit_date, upper(d.currency) AS cur
  FROM bank_deposits d
  WHERE d.source = 'bank_csv_export'
    AND NOT EXISTS (SELECT 1 FROM stripe_payouts x WHERE x.bank_deposit_id = d.id)
),
cand AS (
  SELECT p.id AS payout_id, d.id AS deposit_id, p.class_n, p.rn
  FROM pside p
  JOIN dside d ON d.amount = p.amount AND d.cur = p.cur
    AND d.deposit_date >= p.arrival_date
    AND d.deposit_date <= p.arrival_date + INTERVAL '5 days'
),
ranked AS (
  SELECT payout_id, deposit_id, class_n, rn,
    row_number() OVER (PARTITION BY payout_id ORDER BY deposit_id) AS drn,
    count(*) OVER (PARTITION BY payout_id) AS dn,
    count(*) OVER (PARTITION BY deposit_id) AS pn
  FROM cand
),
pick AS (
  SELECT DISTINCT ON (deposit_id)
    payout_id, deposit_id, (class_n > 1 OR dn > 1 OR pn > 1) AS ambiguous
  FROM ranked
  WHERE drn = LEAST(rn, dn)
  ORDER BY deposit_id, payout_id
)
UPDATE stripe_payouts p
SET bank_deposit_id = pick.deposit_id,
    ambiguous_bank_match = pick.ambiguous,
    bank_matched_at = now(),
    updated_at = now()
FROM pick
WHERE p.id = pick.payout_id;

-- Recompute QBO-inferred components against the new bank deposits. The QBO
-- staged rows remain the composition evidence; only their bank parent changes.
WITH scope AS (
  SELECT sp.*
  FROM staged_payments sp
  WHERE sp.qb_deposit_id IS NOT NULL
    AND sp.qb_entity_type <> 'deposit_header'
    AND sp.exclusion_reason IS NULL
    AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
    AND sp.amount IS NOT NULL AND sp.amount > 0
    AND EXISTS (SELECT 1 FROM payment_units pu WHERE pu.id = 'pu_' || sp.id)
),
depinfo AS (
  SELECT g.realm_id, g.qb_deposit_id,
    (SELECT (p.qb_raw->>'TotalAmt')::numeric FROM staged_payments p
      WHERE p.realm_id = g.realm_id AND p.qb_entity_id = g.qb_deposit_id
        AND p.qb_entity_type IN ('deposit', 'deposit_header')
        AND p.qb_raw ? 'TotalAmt'
      ORDER BY p.id LIMIT 1) AS total,
    (SELECT COALESCE((p.qb_raw->>'TxnDate')::date, p.date_received)
      FROM staged_payments p
      WHERE p.realm_id = g.realm_id AND p.qb_entity_id = g.qb_deposit_id
        AND p.qb_entity_type IN ('deposit', 'deposit_header')
      ORDER BY p.id LIMIT 1) AS txn_date
  FROM (SELECT DISTINCT realm_id, qb_deposit_id FROM scope) g
),
qside AS (
  SELECT *, count(*) OVER (PARTITION BY total, txn_date) AS class_n,
    row_number() OVER (PARTITION BY total, txn_date ORDER BY qb_deposit_id) AS rn
  FROM depinfo WHERE total IS NOT NULL AND txn_date IS NOT NULL
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
  FROM qside q JOIN bside b
    ON b.amount = q.total AND b.deposit_date = q.txn_date AND b.rn = q.rn
)
INSERT INTO bank_deposit_components (
  id, bank_deposit_id, payment_unit_id, amount, source,
  source_staged_payment_id, ambiguous_deposit_match, needs_review
)
SELECT 'bdc_' || s.id, p.bank_deposit_id, 'pu_' || s.id, s.amount,
  'qbo_inferred', s.id, p.ambiguous, COALESCE(s.funding_source = 'paypal', false)
FROM scope s
JOIN pairs p ON p.realm_id = s.realm_id AND p.qb_deposit_id = s.qb_deposit_id
ON CONFLICT (id) DO UPDATE SET
  bank_deposit_id = EXCLUDED.bank_deposit_id,
  ambiguous_deposit_match = EXCLUDED.ambiguous_deposit_match,
  updated_at = now();

-- Nothing may retain a FK to the retiring projection at this point.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM bank_deposit_components c
    JOIN bank_deposits d ON d.id = c.bank_deposit_id
    WHERE d.source = 'qbo_register_export'
  ) THEN
    RAISE EXCEPTION 'QBO bank deposits still have component references';
  END IF;
  IF EXISTS (
    SELECT 1 FROM stripe_payouts p
    JOIN bank_deposits d ON d.id = p.bank_deposit_id
    WHERE d.source = 'qbo_register_export'
  ) THEN
    RAISE EXCEPTION 'QBO bank deposits still have payout references';
  END IF;
END $$;

DELETE FROM bank_deposits WHERE source = 'qbo_register_export';
