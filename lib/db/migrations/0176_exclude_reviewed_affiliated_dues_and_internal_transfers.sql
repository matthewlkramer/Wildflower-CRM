-- 0176: one-time bank-deposit-level exclusion of two reviewed sets (66 + 33 = 99).
--
-- Set A — 66 affiliated-school membership / loan-repayment receipts (name-
-- confirmed). Open bank deposits whose amount matches an already-excluded
-- `membership` or `loan_repayment` staged payment within +/-14 days AND whose
-- bank memo contains the payer's leading name token (>=4 chars). The name token
-- is what makes this trustworthy (amount+date alone collides on identical dues
-- amounts), so it is the reviewed rule the user approved ("exclude the 66").
--
-- Set B — 33 internal ONLINE TRANSFER movements. Open bank deposits whose memo
-- says "online transfer" and contains csp / payroll / nonpayroll. These are
-- internal money movement with no CRM/QBO donation record ("remove all online
-- transfers that have any of csp, payroll or nonpayroll").
--   CAUTION: one Set-B row (2026-04-23, $104,288.61,
--   "ONLINE TRANSFER MARCH PAYROLL AND NNMS FEB GRANT") bundles a real grant
--   with the payroll transfer. It is excluded here per the reviewed rule; delete
--   its bank_deposit_exclusions row to return it to the queue if the NNMS grant
--   portion must be booked as a gift.
--
-- Both sets are scoped to deposits that are still OPEN (no settling Stripe
-- payout, no counted bank_deposit_components, and not already Not-fundraising via
-- an all-excluded deposit_qbo_components tie) — the exact ~99 the workbench still
-- surfaces. This is a one-time backfill of an explicitly reviewed set, NOT a
-- standing rule; no future deposit is touched. Idempotent
-- (ON CONFLICT (bank_deposit_id) DO NOTHING); re-running affects zero rows.
-- Overridable: delete a row to un-exclude that deposit.
--
-- Requires 0175 (bank_deposit_exclusions). Apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0176_exclude_reviewed_affiliated_dues_and_internal_transfers.sql

-- Shared definition of an OPEN (still-surfaced) bank deposit.
CREATE TEMP VIEW _open_dep_0176 AS
  SELECT d.*
  FROM bank_deposits d
  WHERE d.source = 'bank_csv_export'
    AND NOT EXISTS (SELECT 1 FROM stripe_payouts p WHERE p.bank_deposit_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM bank_deposit_components c WHERE c.bank_deposit_id = d.id)
    AND NOT (
      EXISTS (SELECT 1 FROM deposit_qbo_components dqc WHERE dqc.bank_deposit_id = d.id)
      AND NOT EXISTS (
        SELECT 1 FROM deposit_qbo_components dqc
        JOIN staged_payments s ON s.id = dqc.staged_payment_id
        WHERE dqc.bank_deposit_id = d.id AND s.exclusion_reason IS NULL
      )
    )
    -- Already excluded (so re-runs report 0 candidates, matching the no-op insert).
    AND NOT EXISTS (
      SELECT 1 FROM bank_deposit_exclusions e WHERE e.bank_deposit_id = d.id
    );

-- Before-state diagnostics (retain in the run log as the baseline).
SELECT 'set_A_membership_loan' AS scope, count(*) AS deposits_to_exclude
FROM _open_dep_0176 d
WHERE EXISTS (
  SELECT 1 FROM staged_payments s
  WHERE s.exclusion_reason IN ('membership', 'loan_repayment')
    AND s.amount = d.amount
    AND abs(COALESCE((s.qb_raw->>'TxnDate')::date, s.date_received) - d.deposit_date) <= 14
    AND s.payer_name IS NOT NULL
    AND d.memo ILIKE '%' || split_part(regexp_replace(s.payer_name, '^(The|A) ', '', 'i'), ' ', 1) || '%'
    AND length(split_part(regexp_replace(s.payer_name, '^(The|A) ', '', 'i'), ' ', 1)) >= 4
)
UNION ALL
SELECT 'set_B_internal_transfer', count(*)
FROM _open_dep_0176 d
WHERE d.memo ~* 'online transfer'
  AND d.memo ~* 'csp|payroll|nonpayroll|non payroll|non-payroll';

-- Set A: 66 name-confirmed affiliated dues / loan repayments.
INSERT INTO bank_deposit_exclusions (id, bank_deposit_id, reason, note)
SELECT 'bdex_' || d.id, d.id, m.reason, 'reviewed: affiliated-school ' || m.reason || ' (name-confirmed; 0176)'
FROM _open_dep_0176 d
JOIN LATERAL (
  SELECT s.exclusion_reason AS reason
  FROM staged_payments s
  WHERE s.exclusion_reason IN ('membership', 'loan_repayment')
    AND s.amount = d.amount
    AND abs(COALESCE((s.qb_raw->>'TxnDate')::date, s.date_received) - d.deposit_date) <= 14
    AND s.payer_name IS NOT NULL
    AND d.memo ILIKE '%' || split_part(regexp_replace(s.payer_name, '^(The|A) ', '', 'i'), ' ', 1) || '%'
    AND length(split_part(regexp_replace(s.payer_name, '^(The|A) ', '', 'i'), ' ', 1)) >= 4
  ORDER BY s.exclusion_reason
  LIMIT 1
) m ON true
ON CONFLICT (bank_deposit_id) DO NOTHING;

-- Set B: 33 internal ONLINE TRANSFER csp/payroll/nonpayroll movements.
INSERT INTO bank_deposit_exclusions (id, bank_deposit_id, reason, note)
SELECT 'bdex_' || d.id, d.id, 'intercompany_transfer', 'reviewed: internal online transfer csp/payroll/nonpayroll (0176)'
FROM _open_dep_0176 d
WHERE d.memo ~* 'online transfer'
  AND d.memo ~* 'csp|payroll|nonpayroll|non payroll|non-payroll'
ON CONFLICT (bank_deposit_id) DO NOTHING;

-- After-state diagnostics (expect 66 + 33 = 99 across the two reasons).
SELECT reason, count(*) AS excluded_deposits
FROM bank_deposit_exclusions
GROUP BY reason
ORDER BY reason;

DROP VIEW _open_dep_0176;
