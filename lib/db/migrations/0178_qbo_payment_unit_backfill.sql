-- 0178: Phase A — backfill canonical payment units for counted, non-Stripe
-- QBO Payment rows that still lack a payment_unit_id.
--
-- Additive only: this creates deterministic payment_units rows and annotates
-- the matching payment_applications rows. It does not change counted amounts,
-- readers, or constraints. The scope intentionally excludes Stripe-funded
-- rows; deposit-grain Stripe applications are handled separately by 0177.
--
-- APPLY:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0178_qbo_payment_unit_backfill.sql

CREATE TEMP TABLE phase_a_0178_before (
  in_scope_null_count bigint NOT NULL,
  counted_application_count bigint NOT NULL,
  counted_amount numeric NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_a_0178_before (
  in_scope_null_count,
  counted_application_count,
  counted_amount
)
SELECT
  count(*) FILTER (
    WHERE pa.link_role = 'counted'
      AND pa.payment_unit_id IS NULL
      AND sp.qb_entity_type = 'payment'
      AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
      AND sp.exclusion_reason IS NULL
      AND sp.amount IS NOT NULL
      AND sp.amount > 0
  ),
  (SELECT count(*) FROM payment_applications WHERE link_role = 'counted'),
  (SELECT coalesce(sum(amount_applied), 0)
   FROM payment_applications
   WHERE link_role = 'counted')
FROM payment_applications pa
JOIN staged_payments sp ON sp.id = pa.payment_id;

SELECT
  '0178 before' AS evidence,
  in_scope_null_count,
  counted_application_count,
  counted_amount
FROM phase_a_0178_before;

CREATE TEMP TABLE phase_a_0178_created_units (
  id text PRIMARY KEY
) ON COMMIT DROP;

WITH scope AS (
  SELECT sp.*
  FROM staged_payments sp
  JOIN payment_applications pa ON pa.payment_id = sp.id
  WHERE pa.link_role = 'counted'
    AND pa.payment_unit_id IS NULL
    AND sp.qb_entity_type = 'payment'
    AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
    AND sp.exclusion_reason IS NULL
    AND sp.amount IS NOT NULL
    AND sp.amount > 0
),
inserted AS (
  INSERT INTO payment_units (
    id,
    kind,
    source_staged_payment_id,
    gross_amount,
    net_amount,
    fee_amount,
    currency,
    received_date,
    lifecycle
  )
  SELECT
    'pu_' || sp.id,
    CASE
      WHEN sp.funding_source = 'check' THEN 'check'
      WHEN sp.funding_source = 'wire_ach'
        AND sp.qb_payment_method ILIKE '%wire%' THEN 'wire'
      WHEN sp.funding_source = 'wire_ach' THEN 'direct_ach'
      WHEN sp.qb_check_number IS NOT NULL
        OR sp.qb_payment_method ILIKE '%check%' THEN 'check'
      ELSE 'other'
    END::payment_unit_kind,
    sp.id,
    sp.amount,
    sp.amount,
    NULL,
    'USD',
    sp.date_received,
    'received'
  FROM scope sp
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
INSERT INTO phase_a_0178_created_units (id)
SELECT id FROM inserted;

UPDATE payment_applications pa
SET payment_unit_id = 'pu_' || pa.payment_id,
    updated_at = now()
FROM staged_payments sp
WHERE sp.id = pa.payment_id
  AND pa.link_role = 'counted'
  AND pa.payment_unit_id IS NULL
  AND sp.qb_entity_type = 'payment'
  AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
  AND sp.exclusion_reason IS NULL
  AND sp.amount IS NOT NULL
  AND sp.amount > 0;

SELECT
  '0178 created unit kinds' AS evidence,
  pu.kind,
  count(*) AS unit_count
FROM phase_a_0178_created_units created
JOIN payment_units pu ON pu.id = created.id
GROUP BY pu.kind
ORDER BY pu.kind;

SELECT
  '0178 after' AS evidence,
  (
    SELECT count(*)
    FROM payment_applications pa
    JOIN staged_payments sp ON sp.id = pa.payment_id
    WHERE pa.link_role = 'counted'
      AND pa.payment_unit_id IS NULL
      AND sp.qb_entity_type = 'payment'
      AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
      AND sp.exclusion_reason IS NULL
      AND sp.amount IS NOT NULL
      AND sp.amount > 0
  ) AS in_scope_null_count,
  (SELECT count(*) FROM payment_applications WHERE link_role = 'counted')
    AS counted_application_count,
  (SELECT coalesce(sum(amount_applied), 0)
   FROM payment_applications
   WHERE link_role = 'counted') AS counted_amount;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM payment_applications pa
    JOIN staged_payments sp ON sp.id = pa.payment_id
    WHERE pa.link_role = 'counted'
      AND pa.payment_unit_id IS NULL
      AND sp.qb_entity_type = 'payment'
      AND (sp.funding_source IS NULL OR sp.funding_source <> 'stripe')
      AND sp.exclusion_reason IS NULL
      AND sp.amount IS NOT NULL
      AND sp.amount > 0
  ) THEN
    RAISE EXCEPTION
      '0178 left in-scope counted QBO payment applications without payment units';
  END IF;

  IF EXISTS (
    SELECT pa.payment_unit_id
    FROM payment_applications pa
    WHERE pa.link_role = 'counted'
      AND pa.payment_unit_id IS NOT NULL
    GROUP BY pa.payment_unit_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      '0178 counted payment-unit uniqueness collision detected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM phase_a_0178_created_units created
    LEFT JOIN payment_units pu ON pu.id = created.id
    LEFT JOIN staged_payments sp ON sp.id = pu.source_staged_payment_id
    WHERE pu.id IS NULL OR sp.id IS NULL
  ) THEN
    RAISE EXCEPTION
      '0178 created payment unit has no staged-payment source';
  END IF;

  IF (
    SELECT count(*) FROM payment_applications WHERE link_role = 'counted'
  ) <> (SELECT counted_application_count FROM phase_a_0178_before)
  OR (
    SELECT coalesce(sum(amount_applied), 0)
    FROM payment_applications
    WHERE link_role = 'counted'
  ) <> (SELECT counted_amount FROM phase_a_0178_before)
  THEN
    RAISE EXCEPTION
      '0178 counted application parity changed';
  END IF;
END
$$;
