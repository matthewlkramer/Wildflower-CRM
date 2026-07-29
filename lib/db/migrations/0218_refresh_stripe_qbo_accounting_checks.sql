-- Refresh machine-generated Stripe payout accounting checks after gross and net
-- booking were both accepted as legitimate. This is idempotent and deliberately
-- leaves every human-resolved row untouched.
--
-- Without this pass, a payout that was previously labeled correction_needed can
-- remain in All open indefinitely even though its current QBO amount matches the
-- payout net or gross under the corrected rule.

WITH checks AS (
  SELECT
    staged.id AS staged_id,
    jsonb_build_object(
      'kind', 'stripe_payout_lump',
      'payout_id', payout.id,
      'net_amount', COALESCE(payout.net_total, payout.amount),
      'gross_amount', payout.gross_total,
      'arrival_date', payout.arrival_date,
      'bank_deposit_id', payout.bank_deposit_id
    ) AS expected,
    jsonb_build_object(
      'amount', staged.amount,
      'date_received', staged.date_received,
      'account', staged.qb_deposit_to_account_name
    ) AS actual,
    CASE
      WHEN abs(staged.amount - COALESCE(payout.net_total, payout.amount)) <= 0.01
        THEN 'net'
      WHEN payout.gross_total IS NOT NULL
        AND abs(staged.amount - payout.gross_total) <= 0.01
        THEN 'gross'
      ELSE 'unmatched'
    END AS booking_basis,
    CASE
      WHEN abs(staged.amount - COALESCE(payout.net_total, payout.amount)) <= 0.01
        THEN 'consistent'
      WHEN payout.gross_total IS NOT NULL
        AND abs(staged.amount - payout.gross_total) <= 0.01
        THEN 'consistent'
      ELSE 'correction_needed'
    END::qbo_accounting_disposition AS disposition,
    CASE
      WHEN abs(staged.amount - COALESCE(payout.net_total, payout.amount)) <= 0.01
        THEN NULL
      WHEN payout.gross_total IS NOT NULL
        AND abs(staged.amount - payout.gross_total) <= 0.01
        THEN NULL
      ELSE 'QBO posts ' || staged.amount || ', but payout net is ' ||
           COALESCE(payout.net_total, payout.amount) ||
           CASE
             WHEN payout.gross_total IS NULL THEN ''
             ELSE ' and payout gross is ' || payout.gross_total
           END
    END AS note
  FROM staged_payments staged
  JOIN source_links settlement
    ON settlement.link_type = 'payout_qb_settlement'
   AND settlement.qb_staged_payment_id = staged.id
  JOIN stripe_payouts payout ON payout.id = settlement.stripe_payout_id
)
INSERT INTO qbo_accounting_checks (
  id,
  staged_payment_id,
  expected,
  actual,
  disposition,
  booking_basis,
  note,
  computed_at
)
SELECT
  'qac_' || check_row.staged_id,
  check_row.staged_id,
  check_row.expected,
  check_row.actual,
  check_row.disposition,
  check_row.booking_basis,
  check_row.note,
  now()
FROM checks check_row
ON CONFLICT (staged_payment_id) DO UPDATE SET
  expected = excluded.expected,
  actual = excluded.actual,
  booking_basis = excluded.booking_basis,
  disposition = CASE
    WHEN excluded.disposition = 'consistent'
     AND qbo_accounting_checks.disposition IN ('correction_needed', 'corrected')
      THEN 'corrected'::qbo_accounting_disposition
    ELSE excluded.disposition
  END,
  note = excluded.note,
  computed_at = now(),
  updated_at = now()
WHERE qbo_accounting_checks.resolved_by_user_id IS NULL
  AND qbo_accounting_checks.disposition IN
    ('consistent', 'correction_needed', 'corrected');
