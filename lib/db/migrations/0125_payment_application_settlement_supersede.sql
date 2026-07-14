-- 0125_payment_application_settlement_supersede.sql
--
-- Adds durable provenance for QBO applications demoted from counted to
-- corroborating because confirmed Stripe charge applications cover the same
-- settled dollars, then performs an idempotent repair of currently covered rows.
--
-- Safety properties:
--   * exact confirmed+counted ledger facts only;
--   * gift-level coverage inside each confirmed payout↔deposit settlement;
--   * shared fee-band rule mirrored from amountWithinFeeBand;
--   * aborts on duplicate/corroborating collisions instead of guessing;
--   * promotes only rows previously demoted by settlement supersession;
--   * safe to re-run.

BEGIN;

ALTER TABLE payment_applications
  ADD COLUMN IF NOT EXISTS superseded_by_settlement_link_id text;

CREATE INDEX IF NOT EXISTS payment_applications_superseded_by_settlement_link_id_idx
  ON payment_applications (superseded_by_settlement_link_id)
  WHERE superseded_by_settlement_link_id IS NOT NULL;

COMMENT ON COLUMN payment_applications.superseded_by_settlement_link_id IS
  'Non-null only when settlement supersession demoted a confirmed counted QBO application to corroborating. Cleared when the application is promoted back to counted.';

CREATE TEMP TABLE _settlement_supersede_coverage ON COMMIT DROP AS
WITH stripe_by_settlement_gift AS (
  SELECT
    sl.id AS settlement_link_id,
    sl.deposit_staged_payment_id AS payment_id,
    spa.gift_id,
    SUM(spa.amount_applied)::numeric AS stripe_gross
  FROM settlement_links sl
  JOIN stripe_staged_charges c
    ON c.stripe_payout_id = sl.payout_id
  JOIN payment_applications spa
    ON spa.stripe_charge_id = c.id
   AND spa.evidence_source = 'stripe'
   AND spa.link_role = 'counted'
   AND spa.lifecycle = 'confirmed'
  WHERE sl.lifecycle = 'confirmed'
    AND sl.deposit_staged_payment_id IS NOT NULL
  GROUP BY sl.id, sl.deposit_staged_payment_id, spa.gift_id
),
qb_rows AS (
  SELECT
    pa.id AS application_id,
    pa.payment_id,
    pa.gift_id,
    pa.amount_applied::numeric AS qb_amount,
    pa.link_role,
    pa.superseded_by_settlement_link_id
  FROM payment_applications pa
  WHERE pa.evidence_source = 'quickbooks'
    AND pa.lifecycle = 'confirmed'
    AND pa.payment_id IS NOT NULL
    AND (
      pa.link_role = 'counted'
      OR pa.superseded_by_settlement_link_id IS NOT NULL
    )
)
SELECT
  q.application_id,
  q.payment_id,
  q.gift_id,
  q.qb_amount,
  q.link_role,
  q.superseded_by_settlement_link_id,
  s.settlement_link_id,
  s.stripe_gross,
  CASE
    WHEN s.settlement_link_id IS NULL THEN false
    WHEN ABS(s.stripe_gross - q.qb_amount) < 0.01 THEN true
    WHEN s.stripe_gross >= q.qb_amount - 0.01
     AND s.stripe_gross <= q.qb_amount * 1.1 + 1 THEN true
    ELSE false
  END AS covered
FROM qb_rows q
LEFT JOIN stripe_by_settlement_gift s
  ON s.payment_id = q.payment_id
 AND s.gift_id = q.gift_id;

-- A payment+gift pair must have at most one counted row and at most one
-- supersede-owned corroborating row. Existing unrelated corroborating evidence is
-- intentionally not overwritten or promoted.
DO $$
DECLARE
  collision_count integer;
BEGIN
  SELECT COUNT(*) INTO collision_count
  FROM (
    SELECT payment_id, gift_id
    FROM payment_applications
    WHERE evidence_source = 'quickbooks'
      AND lifecycle = 'confirmed'
      AND payment_id IS NOT NULL
    GROUP BY payment_id, gift_id
    HAVING COUNT(*) FILTER (WHERE link_role = 'counted') > 1
       OR COUNT(*) FILTER (
            WHERE link_role = 'corroborating'
              AND superseded_by_settlement_link_id IS NOT NULL
          ) > 1
       OR (
            COUNT(*) FILTER (WHERE link_role = 'counted') > 0
        AND COUNT(*) FILTER (
              WHERE link_role = 'corroborating'
                AND superseded_by_settlement_link_id IS NULL
            ) > 0
          )
  ) collisions;

  IF collision_count > 0 THEN
    RAISE EXCEPTION
      '0125 aborted: % payment_application collision group(s) require manual review',
      collision_count;
  END IF;
END $$;

-- Demote covered coarse QBO rows. The provenance marker is what makes the
-- reverse operation safe and prevents unrelated corroborating evidence from
-- being promoted later.
UPDATE payment_applications pa
SET
  link_role = 'corroborating',
  superseded_by_settlement_link_id = c.settlement_link_id,
  updated_at = now()
FROM _settlement_supersede_coverage c
WHERE pa.id = c.application_id
  AND c.covered
  AND pa.link_role = 'counted';

-- If settlement or charge-level coverage has disappeared, restore only rows
-- that this mechanism previously demoted.
UPDATE payment_applications pa
SET
  link_role = 'counted',
  superseded_by_settlement_link_id = NULL,
  updated_at = now()
FROM _settlement_supersede_coverage c
WHERE pa.id = c.application_id
  AND NOT c.covered
  AND pa.link_role = 'corroborating'
  AND pa.superseded_by_settlement_link_id IS NOT NULL;

-- Refresh ownership when the same deposit remains covered but a replacement
-- confirmed settlement link now supplies the payout evidence.
UPDATE payment_applications pa
SET
  superseded_by_settlement_link_id = c.settlement_link_id,
  updated_at = now()
FROM _settlement_supersede_coverage c
WHERE pa.id = c.application_id
  AND c.covered
  AND pa.link_role = 'corroborating'
  AND pa.superseded_by_settlement_link_id IS DISTINCT FROM c.settlement_link_id;

DO $$
DECLARE
  demoted_count integer;
  still_counted_covered integer;
BEGIN
  SELECT COUNT(*) INTO demoted_count
  FROM payment_applications
  WHERE evidence_source = 'quickbooks'
    AND lifecycle = 'confirmed'
    AND link_role = 'corroborating'
    AND superseded_by_settlement_link_id IS NOT NULL;

  SELECT COUNT(*) INTO still_counted_covered
  FROM _settlement_supersede_coverage c
  JOIN payment_applications pa ON pa.id = c.application_id
  WHERE c.covered
    AND pa.link_role = 'counted';

  IF still_counted_covered <> 0 THEN
    RAISE EXCEPTION
      '0125 postcondition failed: % covered QBO application(s) remain counted',
      still_counted_covered;
  END IF;

  RAISE NOTICE
    '0125 complete: % QBO application(s) currently superseded by confirmed settlements',
    demoted_count;
END $$;

COMMIT;
