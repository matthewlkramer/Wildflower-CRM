-- Migration 0033: Backfill — loan activity by LINE detail + COBRA insurance by
-- the bare "COBRA" marker.
--
-- Re-runs two REFINED classifier rules over the EXISTING QuickBooks review queue.
-- Matching rows are marked status = 'excluded'. NOTHING is deleted.
--
-- WHY THIS EXISTS:
--   A fundraiser reported "lots of cards that have loan repayment as a line item
--   or somewhere else on the record. Cobra too." Two gaps in the classifier:
--
--   1. LOAN (line/memo) — the `loan` rule matched only the PAYER name (and the
--      guaranty income account). School loans that arrive with a generic or blank
--      payer carry the marker on the LINE instead: the "Loans to Schools" /
--      "Loan Funds" / "PPP Loan Received" / "Note Payable" balance-sheet
--      accounts, a "LOAN REPAYMENT" item, or a "… Repayment" deposit
--      description. The classifier now ALSO matches a "loan"/"repayment" marker
--      on the line item / account / description / memo (isLoanLineOrText in
--      quickbooksExclusionRules.ts); this backfill mirrors that for existing rows.
--
--   2. INSURANCE (COBRA) — the `insurance` marker was the CONTIGUOUS token
--      "basiccobra". Real deposits read "COBRA TRUST ACCT BASICPacif…" (the BASIC
--      administrator name is glued to "Pacif"), or "… Cobra", posted to the
--      "2002 Benefit Liability" account — so the only marker is the separate word
--      COBRA. The marker is now "cobra" (it subsumes "basiccobra"); this backfill
--      mirrors that.
--
-- This mirrors classifyStagedPayment() in quickbooksExclusionRules.ts EXACTLY:
--   * INSURANCE is an IDENTITY rule — a "cobra" substring (case-insensitive)
--     ANYWHERE on the row (payer, memo, line description, item, account, Class).
--     It is NOT subject to the donation-first guard (COBRA is never a gift).
--   * LOAN (line/memo) is a GUARDED line rule — a "loan"/"loans"/"repayment"
--     whole-word marker on the line item / account / description / memo, honored
--     only on rows that do NOT also carry a real donation line (a 4000/4100
--     donation account or a "Donation" item), so a gift bundled with a loan
--     reference is never hidden. Word-anchored + plural-aware so "Reloaning" /
--     "loaning" can't match by accident.
--
-- RULE PRECEDENCE (first-match-wins): insurance (step 4b) is HIGHER than loan
-- (step 5), so Part A runs first; Part B is pending-only and can't steal an
-- already-excluded COBRA row. Higher-precedence rules from earlier migrations
-- (zero_amount / payer-loan / government_reimbursement / fiscally_sponsored) have
-- already excluded their rows, so a pending-only update can't disturb them.
--
-- SAFETY / IDEMPOTENCY:
--   * Only ever touches rows whose status is currently 'pending'. Approved /
--     rejected / already-excluded rows are never modified, so prior decisions and
--     re-includes are preserved and re-running is a no-op.
--   * Reuses the existing 'insurance' and 'loan' exclusion_reason values — no
--     enum change. (Requires 0029 to have added 'insurance' to the enum, which it
--     has: this migration is a no-op for COBRA otherwise but would NOT error,
--     because 'insurance' already exists in prod.)
--
-- NOTE (reviewer): a handful of Part B rows are repayments of the org's OWN
--   expenses posted to "7016 …Transportation, Hotel & Housing Costs"
--   ("Repayment of the accidental personal charges…", "Castle repayment of
--   duplicate…"). They are genuine non-gifts and are labeled `loan` here because
--   they carry the word "repayment" (and no "refund" token). If you would rather
--   they read `expense_refund`, recode them by hand after this runs.
--
-- PREREQUISITES:
--   1. The new app code (cobra marker + loan line/memo rule) is deployed.
--   2. Existing rows carry line detail (line_account_names, etc.). Rows missing
--      line detail can't be classified by line — see the watermark note in the
--      0020-0021 runbook if the back-catalog needs a full re-pull first.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0033_quickbooks_loan_line_cobra_backfill.sql

BEGIN;

-- ─── Part A: COBRA / insurance by the bare "cobra" marker (identity, UNGUARDED) ───
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'insurance',
       updated_at = now()
 WHERE status = 'pending'
   AND ( coalesce(payer_name, '')       ILIKE '%cobra%'
      OR coalesce(raw_reference, '')     ILIKE '%cobra%'
      OR coalesce(line_description, '')  ILIKE '%cobra%'
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,    '{}'::text[])) x WHERE x ILIKE '%cobra%')
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) x WHERE x ILIKE '%cobra%')
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_classes,       '{}'::text[])) x WHERE x ILIKE '%cobra%') );

-- ─── Part B: loan / repayment on the LINE detail (GUARDED by donation-first) ───
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'loan',
       updated_at = now()
 WHERE status = 'pending'
   -- donation-first guard: skip rows that ALSO carry a real donation line
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%')
   -- loan / repayment marker on the line item / account / description / memo
   AND ( coalesce(raw_reference, '')    ~* '\m(loans?|repayment)\M'
      OR coalesce(line_description, '') ~* '\m(loans?|repayment)\M'
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,    '{}'::text[])) x WHERE x ~* '\m(loans?|repayment)\M')
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) x WHERE x ~* '\m(loans?|repayment)\M') );

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;
