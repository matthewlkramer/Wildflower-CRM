-- Track whether each Stripe payout was booked in QuickBooks at gross or net.
-- Both conventions are accepted as complete for now; only amounts matching
-- neither basis remain accounting corrections.

ALTER TABLE qbo_accounting_checks
  ADD COLUMN IF NOT EXISTS booking_basis text;

ALTER TABLE qbo_accounting_checks
  DROP CONSTRAINT IF EXISTS qbo_accounting_checks_booking_basis_ck;

ALTER TABLE qbo_accounting_checks
  ADD CONSTRAINT qbo_accounting_checks_booking_basis_ck
  CHECK (
    booking_basis IS NULL
    OR booking_basis IN ('gross', 'net', 'unmatched')
  );

CREATE INDEX IF NOT EXISTS qbo_accounting_checks_booking_basis_idx
  ON qbo_accounting_checks (booking_basis);

-- Reclassify existing machine-managed Stripe checks immediately so previously
-- gross-booked payouts leave Accounting Corrections without waiting for a later
-- sync. Human-resolved rows remain untouched.
WITH classified AS (
  SELECT
    qac.id,
    CASE
      WHEN abs(sp.amount - payout.amount) <= 0.01 THEN 'net'
      WHEN payout.gross_total IS NOT NULL
        AND abs(sp.amount - payout.gross_total) <= 0.01 THEN 'gross'
      ELSE 'unmatched'
    END AS booking_basis
  FROM qbo_accounting_checks qac
  JOIN staged_payments sp ON sp.id = qac.staged_payment_id
  JOIN source_links sl
    ON sl.link_type = 'payout_qb_settlement'
   AND sl.qb_staged_payment_id = sp.id
  JOIN stripe_payouts payout ON payout.id = sl.stripe_payout_id
  WHERE qac.resolved_by_user_id IS NULL
    AND qac.disposition IN ('consistent', 'correction_needed', 'corrected')
)
UPDATE qbo_accounting_checks qac
SET
  booking_basis = classified.booking_basis,
  disposition = CASE
    WHEN classified.booking_basis IN ('gross', 'net')
      AND qac.disposition = 'correction_needed'
      THEN 'corrected'::qbo_accounting_disposition
    WHEN classified.booking_basis IN ('gross', 'net')
      THEN qac.disposition
    ELSE 'correction_needed'::qbo_accounting_disposition
  END,
  note = CASE
    WHEN classified.booking_basis IN ('gross', 'net') THEN NULL
    ELSE qac.note
  END,
  updated_at = now()
FROM classified
WHERE qac.id = classified.id;
