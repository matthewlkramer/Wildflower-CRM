-- 0133_bulk_resolve_coding_form_rows.sql
-- Bulk-resolve the pending coding-form review queue (269 rows judged 2026-07-18).
-- Idempotent: every UPDATE is guarded (status='pending' AND match_confirmed_at IS NULL for
-- coding rows; derived-pending for staged QB rows), so re-running is a no-op and rows a
-- human already touched are never overwritten.
-- Touches coding_form_rows + two staged_payments exclusions (non-donation QB rows).
-- Gift/opportunity/allocation writes happen later in-app via "Apply decided"
-- (POST /coding-form-rows/apply-decided), which runs the normal applyRow path per row.
-- Confirmer stamped as usr_matthew_kramer; to attribute to Erica instead, replace all
-- occurrences of 'usr_matthew_kramer' before running.
-- Run AFTER Publish, from the repo root:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0133_bulk_resolve_coding_form_rows.sql

-- ── 1. Confirm verified matcher suggestions (161 rows; donor + gift/opp cross-checked offline) ──
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_10' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 3d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_14' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_16' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 35d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_19' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 7d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_23' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 19d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_24' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"skip","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_25' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 8d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_27' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_28' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_29' AND status = 'pending' AND match_confirmed_at IS NULL; -- opportunity match verified (donor ok; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_31' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_34' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_35' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 4d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_37' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 4d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_40' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 3d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_41' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 19d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_42' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 10d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_43' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_44' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_45' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_46' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 15d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_47' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 2d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_48' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_50' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 28d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_100' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 80d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_101' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_102' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 2d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_104' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 6d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_105' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 7d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_106' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 4d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_107' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_13' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 12d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_24' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_25' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_28' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 70d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_31' AND status = 'pending' AND match_confirmed_at IS NULL; -- opportunity match verified (donor ok; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_32' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 3d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_33' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 3d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_36' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 4d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_37' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_38' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_4' AND status = 'pending' AND match_confirmed_at IS NULL; -- opportunity match verified (donor ok; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_41' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_42' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 17d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","intendedUsage":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_43' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_44' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 12d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_46' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 4d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_47' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 10d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_48' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 10d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","intendedUsage":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_5' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_50' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_51' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_52' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_53' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_54' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 21d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_56' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_57' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 15d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_58' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_59' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 70d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_62' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_63' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 11d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_65' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_66' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 38d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_67' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 61d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_68' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 44d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_7' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 118d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_76' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 77d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_77' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 77d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_79' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 90d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_80' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_81' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 90d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_82' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_84' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_85' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_86' AND status = 'pending' AND match_confirmed_at IS NULL; -- opportunity match verified (donor ok; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_87' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_88' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 80d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_89' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_90' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 74d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_91' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 48d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_92' AND status = 'pending' AND match_confirmed_at IS NULL; -- opportunity match verified (donor ok; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_93' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_94' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_95' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 70d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_96' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 62d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_97' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_98' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_1' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_101' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 40d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_102' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 26d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_103' AND status = 'pending' AND match_confirmed_at IS NULL; -- opportunity match verified (donor ok; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_105' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_12' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_13' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 63d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","allocationEntity":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_17' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 3d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_2' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_20' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 5d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_22' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_23' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 5d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_24' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"circle":"apply","additionalNotes":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_27' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 19d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_29' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 6d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_3' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 77d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_33' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 8d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_34' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 8d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_35' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 7d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_36' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 7d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_37' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 7d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_38' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 7d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_39' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 7d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_4' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_40' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 6d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_43' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_44' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_45' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_46' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_47' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_48' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 10d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_49' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_5' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_51' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 19d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_52' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 18d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_53' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 17d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_54' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 14d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_56' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 7d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_57' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 6d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_62' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 2d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_63' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_68' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_69' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_71' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 30d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_72' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_73' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_74' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 23d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_75' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_76' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_77' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_78' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_79' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_80' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_81' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_83' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 26d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_84' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 16d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_85' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 13d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_86' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 6d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_88' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_89' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_90' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_92' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 28d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_93' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 26d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_95' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 22d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_96' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 24d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_97' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 15d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_98' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 8d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_10' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 38d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_11' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 14d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_4' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 10d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_6' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_7' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"skip","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_8' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"skip","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_9' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 12d apart; tier high)

-- ── 2. Hand-matched donor + gift (8 rows; manual matches, confirmed) ──
-- cfr_fy24_32: Patrick & Alice Rogers Family Foundation — gift "Marge Barrett FY24 Renewal" $5,000 under the Rogers Family Foundation — name/FY/amount all line up
UPDATE coding_form_rows SET organization_id = 'recQKRNjVhIbx5XUK', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recJVrV3gyde5cQLH', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_32' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_55: Philip Vasan — gift "FY25 Phil Vasan $500 Donation" 2025-01-15 vs Vanguard check 12/27/24
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recMWdUfgt0ypOtnw', household_id = NULL, matched_gift_id = 'recmH2fnaKbGzDR02', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_55' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_26: Nic and Lindsey Barnes — gift "$10,000 Barnes DAF gift FY26 for Dahlia El" 2025-11-05 — exact match
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = NULL, household_id = 'recg4hWiZf5yWyY8X', matched_gift_id = 'rechAxQORhxOg0w6T', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_26' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_42: Melanie Dukes — gift "FY26 Dukes BWF $2500" 2025-12-12 — exact match
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recVNldVoMfPM6Guc', household_id = NULL, matched_gift_id = 'recY57WUtUaBiHD1s', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_42' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_55: Amy Hertel Buckley — gift "FY26 Amy Buckley $500 donation" 2025-12-22 books at $522.24 gross (Donorbox fee-covered)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'reck0U5MXvGRdczSU', household_id = NULL, matched_gift_id = 'recrlwUcVlY8BTkfG', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_55' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_64: Janet Begin — gift "FY26 Begin $100 to BWF" dated 2026-01-07, same day as the row
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'rec3gSFy31XzY99yL', household_id = NULL, matched_gift_id = 'recZ23F2OXVPavxjN', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_64' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_girasol_0: Hanhwa Kao — gift "Kao check #1 FY25" $5,000 2024-10-03 vs row 2024-10-01
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'rech9yJEBFKYrNhO1', household_id = NULL, matched_gift_id = 'recfNNQt6xxEfcQNz', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"intendedUsage":"skip","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_0' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_girasol_1: Hanhwa Kao — gift "Kao check #2 FY25" $5,000 2024-10-03 vs row 2024-10-01
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'rech9yJEBFKYrNhO1', household_id = NULL, matched_gift_id = 'rec5MgcANAINnbNL1', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"skip","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_1' AND status = 'pending' AND match_confirmed_at IS NULL;

-- ── 3. Donor identified, gift not yet booked (18 rows; donor pre-filled, row stays pending, NOT confirmed) ──
-- cfr_fy24_30: Early Milestones (CO LISC) — LISC/Colorado funder; no $8,578.61 gift booked yet
UPDATE coding_form_rows SET organization_id = 'rec14pJ2GxEA8rDBL', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy24_30' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy24_33: McKnight Foundation — clean org match; no $25,000 gift booked yet
UPDATE coding_form_rows SET organization_id = 'rec5hHTZtAvHDAAou', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy24_33' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy24_36: National Black Child Development Institute — NBCDI = National Black Child Development Institute; no $540 gift booked yet
UPDATE coding_form_rows SET organization_id = 'recHrDwEgoYLZfH3f', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy24_36' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy24_39: Spring Point Partners — clean org match; no $5,000 gift booked yet
UPDATE coding_form_rows SET organization_id = 'recyNsmL9fqD2I4am', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy24_39' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy25_103: Frey Foundation — clean org match; no $60,000 gift booked yet
UPDATE coding_form_rows SET organization_id = 'recZapft5FP7mSHen', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy25_103' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy25_34: Lars and Becky Klevan — household matched via FY23 "$250 Schwab DAF Klevan gift"; FY25 $250 gift not booked yet
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = NULL, household_id = 'recKYqy4Ex554BliC', matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy25_34' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy25_39: Amy Gips — person matched (books the "$15,000 AG to BWF" gift); NOTE: a separate org record "Amy Gips" also exists — possible duplicate; no $5,000 gift booked yet
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recV86TdJUORXwIXo', household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy25_39' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_108: Arthur Rock — gave via Vanguard Charitable (person, not the company); $150k BWF slice of a larger gift not booked yet
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recKplPq3lVeYkBwO', household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_108' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_19: Allen Vasan — person matched via 2020 gift; no FY26 $5,000 Seed Fund gift booked yet
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recUUKMRD6p9qLG15', household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_19' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_21: Lars and Becky Klevan — same household as FY25 row; FY26 $500 gift not booked yet
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = NULL, household_id = 'recKYqy4Ex554BliC', matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_21' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_25: Cisco / Cisco Foundation — employee-match donor; no $10,000 Cisco gift booked yet (the $10k FY26 gift is the Barnes DAF gift, matched to cfr_fy26_26)
UPDATE coding_form_rows SET organization_id = 'recnvTVfO9PjlXm6Q', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_25' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_58: Fidelity Foundations — $15,000 slice of the $80,000 Inkwell grant; no matching gift booked yet
UPDATE coding_form_rows SET organization_id = 'rec56v5anV8D4xP9l', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_58' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_59: Fidelity Foundations — $65,000 slice of the $80,000 Inkwell grant; no matching gift booked yet
UPDATE coding_form_rows SET organization_id = 'rec56v5anV8D4xP9l', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_59' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_6: Loyola University Maryland — Center for Montessori Education sits under Loyola University Maryland; no $2,088 gift booked yet
UPDATE coding_form_rows SET organization_id = 'recSToOLE0pP2kst1', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_6' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_61: Scholler Foundation (of Philadelphia) — memo says "for work in PA / the MidAtlantic" — the Philadelphia Scholler; no FY26 $5,000 gift booked yet
UPDATE coding_form_rows SET organization_id = 'recpJVf8d3D7fDCad', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_61' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_70: Jacqueline Miller — name match; candidate gift "MILLER 104.7" is 2025-12-31 vs row 2026-02-23 — likely a different monthly payment, gift left unmatched
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recv386PuzZGDaBNx', household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_70' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_91: Jim and Gretchen Cantoni — name match (Jim=James); candidate gift 2026-02-12 vs row 2026-03-11 — likely a different monthly payment, gift left unmatched
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = NULL, household_id = 'rec09zdC8mGgea1Dj', matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_91' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_99: Gary Community Investments — Gary Community Ventures = Gary Community Investments; no $500 gift booked yet
UPDATE coding_form_rows SET organization_id = 'recv3OOopQycgtsey', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_99' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;

-- ── 4. Skip non-donations (27 rows: refunds, reimbursements, school fees, test rows, one duplicate) ──
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy24_26' AND status = 'pending' AND match_confirmed_at IS NULL; -- IRS employee-retention credit refund — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy24_49' AND status = 'pending' AND match_confirmed_at IS NULL; -- WeWork service-retainer refund — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_1' AND status = 'pending' AND match_confirmed_at IS NULL; -- IRS credit refund (same 941 credit as the FY24 sheet row) — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_10' AND status = 'pending' AND match_confirmed_at IS NULL; -- school membership fee (invoice) — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_11' AND status = 'pending' AND match_confirmed_at IS NULL; -- school fee invoice — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_14' AND status = 'pending' AND match_confirmed_at IS NULL; -- IRS check; submitter marked "not a donor"
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_15' AND status = 'pending' AND match_confirmed_at IS NULL; -- school contribution/membership payment — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_16' AND status = 'pending' AND match_confirmed_at IS NULL; -- school membership-fee ACH — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_17' AND status = 'pending' AND match_confirmed_at IS NULL; -- school contribution payment — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_18' AND status = 'pending' AND match_confirmed_at IS NULL; -- school contribution ACH — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_19' AND status = 'pending' AND match_confirmed_at IS NULL; -- school contributions (Riverseed & Blue) — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_20' AND status = 'pending' AND match_confirmed_at IS NULL; -- school contribution (Blue Montessori membership) — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_21' AND status = 'pending' AND match_confirmed_at IS NULL; -- school membership-fee invoices (Lirio) — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_22' AND status = 'pending' AND match_confirmed_at IS NULL; -- school contribution (Water Lily invoice) — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_23' AND status = 'pending' AND match_confirmed_at IS NULL; -- duplicate: this $10,000 (paid via 2 checks) is the same money as the two Girasol sheet rows matched to "Kao check #1/#2"
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_3' AND status = 'pending' AND match_confirmed_at IS NULL; -- We Are Rally LLC travel-expense reimbursement — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_35' AND status = 'pending' AND match_confirmed_at IS NULL; -- repayment of a personal charge on the Divvy card — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_69' AND status = 'pending' AND match_confirmed_at IS NULL; -- State of MN tax refund; submitter marked "not a donor"
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_8' AND status = 'pending' AND match_confirmed_at IS NULL; -- school contribution August payment — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_9' AND status = 'pending' AND match_confirmed_at IS NULL; -- school contribution invoice — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy26_0' AND status = 'pending' AND match_confirmed_at IS NULL; -- test/junk submission ("All the dollars" / "yay")
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy26_106' AND status = 'pending' AND match_confirmed_at IS NULL; -- MN unemployment-insurance overpayment refund — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy26_16' AND status = 'pending' AND match_confirmed_at IS NULL; -- IRS Form 941 refund — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy26_30' AND status = 'pending' AND match_confirmed_at IS NULL; -- Hartford workers-comp premium refund — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy26_32' AND status = 'pending' AND match_confirmed_at IS NULL; -- staff member refunding a personal Divvy charge; marked "not a donor"
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy26_41' AND status = 'pending' AND match_confirmed_at IS NULL; -- IRS refund check — not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy26_65' AND status = 'pending' AND match_confirmed_at IS NULL; -- IRS refund — not a donation

-- ── 5. Exclude the matching non-donation QuickBooks staged rows (mirrors POST /staged-payments/:id/exclude) ──
-- Every other non-donation skip's QB row is already excluded in the reconciliation queue
-- (membership / tax_refund / expense_refund / zero_amount) — verified against prod 2026-07-18.
-- Guard mirrors the route: only a derived-PENDING row (no exclusion, no counted booking,
-- no confirmed settlement link, no booked charge tie) can be excluded.
-- g6Ad2qr2RNPSkCSgnTZPb: We Are Rally $637.83 (2024-07-22) — travel-expense reimbursement mislabeled "Donation" (coding form cfr_fy25_3)
UPDATE staged_payments SET exclusion_reason = 'expense_refund', classification_source = 'manual', updated_at = now()
  WHERE id = 'g6Ad2qr2RNPSkCSgnTZPb' AND exclusion_reason IS NULL
    AND NOT EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.payment_id = staged_payments.id AND pa.link_role = 'counted')
    AND NOT EXISTS (SELECT 1 FROM settlement_links sl WHERE sl.deposit_staged_payment_id = staged_payments.id AND sl.lifecycle = 'confirmed')
    AND NOT EXISTS (SELECT 1 FROM stripe_staged_charges cc WHERE cc.linked_qb_staged_payment_id = staged_payments.id
          AND EXISTS (SELECT 1 FROM payment_applications pac WHERE pac.stripe_charge_id = cc.id AND pac.evidence_source = 'stripe' AND pac.link_role = 'counted'));
-- OnHtz0il_QXi68OtEm2_n: IRS check $5,021.50 (deposit 2024-08-30) — submitter marked "not a donor" (coding form cfr_fy25_14)
UPDATE staged_payments SET exclusion_reason = 'tax_refund', classification_source = 'manual', updated_at = now()
  WHERE id = 'OnHtz0il_QXi68OtEm2_n' AND exclusion_reason IS NULL
    AND NOT EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.payment_id = staged_payments.id AND pa.link_role = 'counted')
    AND NOT EXISTS (SELECT 1 FROM settlement_links sl WHERE sl.deposit_staged_payment_id = staged_payments.id AND sl.lifecycle = 'confirmed')
    AND NOT EXISTS (SELECT 1 FROM stripe_staged_charges cc WHERE cc.linked_qb_staged_payment_id = staged_payments.id
          AND EXISTS (SELECT 1 FROM payment_applications pac WHERE pac.stripe_charge_id = cc.id AND pac.evidence_source = 'stripe' AND pac.link_role = 'counted'));

-- ── Verification ──
-- Note: confirming does NOT change status — confirmed rows stay status='pending' until
-- "Apply decided" in the app flips them to 'applied'. Expected right after this run
-- (queue was 269 pending when judged on 2026-07-18):
--   ready_to_apply  >= 169 (161 verified matcher confirms + 8 hand matches; more if anyone confirmed via the UI since 2026-07-18)
--   donor_prefilled >= 18  (donor stamped, unconfirmed; >= if other manual-method rows exist)
--   still_pending   = 242  (269 - 27 skips; drops to 73 after "Apply decided")
--   qb_excluded     = 2
SELECT
  count(*) FILTER (WHERE status = 'pending' AND match_confirmed_at IS NOT NULL) AS ready_to_apply,
  count(*) FILTER (WHERE status = 'pending' AND match_confirmed_at IS NULL AND match_method = 'manual'
                   AND matched_gift_id IS NULL
                   AND (organization_id IS NOT NULL OR individual_giver_person_id IS NOT NULL OR household_id IS NOT NULL)) AS donor_prefilled,
  count(*) FILTER (WHERE status = 'pending') AS still_pending,
  (SELECT count(*) FROM staged_payments WHERE id IN ('g6Ad2qr2RNPSkCSgnTZPb', 'OnHtz0il_QXi68OtEm2_n') AND exclusion_reason IS NOT NULL) AS qb_excluded
FROM coding_form_rows;
