-- Stripe pointer retirement parity audit
-- Read-only. Safe to run repeatedly.
--
-- Purpose:
--   1. prove the counted payment-application ledger has at most one active owner
--      for every Stripe charge;
--   2. compare legacy pointer identity with proposed/confirmed ledger identity;
--   3. classify pointer-only, ledger-only, disagreement, and stale-status rows;
--   4. provide exact IDs for review before remaining readers stop consulting
--      matched_gift_id / created_gift_id.

BEGIN TRANSACTION READ ONLY;

WITH active_ledger AS (
  SELECT
    pa.stripe_charge_id,
    COUNT(*) AS active_rows,
    COUNT(*) FILTER (WHERE pa.lifecycle = 'confirmed') AS confirmed_rows,
    COUNT(*) FILTER (WHERE pa.lifecycle = 'proposed') AS proposed_rows,
    MIN(pa.gift_id) AS min_gift_id,
    MAX(pa.gift_id) AS max_gift_id,
    ARRAY_AGG(pa.id ORDER BY pa.id) AS application_ids,
    ARRAY_AGG(DISTINCT pa.gift_id ORDER BY pa.gift_id) AS gift_ids
  FROM payment_applications pa
  WHERE pa.evidence_source = 'stripe'
    AND pa.link_role = 'counted'
    AND pa.lifecycle IN ('proposed', 'confirmed')
    AND pa.stripe_charge_id IS NOT NULL
  GROUP BY pa.stripe_charge_id
),
classified AS (
  SELECT
    sc.id AS stripe_charge_id,
    sc.payer_name,
    sc.payer_email,
    sc.gross_amount,
    sc.stripe_payout_id,
    sc.match_status,
    sc.auto_applied,
    sc.match_confirmed_at,
    COALESCE(sc.matched_gift_id, sc.created_gift_id) AS legacy_gift_id,
    CASE
      WHEN sc.matched_gift_id IS NOT NULL AND sc.created_gift_id IS NOT NULL
        AND sc.matched_gift_id <> sc.created_gift_id
        THEN 'legacy_two_pointer_conflict'
      WHEN COALESCE(al.active_rows, 0) > 1 AND al.min_gift_id <> al.max_gift_id
        THEN 'multiple_active_ledger_gifts'
      WHEN COALESCE(al.active_rows, 0) > 1
        THEN 'duplicate_active_ledger_rows'
      WHEN COALESCE(sc.matched_gift_id, sc.created_gift_id) IS NOT NULL
        AND al.active_rows IS NULL
        THEN 'pointer_without_active_ledger'
      WHEN COALESCE(sc.matched_gift_id, sc.created_gift_id) IS NULL
        AND al.active_rows = 1
        THEN 'ledger_without_pointer'
      WHEN COALESCE(sc.matched_gift_id, sc.created_gift_id) IS NOT NULL
        AND al.active_rows = 1
        AND COALESCE(sc.matched_gift_id, sc.created_gift_id) <> al.min_gift_id
        THEN 'pointer_ledger_disagree'
      WHEN sc.match_status = 'matched'
        AND COALESCE(sc.matched_gift_id, sc.created_gift_id) IS NULL
        AND al.active_rows IS NULL
        THEN 'legacy_matched_without_relationship'
      ELSE 'parity'
    END AS issue_type,
    al.active_rows,
    al.confirmed_rows,
    al.proposed_rows,
    al.gift_ids AS ledger_gift_ids,
    al.application_ids
  FROM stripe_staged_charges sc
  LEFT JOIN active_ledger al ON al.stripe_charge_id = sc.id
)
SELECT
  issue_type,
  COUNT(*) AS row_count,
  COALESCE(SUM(gross_amount), 0) AS gross_amount
FROM classified
GROUP BY issue_type
ORDER BY issue_type;

-- Detailed non-parity rows.
WITH active_ledger AS (
  SELECT
    pa.stripe_charge_id,
    COUNT(*) AS active_rows,
    COUNT(*) FILTER (WHERE pa.lifecycle = 'confirmed') AS confirmed_rows,
    COUNT(*) FILTER (WHERE pa.lifecycle = 'proposed') AS proposed_rows,
    MIN(pa.gift_id) AS min_gift_id,
    MAX(pa.gift_id) AS max_gift_id,
    ARRAY_AGG(pa.id ORDER BY pa.id) AS application_ids,
    ARRAY_AGG(DISTINCT pa.gift_id ORDER BY pa.gift_id) AS gift_ids
  FROM payment_applications pa
  WHERE pa.evidence_source = 'stripe'
    AND pa.link_role = 'counted'
    AND pa.lifecycle IN ('proposed', 'confirmed')
    AND pa.stripe_charge_id IS NOT NULL
  GROUP BY pa.stripe_charge_id
),
classified AS (
  SELECT
    sc.id AS stripe_charge_id,
    sc.payer_name,
    sc.payer_email,
    sc.gross_amount,
    sc.stripe_payout_id,
    sc.match_status,
    sc.auto_applied,
    sc.match_confirmed_at,
    sc.matched_gift_id,
    sc.created_gift_id,
    CASE
      WHEN sc.matched_gift_id IS NOT NULL AND sc.created_gift_id IS NOT NULL
        AND sc.matched_gift_id <> sc.created_gift_id
        THEN 'legacy_two_pointer_conflict'
      WHEN COALESCE(al.active_rows, 0) > 1 AND al.min_gift_id <> al.max_gift_id
        THEN 'multiple_active_ledger_gifts'
      WHEN COALESCE(al.active_rows, 0) > 1
        THEN 'duplicate_active_ledger_rows'
      WHEN COALESCE(sc.matched_gift_id, sc.created_gift_id) IS NOT NULL
        AND al.active_rows IS NULL
        THEN 'pointer_without_active_ledger'
      WHEN COALESCE(sc.matched_gift_id, sc.created_gift_id) IS NULL
        AND al.active_rows = 1
        THEN 'ledger_without_pointer'
      WHEN COALESCE(sc.matched_gift_id, sc.created_gift_id) IS NOT NULL
        AND al.active_rows = 1
        AND COALESCE(sc.matched_gift_id, sc.created_gift_id) <> al.min_gift_id
        THEN 'pointer_ledger_disagree'
      WHEN sc.match_status = 'matched'
        AND COALESCE(sc.matched_gift_id, sc.created_gift_id) IS NULL
        AND al.active_rows IS NULL
        THEN 'legacy_matched_without_relationship'
      ELSE 'parity'
    END AS issue_type,
    al.active_rows,
    al.confirmed_rows,
    al.proposed_rows,
    al.gift_ids AS ledger_gift_ids,
    al.application_ids
  FROM stripe_staged_charges sc
  LEFT JOIN active_ledger al ON al.stripe_charge_id = sc.id
)
SELECT *
FROM classified
WHERE issue_type <> 'parity'
ORDER BY issue_type, stripe_charge_id;

ROLLBACK;
