-- Migration 0042: Clear donor-less "amount + date" suggested matches
--
-- The QuickBooks reconciliation matcher used to fall back to a pure amount+date
-- guess: when a staged payment had NO donor evidence (no email, payer-name, or
-- memo hit), it borrowed the donor of the single existing CRM gift with the same
-- dollar amount within ±10 days. That produced misleading attributions — e.g. a
-- $25,000 loan repayment from "Flor do Loto" showed a donor of "Amy Gips" purely
-- because an unrelated $25,000 gift from Amy existed near that date.
--
-- The matcher no longer does this (the donor-less amount+date fallback was
-- removed), so newly-scored rows will never carry method = 'amount_date' again.
-- This backfill clears the WRONG donor off the rows that the old fallback already
-- stamped, returning them to "unmatched" so a human resolves them from scratch.
--
-- WHAT IT DOES:
--   For every staged payment whose match_method = 'amount_date', null out the
--   suggested donor FKs, the match score, and the match method, and set the match
--   status back to 'unmatched'. The 'amount_date' enum value is retained
--   (deprecated, unused) per the project's "keep deprecated, don't drop"
--   convention — only the data is cleared, not the type.
--
-- SAFETY / GUARDS (only touches rows a person has NOT already resolved):
--   * match_method = 'amount_date'         — only the bad guesses, nothing else.
--   * status = 'pending'                    — never reopens an approved/rejected/
--                                             excluded decision.
--   * match_confirmed_at IS NULL            — never overrides a human-confirmed
--                                             match (a person who confirmed an
--                                             amount_date suggestion keeps it).
--   * matched_gift_id IS NULL
--     AND created_gift_id IS NULL
--     AND group_reconciled_gift_id IS NULL  — never unlinks a row already tied to
--                                             a ledger gift. (The amount_date
--                                             fallback was a low-confidence
--                                             "suggested" hint, never auto-applied,
--                                             so unlinked is the expected state.)
--
-- IDEMPOTENT: after the first apply no pending/unconfirmed/unlinked row carries
-- match_method = 'amount_date', so re-running is a no-op.
--
-- LEDGER: nothing is minted, voided, or reassigned. amount_date was never written
-- to the gifts ledger (it was suggested-tier only), so there is nothing to unwind.
--
-- APPLY (dev is done by the agent; production by a human — the agent cannot write
-- to prod):
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0042_quickbooks_clear_amount_date_suggestions.sql

BEGIN;

UPDATE staged_payments
   SET match_status = 'unmatched',
       match_method = NULL,
       match_score = NULL,
       organization_id = NULL,
       individual_giver_person_id = NULL,
       household_id = NULL,
       updated_at = now()
 WHERE match_method = 'amount_date'
   AND status = 'pending'
   AND match_confirmed_at IS NULL
   AND matched_gift_id IS NULL
   AND created_gift_id IS NULL
   AND group_reconciled_gift_id IS NULL;

-- Verification (expect 0 rows after apply):
--   SELECT count(*) FROM staged_payments WHERE match_method = 'amount_date';

COMMIT;
