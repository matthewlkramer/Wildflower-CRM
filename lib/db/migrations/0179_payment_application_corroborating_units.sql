-- 0179: annotate corroborating payment_applications rows with canonical units.
--
-- Additive only: this creates missing payment_units rows and fills the
-- successor anchor on existing payment_applications rows. It does not change
-- readers, conflict targets, roles, amounts, or counted rows.
--
-- The deterministic unit id follows the source anchor:
--   quickbooks → pu_<payment_id>
--   stripe     → pu_<stripe_charge_id>
--   donorbox   → pu_<donorbox_donation_id>
--
-- APPLY:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0179_payment_application_corroborating_units.sql

CREATE TEMP TABLE phase_c_0179_before (
  anchored_null_count bigint NOT NULL,
  counted_application_count bigint NOT NULL,
  counted_amount numeric NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_c_0179_before (
  anchored_null_count,
  counted_application_count,
  counted_amount
)
SELECT
  count(*) FILTER (
    WHERE pa.payment_unit_id IS NULL
      AND (
        pa.payment_id IS NOT NULL
        OR pa.stripe_charge_id IS NOT NULL
        OR pa.donorbox_donation_id IS NOT NULL
      )
  ),
  (SELECT count(*) FROM payment_applications WHERE link_role = 'counted'),
  (SELECT coalesce(sum(amount_applied), 0)
   FROM payment_applications
   WHERE link_role = 'counted')
FROM payment_applications pa;

SELECT
  '0179 before' AS evidence,
  anchored_null_count,
  counted_application_count,
  counted_amount
FROM phase_c_0179_before;

CREATE TEMP TABLE phase_c_0179_targets (
  application_id text PRIMARY KEY,
  evidence_source text NOT NULL,
  anchor_id text NOT NULL,
  unit_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_c_0179_targets (
  application_id,
  evidence_source,
  anchor_id,
  unit_id
)
SELECT
  pa.id,
  pa.evidence_source::text,
  CASE pa.evidence_source
    WHEN 'quickbooks' THEN pa.payment_id
    WHEN 'stripe' THEN pa.stripe_charge_id
    WHEN 'donorbox' THEN pa.donorbox_donation_id
  END,
  coalesce(
    existing.id,
    'pu_' || CASE pa.evidence_source
      WHEN 'quickbooks' THEN pa.payment_id
      WHEN 'stripe' THEN pa.stripe_charge_id
      WHEN 'donorbox' THEN pa.donorbox_donation_id
    END
  )
FROM payment_applications pa
LEFT JOIN LATERAL (
  SELECT pu.id
  FROM payment_units pu
  WHERE (
      pa.evidence_source = 'quickbooks'
      AND pu.source_staged_payment_id = pa.payment_id
    )
    OR (
      pa.evidence_source = 'stripe'
      AND pu.stripe_charge_id = pa.stripe_charge_id
    )
    OR (
      pa.evidence_source = 'donorbox'
      AND pu.donorbox_donation_id = pa.donorbox_donation_id
    )
  ORDER BY pu.id
  LIMIT 1
) existing ON true
WHERE pa.payment_unit_id IS NULL
  AND (
    (pa.evidence_source = 'quickbooks' AND pa.payment_id IS NOT NULL)
    OR (pa.evidence_source = 'stripe' AND pa.stripe_charge_id IS NOT NULL)
    OR (pa.evidence_source = 'donorbox' AND pa.donorbox_donation_id IS NOT NULL)
  );

CREATE TEMP TABLE phase_c_0179_created_units (
  id text PRIMARY KEY
) ON COMMIT DROP;

WITH source_rows AS (
  SELECT DISTINCT ON (pa.payment_id)
    'pu_' || pa.payment_id AS id,
    CASE
      WHEN sp.funding_source = 'check' THEN 'check'
      WHEN sp.funding_source = 'wire_ach'
        AND sp.qb_payment_method ILIKE '%wire%' THEN 'wire'
      WHEN sp.funding_source = 'wire_ach' THEN 'direct_ach'
      WHEN sp.qb_check_number IS NOT NULL
        OR sp.qb_payment_method ILIKE '%check%' THEN 'check'
      ELSE 'other'
    END::payment_unit_kind AS kind,
    NULL::text AS stripe_charge_id,
    NULL::text AS donorbox_donation_id,
    pa.payment_id AS source_staged_payment_id,
    sp.amount AS gross_amount,
    NULL::numeric AS fee_amount,
    sp.amount AS net_amount,
    'USD' AS currency,
    sp.date_received AS received_date,
    'received'::payment_unit_lifecycle AS lifecycle
  FROM payment_applications pa
  JOIN staged_payments sp ON sp.id = pa.payment_id
  WHERE pa.payment_unit_id IS NULL
    AND pa.evidence_source = 'quickbooks'
    AND pa.payment_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM payment_units pu
      WHERE pu.source_staged_payment_id = pa.payment_id
    )
  ORDER BY pa.payment_id, pa.id
),
stripe_rows AS (
  SELECT DISTINCT ON (pa.stripe_charge_id)
    'pu_' || pa.stripe_charge_id AS id,
    'stripe_charge'::payment_unit_kind AS kind,
    pa.stripe_charge_id,
    NULL::text AS donorbox_donation_id,
    NULL::text AS source_staged_payment_id,
    sc.gross_amount,
    sc.fee_amount,
    sc.net_amount,
    upper(coalesce(sc.currency, 'USD')) AS currency,
    sc.date_received AS received_date,
    CASE
      WHEN sc.disputed THEN 'disputed'
      WHEN sc.refunded THEN 'refunded'
      WHEN sc.amount_refunded IS NOT NULL AND sc.amount_refunded > 0
        THEN 'partially_refunded'
      ELSE 'received'
    END::payment_unit_lifecycle AS lifecycle
  FROM payment_applications pa
  JOIN stripe_staged_charges sc ON sc.id = pa.stripe_charge_id
  WHERE pa.payment_unit_id IS NULL
    AND pa.evidence_source = 'stripe'
    AND pa.stripe_charge_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM payment_units pu
      WHERE pu.stripe_charge_id = pa.stripe_charge_id
    )
  ORDER BY pa.stripe_charge_id, pa.id
),
donorbox_rows AS (
  SELECT DISTINCT ON (pa.donorbox_donation_id)
    'pu_' || pa.donorbox_donation_id AS id,
    'other'::payment_unit_kind AS kind,
    NULL::text AS stripe_charge_id,
    pa.donorbox_donation_id,
    NULL::text AS source_staged_payment_id,
    dd.amount AS gross_amount,
    dd.processing_fee AS fee_amount,
    CASE
      WHEN dd.amount IS NULL OR dd.processing_fee IS NULL
        THEN dd.amount
      ELSE dd.amount - dd.processing_fee
    END AS net_amount,
    upper(coalesce(dd.currency, 'USD')) AS currency,
    dd.date_received AS received_date,
    'received'::payment_unit_lifecycle AS lifecycle
  FROM payment_applications pa
  JOIN donorbox_donations dd ON dd.id = pa.donorbox_donation_id
  WHERE pa.payment_unit_id IS NULL
    AND pa.evidence_source = 'donorbox'
    AND pa.donorbox_donation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM payment_units pu
      WHERE pu.donorbox_donation_id = pa.donorbox_donation_id
    )
  ORDER BY pa.donorbox_donation_id, pa.id
),
inserted AS (
  INSERT INTO payment_units (
    id,
    kind,
    stripe_charge_id,
    donorbox_donation_id,
    source_staged_payment_id,
    gross_amount,
    fee_amount,
    net_amount,
    currency,
    received_date,
    lifecycle
  )
  SELECT
    id,
    kind,
    stripe_charge_id,
    donorbox_donation_id,
    source_staged_payment_id,
    gross_amount,
    fee_amount,
    net_amount,
    currency,
    received_date,
    lifecycle
  FROM (
    SELECT * FROM source_rows
    UNION ALL
    SELECT * FROM stripe_rows
    UNION ALL
    SELECT * FROM donorbox_rows
  ) units
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
INSERT INTO phase_c_0179_created_units (id)
SELECT id FROM inserted;

CREATE TEMP TABLE phase_c_0179_updated_apps (
  id text PRIMARY KEY
) ON COMMIT DROP;

WITH updated AS (
  UPDATE payment_applications pa
  SET payment_unit_id = t.unit_id,
      updated_at = now()
  FROM phase_c_0179_targets t
  JOIN payment_units pu ON pu.id = t.unit_id
  WHERE pa.id = t.application_id
    AND pa.payment_unit_id IS NULL
  RETURNING pa.id
)
INSERT INTO phase_c_0179_updated_apps (id)
SELECT id FROM updated;

SELECT
  '0179 created unit kinds' AS evidence,
  pu.kind,
  count(*) AS unit_count
FROM phase_c_0179_created_units created
JOIN payment_units pu ON pu.id = created.id
GROUP BY pu.kind
ORDER BY pu.kind;

SELECT
  '0179 changes' AS evidence,
  (SELECT count(*) FROM phase_c_0179_created_units) AS units_inserted,
  (SELECT count(*) FROM phase_c_0179_updated_apps) AS applications_updated;

SELECT
  '0179 after' AS evidence,
  (
    SELECT count(*)
    FROM payment_applications pa
    WHERE pa.payment_unit_id IS NULL
      AND (
        pa.payment_id IS NOT NULL
        OR pa.stripe_charge_id IS NOT NULL
        OR pa.donorbox_donation_id IS NOT NULL
      )
  ) AS anchored_null_count,
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
    WHERE pa.payment_unit_id IS NULL
      AND (
        pa.payment_id IS NOT NULL
        OR pa.stripe_charge_id IS NOT NULL
        OR pa.donorbox_donation_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      '0179 left an anchored payment_application without a payment unit';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM payment_applications pa
    JOIN payment_units pu ON pu.id = pa.payment_unit_id
    WHERE pa.payment_id IS NOT NULL
      AND pu.source_staged_payment_id IS DISTINCT FROM pa.payment_id
  ) THEN
    RAISE EXCEPTION '0179 quickbooks anchor/unit mismatch detected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM payment_applications pa
    JOIN payment_units pu ON pu.id = pa.payment_unit_id
    WHERE pa.stripe_charge_id IS NOT NULL
      AND pu.stripe_charge_id IS DISTINCT FROM pa.stripe_charge_id
  ) THEN
    RAISE EXCEPTION '0179 stripe anchor/unit mismatch detected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM payment_applications pa
    JOIN payment_units pu ON pu.id = pa.payment_unit_id
    WHERE pa.donorbox_donation_id IS NOT NULL
      AND pu.donorbox_donation_id IS DISTINCT FROM pa.donorbox_donation_id
  ) THEN
    RAISE EXCEPTION '0179 donorbox anchor/unit mismatch detected';
  END IF;

  IF EXISTS (
    SELECT pa.payment_unit_id
    FROM payment_applications pa
    WHERE pa.link_role = 'counted'
      AND pa.payment_unit_id IS NOT NULL
    GROUP BY pa.payment_unit_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0179 new counted payment-unit collision detected';
  END IF;

  IF (
    SELECT count(*) FROM payment_applications WHERE link_role = 'counted'
  ) <> (SELECT counted_application_count FROM phase_c_0179_before)
  OR (
    SELECT coalesce(sum(amount_applied), 0)
    FROM payment_applications
    WHERE link_role = 'counted'
  ) <> (SELECT counted_amount FROM phase_c_0179_before)
  THEN
    RAISE EXCEPTION '0179 counted application parity changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM phase_c_0179_created_units created
    LEFT JOIN payment_units pu ON pu.id = created.id
    WHERE pu.id IS NULL
  ) THEN
    RAISE EXCEPTION '0179 created payment unit disappeared';
  END IF;
END
$$;
