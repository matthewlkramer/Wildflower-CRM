-- 0162: Phase 3b — backfill provisional CHECK payment_units and
-- bank_deposit_components from QBO (docs/adr-bank-spine-money-model.md).
-- QBO is the admitted-imperfect interim source for check-deposit composition;
-- the rows created here are canonical-model rows whose `source`/facts get
-- upgraded in place when a check register / bank feed replaces QBO.
--
-- APPLY ORDER: requires 0159 (bank_deposits), 0160 (payment_units), 0161
-- (bank_deposit_components), 0163 (payout->bank matches, so payout-claimed
-- register deposits are excluded from check pairing). Apply 0163 FIRST.
--
-- ── Unit scope (which staged_payments rows become check units) ──────────
-- One unit per QBO deposit-composing row: qb_deposit_id present, not a
-- deposit_header (its money is counted on the underlying Payment rows), not
-- excluded, amount > 0, not a split PARENT (children replace it). Approved
-- dedup exclusions — money already unitized elsewhere:
--   1. exclusion_reason IS NOT NULL (incl. processor_payout Stripe lumps),
--      plus ANY funding_source='stripe' row: PROD holds ~$112K of QBO deposit
--      lines that ARE Stripe payout lumps (payer 'Stripe', payout-shaped
--      amounts) but were never marked processor_payout — that money flows
--      through the payout → bank_deposit lane and is already unitized
--      charge-by-charge, so unitizing the QBO mirror would double-count it;
--   2. rows tied to a Stripe charge (source_links charge_qb_tie / charge_fee_row);
--   3. rows donorbox_qb-tied to a CARD donation (stripe_charge_id present or a
--      donorbox_charge link) — that money is the charge's unit. An OFFLINE
--      donation's row IS unitized, carrying donorbox_donation_id (one real
--      check entered in two systems -> ONE unit).
--
-- ── Deposit pairing (QBO Deposit -> register bank_deposit) ──────────────
-- The register line and the QBO Deposit are the same transaction in QBO's
-- books: pair on exact TotalAmt + TxnDate against unclaimed (non-payout)
-- bank_deposits. Equal-amount/same-date classes pair deterministically by
-- rank (nth QBO deposit <-> nth register deposit) and set
-- ambiguous_deposit_match — a filterable flag, NO review workflow.
-- Units whose deposit finds no register match still get created (floating
-- check units); the component is added when the deposit can be paired.
--
-- WHY SAFE: additive + idempotent (deterministic ids pu_<staged id> /
-- bdc_<staged id>, ON CONFLICT DO NOTHING; re-runs skip existing rows). No
-- existing table is modified except the new flag column. Nothing reads these
-- rows yet.
--
-- Run (human, repo root), AFTER 0163:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0162_qbo_check_composition_backfill.sql

ALTER TABLE bank_deposit_components
  ADD COLUMN IF NOT EXISTS ambiguous_deposit_match boolean NOT NULL DEFAULT false;

-- 1) Provisional check payment_units.
WITH scope AS (
  SELECT sp.*,
    (SELECT sl.donorbox_donation_id FROM source_links sl
      WHERE sl.link_type = 'donorbox_qb' AND sl.qb_staged_payment_id = sp.id
      LIMIT 1) AS db_donation_id
  FROM staged_payments sp
  WHERE sp.qb_deposit_id IS NOT NULL
    AND sp.qb_entity_type <> 'deposit_header'
    AND sp.exclusion_reason IS NULL
    AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
    AND sp.amount IS NOT NULL AND sp.amount > 0
    AND NOT EXISTS (SELECT 1 FROM staged_payments c WHERE c.split_parent_id = sp.id)
    AND NOT EXISTS (SELECT 1 FROM source_links t
                    WHERE t.qb_staged_payment_id = sp.id
                      AND t.link_type IN ('charge_qb_tie', 'charge_fee_row'))
),
units AS (
  SELECT s.*,
    CASE WHEN s.db_donation_id IS NOT NULL THEN s.db_donation_id END AS unit_donorbox_donation_id
  FROM scope s
  LEFT JOIN donorbox_donations d ON d.id = s.db_donation_id
  WHERE s.db_donation_id IS NULL
     OR NOT (d.stripe_charge_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM source_links c
                        WHERE c.donorbox_donation_id = d.id
                          AND c.link_type = 'donorbox_charge'))
)
INSERT INTO payment_units (
  id, kind, donorbox_donation_id, source_staged_payment_id,
  gross_amount, net_amount, currency, received_date
)
SELECT
  'pu_' || u.id,
  CASE
    WHEN u.funding_source = 'check' THEN 'check'
    WHEN u.funding_source = 'wire_ach' AND u.qb_payment_method ILIKE '%wire%' THEN 'wire'
    WHEN u.funding_source = 'wire_ach' THEN 'direct_ach'
    WHEN u.qb_check_number IS NOT NULL OR u.qb_payment_method ILIKE '%check%' THEN 'check'
    ELSE 'other'
  END::payment_unit_kind,
  u.unit_donorbox_donation_id,
  u.id,
  u.amount,
  u.amount,  -- a check/direct payment has no processor fee: net = gross
  upper(COALESCE(u.qb_currency, 'USD')),
  u.date_received
FROM units u
ON CONFLICT (id) DO NOTHING;

-- 2) Deposit components (only where the QBO Deposit pairs to a register deposit).
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
    (SELECT COALESCE((p.qb_raw->>'TxnDate')::date, p.date_received) FROM staged_payments p
      WHERE p.realm_id = g.realm_id AND p.qb_entity_id = g.qb_deposit_id
        AND p.qb_entity_type IN ('deposit', 'deposit_header')
      ORDER BY p.id LIMIT 1) AS txn_date
  FROM (SELECT DISTINCT realm_id, qb_deposit_id FROM scope) g
),
qside AS (
  SELECT *,
    count(*)     OVER (PARTITION BY total, txn_date) AS class_n,
    row_number() OVER (PARTITION BY total, txn_date ORDER BY qb_deposit_id) AS rn
  FROM depinfo
  WHERE total IS NOT NULL AND txn_date IS NOT NULL
),
bside AS (
  SELECT d.id, d.amount, d.deposit_date,
    count(*)     OVER (PARTITION BY d.amount, d.deposit_date) AS class_n,
    row_number() OVER (PARTITION BY d.amount, d.deposit_date ORDER BY d.id) AS rn
  FROM bank_deposits d
  WHERE NOT EXISTS (SELECT 1 FROM stripe_payouts p WHERE p.bank_deposit_id = d.id)
),
pairs AS (
  SELECT q.realm_id, q.qb_deposit_id, b.id AS bank_deposit_id,
    (q.class_n > 1 OR b.class_n > 1) AS ambiguous
  FROM qside q
  JOIN bside b
    ON b.amount = q.total AND b.deposit_date = q.txn_date AND b.rn = q.rn
)
INSERT INTO bank_deposit_components (
  id, bank_deposit_id, payment_unit_id, amount, source,
  source_staged_payment_id, ambiguous_deposit_match, needs_review
)
SELECT
  'bdc_' || s.id,
  pr.bank_deposit_id,
  'pu_' || s.id,
  s.amount,
  'qbo_inferred',
  s.id,
  pr.ambiguous,
  -- A row that claims PayPal origin yet passed the dedup exclusions is
  -- suspicious (probably processor money, not a deposit-composing payment) —
  -- flag it. (funding_source='stripe' rows are excluded from scope entirely.)
  COALESCE(s.funding_source = 'paypal', false)
FROM scope s
JOIN pairs pr
  ON pr.realm_id = s.realm_id AND pr.qb_deposit_id = s.qb_deposit_id
ON CONFLICT (id) DO NOTHING;
