-- Reconciliation integrity audit
--
-- READ ONLY. This file intentionally performs no writes and can be run against
-- development or production with psql:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f lib/db/audits/reconciliation_integrity.sql
--
-- The first result is a summary by issue type. The second result contains the
-- row-level evidence needed to classify each issue before any repair migration.

BEGIN TRANSACTION READ ONLY;

CREATE TEMP VIEW reconciliation_integrity_issues AS
WITH
stripe_confirmed AS (
  SELECT
    pa.id AS application_id,
    pa.stripe_charge_id AS source_id,
    pa.gift_id,
    pa.amount_applied,
    pa.match_method,
    pa.confirmed_at
  FROM payment_applications pa
  WHERE pa.evidence_source = 'stripe'
    AND pa.link_role = 'counted'
    AND pa.lifecycle = 'confirmed'
),
qb_confirmed AS (
  SELECT
    pa.id AS application_id,
    pa.payment_id AS source_id,
    pa.gift_id,
    pa.amount_applied,
    pa.match_method,
    pa.confirmed_at
  FROM payment_applications pa
  WHERE pa.evidence_source = 'quickbooks'
    AND pa.link_role = 'counted'
    AND pa.lifecycle = 'confirmed'
),
donorbox_confirmed AS (
  SELECT
    pa.id AS application_id,
    pa.donorbox_donation_id AS source_id,
    pa.gift_id,
    pa.amount_applied,
    pa.match_method,
    pa.confirmed_at
  FROM payment_applications pa
  WHERE pa.evidence_source = 'donorbox'
    AND pa.link_role = 'counted'
    AND pa.lifecycle = 'confirmed'
),
issues AS (
  -- Stripe legacy pointer exists but no matching confirmed counted ledger row.
  SELECT
    'stripe_pointer_without_ledger'::text AS issue_type,
    'high'::text AS severity,
    'stripe_charge'::text AS source_type,
    c.id::text AS source_id,
    COALESCE(c.matched_gift_id, c.created_gift_id)::text AS gift_id,
    NULL::text AS other_gift_id,
    jsonb_build_object(
      'matchedGiftId', c.matched_gift_id,
      'createdGiftId', c.created_gift_id,
      'matchStatus', c.match_status,
      'payerName', c.payer_name,
      'grossAmount', c.gross_amount,
      'payoutId', c.stripe_payout_id
    ) AS details
  FROM stripe_staged_charges c
  WHERE COALESCE(c.matched_gift_id, c.created_gift_id) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM stripe_confirmed pa
      WHERE pa.source_id = c.id
        AND pa.gift_id = COALESCE(c.matched_gift_id, c.created_gift_id)
    )

  UNION ALL

  -- Confirmed Stripe ledger row exists but the compatibility pointer is absent.
  SELECT
    'stripe_ledger_without_pointer',
    'review',
    'stripe_charge',
    c.id,
    pa.gift_id,
    NULL,
    jsonb_build_object(
      'applicationId', pa.application_id,
      'amountApplied', pa.amount_applied,
      'matchMethod', pa.match_method,
      'confirmedAt', pa.confirmed_at,
      'payerName', c.payer_name,
      'grossAmount', c.gross_amount,
      'payoutId', c.stripe_payout_id
    )
  FROM stripe_confirmed pa
  JOIN stripe_staged_charges c ON c.id = pa.source_id
  WHERE c.matched_gift_id IS NULL
    AND c.created_gift_id IS NULL

  UNION ALL

  -- Pointer and confirmed ledger row identify different gifts.
  SELECT
    'stripe_pointer_ledger_disagree',
    'critical',
    'stripe_charge',
    c.id,
    pa.gift_id,
    COALESCE(c.matched_gift_id, c.created_gift_id),
    jsonb_build_object(
      'applicationId', pa.application_id,
      'ledgerGiftId', pa.gift_id,
      'pointerGiftId', COALESCE(c.matched_gift_id, c.created_gift_id),
      'payerName', c.payer_name,
      'grossAmount', c.gross_amount
    )
  FROM stripe_confirmed pa
  JOIN stripe_staged_charges c ON c.id = pa.source_id
  WHERE COALESCE(c.matched_gift_id, c.created_gift_id) IS NOT NULL
    AND COALESCE(c.matched_gift_id, c.created_gift_id) <> pa.gift_id

  UNION ALL

  -- One Stripe charge must never count toward more than one gift.
  SELECT
    'stripe_charge_multiple_counted_gifts',
    'critical',
    'stripe_charge',
    pa.source_id,
    MIN(pa.gift_id),
    MAX(pa.gift_id),
    jsonb_build_object(
      'giftCount', COUNT(DISTINCT pa.gift_id),
      'applicationIds', jsonb_agg(pa.application_id ORDER BY pa.application_id),
      'giftIds', jsonb_agg(DISTINCT pa.gift_id)
    )
  FROM stripe_confirmed pa
  GROUP BY pa.source_id
  HAVING COUNT(DISTINCT pa.gift_id) > 1

  UNION ALL

  -- A gift should not be owned by more than one confirmed counted Stripe charge.
  SELECT
    'gift_claimed_by_multiple_stripe_charges',
    'critical',
    'gift',
    pa.gift_id,
    pa.gift_id,
    NULL,
    jsonb_build_object(
      'chargeCount', COUNT(DISTINCT pa.source_id),
      'chargeIds', jsonb_agg(DISTINCT pa.source_id),
      'applicationIds', jsonb_agg(pa.application_id ORDER BY pa.application_id)
    )
  FROM stripe_confirmed pa
  GROUP BY pa.gift_id
  HAVING COUNT(DISTINCT pa.source_id) > 1

  UNION ALL

  -- Stored matched metadata with no pointer and no ledger application.
  SELECT
    'stripe_legacy_matched_without_relationship',
    'review',
    'stripe_charge',
    c.id,
    NULL,
    NULL,
    jsonb_build_object(
      'matchStatus', c.match_status,
      'matchMethod', c.match_method,
      'autoApplied', c.auto_applied,
      'matchConfirmedAt', c.match_confirmed_at,
      'payerName', c.payer_name,
      'grossAmount', c.gross_amount,
      'payoutId', c.stripe_payout_id
    )
  FROM stripe_staged_charges c
  WHERE c.match_status = 'matched'
    AND c.matched_gift_id IS NULL
    AND c.created_gift_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM stripe_confirmed pa WHERE pa.source_id = c.id
    )

  UNION ALL

  -- QuickBooks pointer exists but no matching confirmed counted ledger row.
  SELECT
    'quickbooks_pointer_without_ledger',
    'high',
    'quickbooks_payment',
    sp.id,
    COALESCE(
      sp.matched_gift_id,
      sp.created_gift_id,
      sp.group_reconciled_gift_id
    ),
    NULL,
    jsonb_build_object(
      'matchedGiftId', sp.matched_gift_id,
      'createdGiftId', sp.created_gift_id,
      'groupReconciledGiftId', sp.group_reconciled_gift_id,
      'payerName', sp.payer_name,
      'amount', sp.amount,
      'qbEntityId', sp.qb_entity_id
    )
  FROM staged_payments sp
  WHERE COALESCE(
      sp.matched_gift_id,
      sp.created_gift_id,
      sp.group_reconciled_gift_id
    ) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM qb_confirmed pa
      WHERE pa.source_id = sp.id
        AND pa.gift_id = COALESCE(
          sp.matched_gift_id,
          sp.created_gift_id,
          sp.group_reconciled_gift_id
        )
    )

  UNION ALL

  -- Confirmed QB application exists but all compatibility pointers are absent.
  SELECT
    'quickbooks_ledger_without_pointer',
    'review',
    'quickbooks_payment',
    sp.id,
    pa.gift_id,
    NULL,
    jsonb_build_object(
      'applicationId', pa.application_id,
      'amountApplied', pa.amount_applied,
      'payerName', sp.payer_name,
      'amount', sp.amount,
      'qbEntityId', sp.qb_entity_id
    )
  FROM qb_confirmed pa
  JOIN staged_payments sp ON sp.id = pa.source_id
  WHERE sp.matched_gift_id IS NULL
    AND sp.created_gift_id IS NULL
    AND sp.group_reconciled_gift_id IS NULL

  UNION ALL

  -- Donorbox pointer exists but no matching confirmed counted ledger row.
  SELECT
    'donorbox_pointer_without_ledger',
    'high',
    'donorbox_donation',
    d.id,
    COALESCE(d.matched_gift_id, d.created_gift_id),
    NULL,
    jsonb_build_object(
      'matchedGiftId', d.matched_gift_id,
      'createdGiftId', d.created_gift_id,
      'status', d.status,
      'donorName', d.donor_name,
      'amount', d.amount,
      'donationType', d.donation_type
    )
  FROM donorbox_donations d
  WHERE COALESCE(d.matched_gift_id, d.created_gift_id) IS NOT NULL
    AND d.donation_type IS DISTINCT FROM 'stripe'
    AND NOT EXISTS (
      SELECT 1
      FROM donorbox_confirmed pa
      WHERE pa.source_id = d.id
        AND pa.gift_id = COALESCE(d.matched_gift_id, d.created_gift_id)
    )

  UNION ALL

  -- Proposed counted rows are valid, but must never be included in settled sums.
  SELECT
    'proposed_counted_application',
    'info',
    pa.evidence_source::text,
    COALESCE(pa.payment_id, pa.stripe_charge_id, pa.donorbox_donation_id),
    pa.gift_id,
    NULL,
    jsonb_build_object(
      'applicationId', pa.id,
      'amountApplied', pa.amount_applied,
      'matchMethod', pa.match_method,
      'createdAt', pa.created_at
    )
  FROM payment_applications pa
  WHERE pa.link_role = 'counted'
    AND pa.lifecycle = 'proposed'

  UNION ALL

  -- Confirmed settlement plus counted QB and Stripe applications to the same gift
  -- is the candidate set for settlement-boundary supersession.
  SELECT
    'settlement_double_count_candidate',
    'critical',
    'settlement',
    sl.payout_id,
    qb.gift_id,
    NULL,
    jsonb_build_object(
      'settlementLinkId', sl.id,
      'depositStagedPaymentId', sl.deposit_staged_payment_id,
      'qbApplicationId', qb.application_id,
      'qbAmount', qb.amount_applied,
      'stripeChargeIds', jsonb_agg(DISTINCT sc.id),
      'stripeApplicationIds', jsonb_agg(DISTINCT spa.application_id),
      'stripeAppliedTotal', SUM(spa.amount_applied)
    )
  FROM settlement_links sl
  JOIN qb_confirmed qb
    ON qb.source_id = sl.deposit_staged_payment_id
  JOIN stripe_staged_charges sc
    ON sc.stripe_payout_id = sl.payout_id
  JOIN stripe_confirmed spa
    ON spa.source_id = sc.id
   AND spa.gift_id = qb.gift_id
  WHERE sl.lifecycle = 'confirmed'
  GROUP BY
    sl.id,
    sl.payout_id,
    sl.deposit_staged_payment_id,
    qb.application_id,
    qb.gift_id,
    qb.amount_applied

  UNION ALL

  -- Conflict gift ids left on confirmed links are retained for review. They may
  -- be valid historical provenance or stale crumbs; this query does not decide.
  SELECT
    'confirmed_settlement_conflict_gift',
    'review',
    'settlement',
    sl.payout_id,
    sl.conflict_gift_id,
    NULL,
    jsonb_build_object(
      'settlementLinkId', sl.id,
      'depositStagedPaymentId', sl.deposit_staged_payment_id,
      'confirmedAt', sl.confirmed_at,
      'provenance', sl.provenance
    )
  FROM settlement_links sl
  WHERE sl.lifecycle = 'confirmed'
    AND sl.conflict_gift_id IS NOT NULL
)
SELECT * FROM issues;

-- Summary suitable for comparing before/after runs.
SELECT
  issue_type,
  severity,
  COUNT(*) AS issue_count
FROM reconciliation_integrity_issues
GROUP BY issue_type, severity
ORDER BY
  CASE severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'review' THEN 3
    ELSE 4
  END,
  issue_type;

-- Complete review set. Export this result to CSV before any repair.
SELECT
  issue_type,
  severity,
  source_type,
  source_id,
  gift_id,
  other_gift_id,
  details
FROM reconciliation_integrity_issues
ORDER BY
  CASE severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'review' THEN 3
    ELSE 4
  END,
  issue_type,
  source_id,
  gift_id;

ROLLBACK;
