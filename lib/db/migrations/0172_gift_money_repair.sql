-- 0172: repair nine reviewed gift/payment shapes on the bank-spine model.
--
-- Scope:
--   * Collapse seven QBO-over-split gifts onto one counted payment unit and
--     one Wells Fargo deposit component each.
--   * Demote the two duplicate QBO rows whose money is already counted at the
--     Stripe-charge grain.
--
-- This file deliberately does NOT touch the two pledge cases:
--   rechsL1t6AUAsNvPf
--   recLvQ1QfqDncBpea
--
-- APPLY:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0172_gift_money_repair.sql
--
-- The repository's migration convention uses psql -1 for the single
-- transaction. Every mutation is guarded by the reviewed gift ids and the
-- assertions below abort if the expected local shape has changed.

CREATE TEMP TABLE repair_0172_collapse_targets (
  gift_id text PRIMARY KEY,
  deposit_date date NOT NULL,
  deposit_amount numeric(14, 2) NOT NULL,
  deposit_id text
) ON COMMIT DROP;

INSERT INTO repair_0172_collapse_targets (
  gift_id,
  deposit_date,
  deposit_amount
)
VALUES
  ('DWN2URcC3_p0WhfUItlxo', '2026-05-22', 1600000.00),
  ('recPuB4akP0d4AZsN', '2024-07-08', 1500000.00),
  ('recnuRi71Ka63HceZ', '2025-07-25', 120000.00),
  ('reckbnrhVwrpTUULL', '2022-06-03', 1000000.00),
  ('recjtiyQqiTD16KTv', '2020-04-13', 500000.00),
  ('recs30mG9xDAg81iz', '2019-12-27', 195000.00),
  ('recTUSUQJHoasnViD', '2023-05-04', 250000.00);

UPDATE repair_0172_collapse_targets t
SET deposit_id = d.id
FROM bank_deposits d
WHERE d.source = 'bank_csv_export'
  AND d.deposit_date = t.deposit_date
  AND d.amount = t.deposit_amount;

-- Before-state evidence.
SELECT
  g.id AS gift_id,
  g.name,
  g.amount AS gift_amount,
  g.opportunity_id,
  count(*) FILTER (WHERE pa.link_role = 'counted') AS counted_apps,
  coalesce(sum(pa.amount_applied) FILTER (WHERE pa.link_role = 'counted'), 0)
    AS counted_sum,
  count(*) FILTER (WHERE pa.link_role = 'corroborating') AS corroborating_apps,
  count(DISTINCT pa.payment_unit_id)
    FILTER (WHERE pa.link_role = 'counted') AS counted_units,
  t.deposit_id,
  t.deposit_date,
  t.deposit_amount
FROM repair_0172_collapse_targets t
JOIN gifts_and_payments g ON g.id = t.gift_id
LEFT JOIN payment_applications pa ON pa.gift_id = g.id
GROUP BY
  g.id,
  g.name,
  g.amount,
  g.opportunity_id,
  t.deposit_id,
  t.deposit_date,
  t.deposit_amount
ORDER BY g.id;

SELECT
  pa.gift_id,
  pa.id AS application_id,
  pa.payment_id,
  pa.payment_unit_id,
  pa.amount_applied,
  pa.evidence_source,
  pa.link_role,
  pa.note
FROM payment_applications pa
JOIN repair_0172_collapse_targets t ON t.gift_id = pa.gift_id
ORDER BY pa.gift_id, pa.id;

-- The real Wells Fargo match must be exactly one row per reviewed gift. This
-- also explicitly verifies the Arthur Rock $1.6M case before changing it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM repair_0172_collapse_targets t
    LEFT JOIN bank_deposits d ON d.id = t.deposit_id
    GROUP BY t.gift_id
    HAVING count(d.id) <> 1
  ) THEN
    RAISE EXCEPTION
      '0172 expected exactly one Wells Fargo deposit for every collapse gift';
  END IF;

  IF (
    SELECT count(*)
    FROM bank_deposits
    WHERE source = 'bank_csv_export'
      AND deposit_date = '2026-05-22'
      AND amount = 1600000.00
  ) <> 1 THEN
    RAISE EXCEPTION
      '0172 expected exactly one Wells Fargo $1.6M deposit on 2026-05-22';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM repair_0172_collapse_targets t
    JOIN gifts_and_payments g ON g.id = t.gift_id
    WHERE g.opportunity_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      '0172 collapse scope unexpectedly includes an opportunity-linked gift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM repair_0172_collapse_targets t
    JOIN gifts_and_payments g ON g.id = t.gift_id
    LEFT JOIN gift_allocations ga ON ga.gift_id = g.id
    GROUP BY t.gift_id, g.amount
    HAVING count(ga.id) = 0
       OR coalesce(sum(ga.sub_amount), 0) <> g.amount
  ) THEN
    RAISE EXCEPTION
      '0172 collapse gift allocations do not already sum to gift amount';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM repair_0172_collapse_targets t
    JOIN payment_applications pa ON pa.gift_id = t.gift_id
    WHERE pa.link_role = 'counted'
      AND pa.evidence_source <> 'quickbooks'
  ) THEN
    RAISE EXCEPTION
      '0172 collapse scope contains a non-QuickBooks counted application';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM repair_0172_collapse_targets t
    JOIN gifts_and_payments g ON g.id = t.gift_id
    LEFT JOIN payment_applications pa ON pa.gift_id = g.id
    GROUP BY t.gift_id, g.amount
    HAVING count(*) FILTER (WHERE pa.link_role = 'counted') NOT BETWEEN 1 AND 3
        OR coalesce(sum(pa.amount_applied) FILTER (WHERE pa.link_role = 'counted'), 0)
             <> g.amount
        OR (
          count(*) FILTER (WHERE pa.link_role = 'counted') = 1
          AND count(*) FILTER (WHERE pa.link_role = 'corroborating') = 0
        )
  ) THEN
    RAISE EXCEPTION
      '0172 collapse application shape is neither the reviewed split nor repaired state';
  END IF;
END
$$;

-- Capture all pre-existing units before clearing stale composition. The
-- anchor is deterministic: largest counted application, then payment_id.
CREATE TEMP TABLE repair_0172_collapse_anchors ON COMMIT DROP AS
SELECT DISTINCT ON (pa.gift_id)
  pa.gift_id,
  pa.id AS application_id,
  pa.payment_id,
  'pu_' || pa.payment_id AS payment_unit_id
FROM payment_applications pa
JOIN repair_0172_collapse_targets t ON t.gift_id = pa.gift_id
WHERE pa.link_role = 'counted'
  AND pa.payment_id IS NOT NULL
ORDER BY pa.gift_id, pa.amount_applied DESC, pa.payment_id, pa.id;

CREATE TEMP TABLE repair_0172_collapse_old_units ON COMMIT DROP AS
SELECT DISTINCT pa.payment_unit_id
FROM payment_applications pa
JOIN repair_0172_collapse_targets t ON t.gift_id = pa.gift_id
WHERE pa.payment_unit_id IS NOT NULL;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM repair_0172_collapse_anchors
  ) <> 7 THEN
    RAISE EXCEPTION
      '0172 expected one deterministic QBO anchor for each of seven collapse gifts';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM repair_0172_collapse_anchors a
    LEFT JOIN staged_payments sp ON sp.id = a.payment_id
    WHERE sp.id IS NULL
  ) THEN
    RAISE EXCEPTION
      '0172 collapse anchor has no staged payment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM repair_0172_collapse_anchors a
    JOIN payment_units pu ON pu.id = a.payment_unit_id
    WHERE pu.source_staged_payment_id IS NOT NULL
      AND pu.source_staged_payment_id <> a.payment_id
  ) THEN
    RAISE EXCEPTION
      '0172 existing canonical unit has a different staged-payment source';
  END IF;
END
$$;

-- Remove stale deposit composition first. Both component FKs are restrictive;
-- clearing these rows permits safe cleanup of demoted units below.
DELETE FROM bank_deposit_components bdc
WHERE bdc.payment_unit_id IN (
  SELECT payment_unit_id
  FROM repair_0172_collapse_old_units
);

-- Demoted QBO rows retain their payment_id and original amount as audit
-- evidence, but no longer carry counted money or a canonical-unit anchor.
UPDATE payment_applications pa
SET payment_unit_id = NULL,
    link_role = 'corroborating',
    note = CASE
      WHEN pa.note LIKE '%repair 0172: collapsed QBO over-split%'
        THEN pa.note
      WHEN pa.note IS NULL OR pa.note = ''
        THEN 'repair 0172: collapsed QBO over-split; counted once at the real bank deposit grain'
      ELSE pa.note || ' | repair 0172: collapsed QBO over-split; counted once at the real bank deposit grain'
    END,
    updated_at = now()
FROM repair_0172_collapse_anchors a
WHERE pa.gift_id = a.gift_id
  AND pa.id <> a.application_id
  AND pa.evidence_source = 'quickbooks'
  AND pa.link_role = 'counted';

-- Reuse an existing deterministic unit when present; otherwise create it.
-- Existing units preserve their established instrument kind. A new unit
-- defaults to `other` because the reviewed WF rows do not carry a reliable
-- instrument enum beyond the existing QBO unit evidence.
INSERT INTO payment_units (
  id,
  kind,
  source_staged_payment_id,
  gross_amount,
  fee_amount,
  net_amount,
  currency,
  received_date,
  lifecycle
)
SELECT
  a.payment_unit_id,
  coalesce(existing.kind, 'other'::payment_unit_kind),
  a.payment_id,
  g.amount,
  NULL,
  g.amount,
  'USD',
  t.deposit_date,
  'received'
FROM repair_0172_collapse_anchors a
JOIN repair_0172_collapse_targets t ON t.gift_id = a.gift_id
JOIN gifts_and_payments g ON g.id = a.gift_id
LEFT JOIN payment_units existing ON existing.id = a.payment_unit_id
ON CONFLICT (id) DO UPDATE SET
  kind = EXCLUDED.kind,
  source_staged_payment_id = EXCLUDED.source_staged_payment_id,
  gross_amount = EXCLUDED.gross_amount,
  fee_amount = EXCLUDED.fee_amount,
  net_amount = EXCLUDED.net_amount,
  currency = EXCLUDED.currency,
  received_date = EXCLUDED.received_date,
  lifecycle = EXCLUDED.lifecycle,
  updated_at = now();

-- The anchor is the sole counted application and carries the full gift amount.
UPDATE payment_applications pa
SET amount_applied = g.amount,
    payment_unit_id = a.payment_unit_id,
    link_role = 'counted',
    updated_at = now()
FROM repair_0172_collapse_anchors a
JOIN gifts_and_payments g ON g.id = a.gift_id
WHERE pa.id = a.application_id;

-- Delete now-unreferenced non-anchor units. If a unit has another legitimate
-- reference, ON DELETE RESTRICT leaves it in place rather than forcing a loss
-- of evidence.
DELETE FROM payment_units pu
WHERE pu.id IN (
  SELECT old.payment_unit_id
  FROM repair_0172_collapse_old_units old
  WHERE old.payment_unit_id IS NOT NULL
)
  AND pu.id NOT IN (
    SELECT payment_unit_id
    FROM repair_0172_collapse_anchors
  )
  AND NOT EXISTS (
    SELECT 1
    FROM payment_applications pa
    WHERE pa.payment_unit_id = pu.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM bank_deposit_components bdc
    WHERE bdc.payment_unit_id = pu.id
  );

-- Recreate exactly one reviewed component per collapse gift. The enum has only
-- qbo_inferred rows in this clone; retain that established source vocabulary.
INSERT INTO bank_deposit_components (
  id,
  bank_deposit_id,
  payment_unit_id,
  amount,
  source,
  source_staged_payment_id,
  needs_review,
  ambiguous_deposit_match
)
SELECT
  'bdc_0172_' || a.gift_id,
  t.deposit_id,
  a.payment_unit_id,
  g.amount,
  'qbo_inferred',
  a.payment_id,
  false,
  false
FROM repair_0172_collapse_anchors a
JOIN repair_0172_collapse_targets t ON t.gift_id = a.gift_id
JOIN gifts_and_payments g ON g.id = a.gift_id
ON CONFLICT (id) DO UPDATE SET
  bank_deposit_id = EXCLUDED.bank_deposit_id,
  payment_unit_id = EXCLUDED.payment_unit_id,
  amount = EXCLUDED.amount,
  source = EXCLUDED.source,
  source_staged_payment_id = EXCLUDED.source_staged_payment_id,
  needs_review = EXCLUDED.needs_review,
  ambiguous_deposit_match = EXCLUDED.ambiguous_deposit_match,
  updated_at = now();

-- Stripe deduplication: preserve the counted Stripe application/unit and
-- retain the QBO row as corroborating evidence.
UPDATE payment_applications pa
SET link_role = 'corroborating',
    payment_unit_id = NULL,
    note = CASE
      WHEN pa.note LIKE '%repair 0172: demoted to corroborating%'
        THEN pa.note
      WHEN pa.note IS NULL OR pa.note = ''
        THEN 'repair 0172: demoted to corroborating — counted at the Stripe charge grain (Stripe wins)'
      ELSE pa.note || ' | repair 0172: demoted to corroborating — counted at the Stripe charge grain (Stripe wins)'
    END,
    updated_at = now()
WHERE pa.gift_id IN ('recwD16lp6pIRZM2e', 'reco6oHWEdopxrzpy')
  AND pa.evidence_source = 'quickbooks'
  AND pa.link_role = 'counted';

-- Carrie’s Stripe charge is authoritative at $2,088.00. The reviewed local
-- shape has exactly one allocation, so the allocation adjustment is explicit
-- rather than silently scaling an unknown multi-line split.
DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM gift_allocations
    WHERE gift_id = 'recwD16lp6pIRZM2e'
  ) <> 1 THEN
    RAISE EXCEPTION
      '0172 Carrie allocation shape changed; expected exactly one allocation';
  END IF;
END
$$;

UPDATE gifts_and_payments
SET amount = 2088.00,
    updated_at = now()
WHERE id = 'recwD16lp6pIRZM2e'
  AND amount IS DISTINCT FROM 2088.00;

UPDATE gift_allocations
SET sub_amount = 2088.00,
    updated_at = now()
WHERE gift_id = 'recwD16lp6pIRZM2e'
  AND sub_amount IS DISTINCT FROM 2088.00;

-- After-state evidence for the seven collapse gifts.
SELECT
  g.id AS gift_id,
  g.amount AS gift_amount,
  count(*) FILTER (WHERE pa.link_role = 'counted') AS counted_apps,
  coalesce(sum(pa.amount_applied) FILTER (WHERE pa.link_role = 'counted'), 0)
    AS counted_sum,
  count(*) FILTER (WHERE pa.link_role = 'corroborating') AS corroborating_apps,
  min(pa.payment_unit_id) FILTER (WHERE pa.link_role = 'counted')
    AS counted_payment_unit_id,
  t.deposit_id,
  count(bdc.id) FILTER (
    WHERE bdc.bank_deposit_id = t.deposit_id
      AND bdc.payment_unit_id = pa.payment_unit_id
      AND bdc.amount = g.amount
  ) AS matching_components
FROM repair_0172_collapse_targets t
JOIN gifts_and_payments g ON g.id = t.gift_id
LEFT JOIN payment_applications pa ON pa.gift_id = g.id
LEFT JOIN bank_deposit_components bdc
  ON bdc.payment_unit_id = pa.payment_unit_id
GROUP BY g.id, g.amount, t.deposit_id
ORDER BY g.id;

SELECT
  g.id AS gift_id,
  g.name,
  g.amount,
  ga.id AS allocation_id,
  ga.sub_amount
FROM gifts_and_payments g
JOIN gift_allocations ga ON ga.gift_id = g.id
WHERE g.id IN ('recwD16lp6pIRZM2e', 'reco6oHWEdopxrzpy')
ORDER BY g.id, ga.id;

SELECT
  pa.gift_id,
  pa.id AS application_id,
  pa.payment_id,
  pa.payment_unit_id,
  pa.amount_applied,
  pa.evidence_source,
  pa.link_role,
  pa.note
FROM payment_applications pa
WHERE pa.gift_id IN ('recwD16lp6pIRZM2e', 'reco6oHWEdopxrzpy')
ORDER BY pa.gift_id, pa.id;

-- Final assertions. Any mismatch aborts the transaction.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM repair_0172_collapse_targets t
    JOIN gifts_and_payments g ON g.id = t.gift_id
    LEFT JOIN payment_applications pa ON pa.gift_id = g.id
    GROUP BY t.gift_id, g.amount
    HAVING count(*) FILTER (WHERE pa.link_role = 'counted') <> 1
        OR coalesce(sum(pa.amount_applied) FILTER (WHERE pa.link_role = 'counted'), 0)
             <> g.amount
        OR count(*) FILTER (WHERE pa.link_role = 'corroborating') < 1
  ) THEN
    RAISE EXCEPTION
      '0172 collapse final application invariant failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM repair_0172_collapse_targets t
    JOIN gifts_and_payments g ON g.id = t.gift_id
    JOIN payment_applications pa
      ON pa.gift_id = g.id
     AND pa.link_role = 'counted'
    LEFT JOIN bank_deposit_components bdc
      ON bdc.bank_deposit_id = t.deposit_id
     AND bdc.payment_unit_id = pa.payment_unit_id
     AND bdc.amount = g.amount
    GROUP BY t.gift_id
    HAVING count(bdc.id) <> 1
  ) THEN
    RAISE EXCEPTION
      '0172 collapse final bank component invariant failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM payment_applications pa
    WHERE pa.gift_id IN ('recwD16lp6pIRZM2e', 'reco6oHWEdopxrzpy')
    GROUP BY pa.gift_id
    HAVING count(*) FILTER (
             WHERE pa.evidence_source = 'stripe'
               AND pa.link_role = 'counted'
           ) <> 1
        OR count(*) FILTER (
             WHERE pa.evidence_source = 'quickbooks'
               AND pa.link_role = 'counted'
           ) <> 0
        OR count(*) FILTER (
             WHERE pa.evidence_source = 'quickbooks'
               AND pa.link_role = 'corroborating'
           ) <> 1
  ) THEN
    RAISE EXCEPTION
      '0172 Stripe dedup application invariant failed';
  END IF;

  IF (
    SELECT amount
    FROM gifts_and_payments
    WHERE id = 'recwD16lp6pIRZM2e'
  ) <> 2088.00
  OR (
    SELECT coalesce(sum(sub_amount), 0)
    FROM gift_allocations
    WHERE gift_id = 'recwD16lp6pIRZM2e'
  ) <> 2088.00
  OR (
    SELECT amount
    FROM gifts_and_payments
    WHERE id = 'reco6oHWEdopxrzpy'
  ) <> 103.83
  THEN
    RAISE EXCEPTION
      '0172 Stripe gift amount/allocation invariant failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM bank_deposit_components bdc
    LEFT JOIN bank_deposits bd ON bd.id = bdc.bank_deposit_id
    LEFT JOIN payment_units pu ON pu.id = bdc.payment_unit_id
    WHERE bd.id IS NULL OR pu.id IS NULL
  )
  OR EXISTS (
    SELECT 1
    FROM stripe_payouts sp
    LEFT JOIN bank_deposits bd ON bd.id = sp.bank_deposit_id
    WHERE sp.bank_deposit_id IS NOT NULL AND bd.id IS NULL
  )
  OR EXISTS (
    SELECT 1
    FROM payment_applications pa
    LEFT JOIN payment_units pu ON pu.id = pa.payment_unit_id
    WHERE pa.payment_unit_id IS NOT NULL AND pu.id IS NULL
  )
  OR EXISTS (
    SELECT 1
    FROM payment_applications pa
    LEFT JOIN staged_payments sp ON sp.id = pa.payment_id
    WHERE pa.payment_id IS NOT NULL AND sp.id IS NULL
  ) THEN
    RAISE EXCEPTION
      '0172 orphaned money-model foreign key detected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM payment_applications
    WHERE link_role = 'counted'
      AND payment_unit_id IS NOT NULL
    GROUP BY payment_unit_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      '0172 counted payment-unit uniqueness invariant failed';
  END IF;
END
$$;
