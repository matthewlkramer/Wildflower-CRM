-- Migration 0042: Re-sweep — loan / repayment on the LINE detail.
--
-- Re-runs the `loan` line/memo classifier rule over the EXISTING QuickBooks
-- review queue. Matching rows are marked status = 'excluded',
-- exclusion_reason = 'loan'. NOTHING is deleted.
--
-- WHY THIS EXISTS:
--   A fundraiser reported a stuck $25,000 "LOAN REPAYMENT" from "Flor do Loto"
--   (posting account "Loans to Schools", ~2023-05-05) sitting in the review
--   queue. Diagnosis: this is NOT a classifier pattern gap — isLoanLineOrText in
--   quickbooksExclusionRules.ts already matches a "LOAN REPAYMENT" item and a
--   "Loans to Schools" account (covered by an existing unit test). The cause is
--   OPERATIONAL: the classifier runs only at INSERT time, and the watermark-based
--   incremental sync never re-classifies historical rows. Rows that were staged
--   before the loan-line rule existed (or before their line detail was enriched)
--   stay pending until a human excludes them by hand. The 0033 Part-B backfill
--   already swept the queue once on 2026-06-06; this migration re-sweeps so loan
--   rows that have arrived (or been re-enriched) SINCE then are caught too,
--   without anyone having to hand-exclude them.
--
-- This mirrors classifyStagedPayment() / isLoanLineOrText() in
-- quickbooksExclusionRules.ts EXACTLY:
--   * LOAN (line/memo) is a GUARDED line rule — a "loan"/"loans"/"repayment"
--     whole-word marker on the line item / posting account / line description /
--     raw reference, honored only on rows that do NOT also carry a real donation
--     line (a 4000/4100 donation account or a "Donation" item), so a gift bundled
--     with a loan reference is never hidden. Word-anchored + plural-aware so
--     "Reloaning" / "loaning" can't match by accident.
--   * Scans the SAME four fields the code scans (raw_reference, line_description,
--     line_item_names, line_account_names). It deliberately does NOT scan
--     line_classes or qb_transaction_memo — neither is in isLoanLineOrText, and
--     scanning them would drift from the engine and risk false positives.
--
-- RULE PRECEDENCE: higher-precedence rules from earlier migrations
-- (zero_amount / payer-loan / insurance / government_reimbursement /
-- fiscally_sponsored / …) have already excluded their rows. This update is
-- pending-only, so it can never relabel an already-excluded row.
--
-- SAFETY / IDEMPOTENCY:
--   * Only touches rows whose status is currently 'pending' AND whose
--     classification_source is 'auto'. This mirrors reclassifyStagedPayments()
--     exactly: a `manual` row (a human exclude OR a human re-include back into
--     the queue) is PERMANENT and is never re-excluded. (Note: 0033 guarded only
--     on status='pending'; adding the classification_source guard here is a
--     deliberate correctness improvement — without it, a fundraiser who had
--     re-included a loan-line row, deciding it IS a gift, would have it silently
--     re-excluded.)
--   * Approved / rejected / already-excluded rows are never modified, so prior
--     decisions are preserved and re-running is a clean no-op.
--   * Reuses the existing 'loan' exclusion_reason value — no enum change.
--
-- EXPECTED IMPACT (prod, read-only check 2026-06-17, pre-apply): the two known
--   Flor do Loto rows are ALREADY excluded='loan' (hand-excluded, so
--   classification_source='manual') and there are currently ZERO pending rows
--   carrying a loan/repayment line marker — so this is a NO-OP against prod right
--   now. It is delivered as the durable, idempotent re-sweep to run after future
--   syncs so the same stuck-loan situation cannot recur silently.
--
-- PREREQUISITES:
--   1. App code with isLoanLineOrText is deployed (it is).
--   2. Rows carry line detail (line_account_names etc.). Rows missing line detail
--      can't be classified by line — see the watermark/full-re-pull note in the
--      0024 runbook if a back-catalog ever needs re-enrichment first.
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0042_quickbooks_loan_line_resweep.sql

BEGIN;

-- ─── loan / repayment on the LINE detail (GUARDED by donation-first) ──────────
UPDATE staged_payments
   SET status = 'excluded',
       exclusion_reason = 'loan',
       updated_at = now()
 WHERE status = 'pending'
   AND classification_source = 'auto'
   -- donation-first guard: skip rows that ALSO carry a real donation line
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) a
                    WHERE lower(btrim(a)) LIKE '4000%' OR lower(btrim(a)) LIKE '4100%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names, '{}'::text[])) li
                    WHERE lower(btrim(li)) LIKE '%donation%')
   -- loan / repayment marker on the raw reference / line description / item / account
   AND ( coalesce(raw_reference, '')    ~* '\m(loans?|repayment)\M'
      OR coalesce(line_description, '') ~* '\m(loans?|repayment)\M'
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_item_names,    '{}'::text[])) x WHERE x ~* '\m(loans?|repayment)\M')
      OR EXISTS (SELECT 1 FROM unnest(coalesce(line_account_names, '{}'::text[])) x WHERE x ~* '\m(loans?|repayment)\M') );

-- Verification:
--   SELECT status, exclusion_reason, count(*)
--   FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

COMMIT;
