-- 0133_bulk_resolve_coding_form_rows.sql
-- Bulk-resolve the pending coding-form review queue (269 rows judged 2026-07-18;
-- decisions re-audited 2026-07-18 against the owner's donor-intent policy:
--   1. Yield gift + anything from Arthur Rock: NEVER donor_restricted (no confirms affected; all such rows left pending).
--   2. Anything for BWF / Black Wildflowers Fund: usage axis donor_restricted even if the form says gen-ops/unrestricted (6 rows flipped).
--   3. Anything for a regional hub: geo-restricted to its region regardless of the form (54 rows flipped to append region + regional axis donor_restricted).
--   4. Donorbox designations are authoritative (no rows in this queue carried an unapplied Donorbox designation).
-- SECOND PASS 2026-07-18: the 73 rows left pending after the first pass were re-judged
  -- one-by-one against prod gifts (sections 6-9 below): 49 more confirmed, 2 donor-stamped
  -- (+5 matcher prefills verified as-is), 7 skipped, 6 left pending with notes. The two IRS
  -- ERC rows moved from skip to donor-stamped (real expected money), and 12 first-pass
  -- donor-only rows were upgraded to full confirms after their gifts were found booked.
-- THIRD PASS 2026-07-19 (owner line-by-line review): fy25_28 confirm → skip (ACUDEN service
  -- revenue force-matched to the Meeker Rosebay gift on amount alone); fy25_92 rematched
  -- (matcher had the wrong donor+opp — Melva Legrand's $156 ask instead of Dionne Kirby's
  -- booked $156 gift); fy26_103 rematched (matcher confirmed Bradley's 2028 $1,000 ASK opp
  -- instead of the booked FY26 $1,000 gift); fy26_87 hand-matched (Sauque gift found booked
  -- under The College Board, the DAF sponsor); fy26_104 retargeted to the canonical May
  -- Brown gift (its previous target is a duplicate QB-grain booking of the same payment);
  -- plus one owner-verified data correction (LISC opportunity loan→grant, section 10).
  -- Idempotent: every UPDATE is guarded (status='pending' AND match_confirmed_at IS NULL for
-- coding rows; derived-pending for staged QB rows), so re-running is a no-op and rows a
-- human already touched are never overwritten.
-- Touches coding_form_rows + two staged_payments exclusions (non-donation QB rows)
-- + one opportunities_and_pledges loan_or_grant correction (section 10).
-- Gift/opportunity/allocation writes happen later in-app via "Apply decided"
-- (POST /coding-form-rows/apply-decided), which runs the normal applyRow path per row.
-- Confirmer stamped as usr_matthew_kramer; to attribute to Erica instead, replace all
-- occurrences of 'usr_matthew_kramer' before running.
-- Run AFTER Publish, from the repo root:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0133_bulk_resolve_coding_form_rows.sql

-- ── 1. Confirm verified matcher suggestions (158 rows; donor + gift/opp cross-checked offline) ──
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_10' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 3d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_14' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_16' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 35d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_19' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 7d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_23' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 19d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_24' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"skip","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_25' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 8d apart; tier high)
  -- ^ fy24_25 note (owner asked): the matched gift is named "FY25" but received 2024-06-20 (inside FY24) —
  --   it is payment #2 of a 3-payment series and the FY name is the designation year, not the receipt year.
  --   Payment #1 (recWAqR4eN9OffxOO, FY24-named, 2023-10-20) has no sheet row; payment #3 is fy25_24 → recXtS1TDwmhAnRUr. Match stands.
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_27' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_28' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"regionalRestriction":"apply","address":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_29' AND status = 'pending' AND match_confirmed_at IS NULL; -- opportunity match verified (donor ok; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_31' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_34' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_35' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 4d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_37' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 4d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_40' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 3d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_41' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 19d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_42' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 10d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"skip","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_43' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_44' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_45' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_46' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 15d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_47' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 2d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_48' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_50' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 28d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_100' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 80d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_101' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 37d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_102' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 2d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_104' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 6d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_105' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 7d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_106' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 4d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_107' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
-- Rule-2 enabler for cfr_fy25_13: the AI flagged its restriction answer ("No") as
-- junk, which suppresses the usage-restriction cross-check in "Apply decided" and
-- would silently drop the BWF restriction decision stamped below. Un-junk the field
-- so the decision can act (rule 2 overrides the "No" answer anyway).
-- Idempotent: guarded on the junk flag still being present.
  UPDATE coding_form_rows
    SET ai_interpretation = jsonb_set(ai_interpretation, '{junkFields}',
          COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(ai_interpretation->'junkFields') e
                    WHERE e <> to_jsonb('restrictionLanguage'::text)), '[]'::jsonb)),
        updated_at = now()
    WHERE id = 'cfr_fy25_13'
      AND ai_interpretation->'junkFields' @> '["restrictionLanguage"]'::jsonb;

  UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_13' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 12d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_24' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_25' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"regionalRestriction":"apply","address":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_31' AND status = 'pending' AND match_confirmed_at IS NULL; -- opportunity match verified (donor ok; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_32' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 3d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_33' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 3d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_36' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 4d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_37' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_38' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"regionalRestriction":"apply","address":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_4' AND status = 'pending' AND match_confirmed_at IS NULL; -- opportunity match verified (donor ok; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_41' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_42' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 17d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","intendedUsage":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_43' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_44' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 12d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_46' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 4d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_47' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 10d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_48' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 10d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_5' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_50' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_51' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_52' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
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
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
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
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_102' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 26d apart; tier high)
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
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
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
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_47' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
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
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_68' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_69' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_71' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 30d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_72' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_73' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 0d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_74' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 23d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_75' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_76' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_77' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_78' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_79' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_80' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_81' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_83' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 26d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_84' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 16d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_85' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 13d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_86' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 6d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_88' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_89' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_90' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 27d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_92' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 28d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_93' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 26d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_95' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 22d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_96' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 24d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_97' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 15d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_98' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 8d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_10' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 38d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_11' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 14d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_4' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 10d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_6' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier suggested)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_7' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"skip","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_8' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 1d apart; tier high)
UPDATE coding_form_rows SET match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_9' AND status = 'pending' AND match_confirmed_at IS NULL; -- gift match verified (donor+amount, 12d apart; tier high)

-- ── 2. Hand-matched donor + gift (10 rows; manual matches, confirmed) ──
-- cfr_fy24_32: Patrick & Alice Rogers Family Foundation — gift "Marge Barrett FY24 Renewal" $5,000 under the Rogers Family Foundation — name/FY/amount all line up
UPDATE coding_form_rows SET organization_id = 'recQKRNjVhIbx5XUK', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recJVrV3gyde5cQLH', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
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
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'rech9yJEBFKYrNhO1', household_id = NULL, matched_gift_id = 'rec5MgcANAINnbNL1', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_1' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_92 (THIRD PASS rematch): Dionne Kirby $156 to BWF — the matcher had prefilled Melva Legrand
--   (recrWhhKEVtUciSWQ) and her open $156 ASK opportunity; the booked money is Kirby's gift
--   "$156 FY25 Kirby to BWF" (recmMR2XcUrph7MSl). Donor corrected + matched to the gift; decisions mirror
--   the sibling BWF rows fy25_84/93/95 (same donor cohort, same form language).
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recwTcVIeS6VCL7Lh', household_id = NULL, matched_gift_id = 'recmMR2XcUrph7MSl', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_92' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_103 (THIRD PASS rematch): Katherine Bradley $1,000 for MN — the matcher had confirmed her
--   FUTURE $1,000 ASK opportunity (2028); the booked money is "$1000 Bradley FY26 to MN" (recggLgBVNih7u3S9,
--   booked under her giving-vehicle org recQlMQJNgssSXCTO). Row keeps the true donor (Bradley the person);
--   regional flip applies (Hub: Minnesota rule); memo/notes tags record provenance on the gift.
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recx1ifTLExCb887N', household_id = NULL, matched_gift_id = 'recggLgBVNih7u3S9', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_103' AND status = 'pending' AND match_confirmed_at IS NULL;

-- ── 3. Donor identified, gift not yet booked (6 rows; donor pre-filled, row stays pending, NOT confirmed) ──
  -- (12 first-pass rows that were here moved to section 6 after their gifts were found booked.)
-- cfr_fy24_30: Early Milestones (CO LISC) — LISC/Colorado funder; no $8,578.61 gift booked yet
UPDATE coding_form_rows SET organization_id = 'rec14pJ2GxEA8rDBL', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy24_30' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy24_36: National Black Child Development Institute — NBCDI = National Black Child Development Institute; no $540 gift booked yet
UPDATE coding_form_rows SET organization_id = 'recHrDwEgoYLZfH3f', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy24_36' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy25_103: Frey Foundation — clean org match; no $60,000 gift booked yet
UPDATE coding_form_rows SET organization_id = 'recZapft5FP7mSHen', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy25_103' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_58: Fidelity Foundations $15,000 — owner says fy26_58/59 are the first two payments on a
--   $320,000 Fidelity pledge, but NO $320k Fidelity pledge/opportunity exists in the CRM (searched all
--   Fidelity opps; only the $80k Inkwell grant is close). Neither payment is booked as a gift either.
--   MANUAL FOLLOW-UP: create the $320k pledge, then book these two payments against it; donor stamp below
--   keeps the rows ready.
UPDATE coding_form_rows SET organization_id = 'rec56v5anV8D4xP9l', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_58' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_59: Fidelity Foundations $65,000 — second payment on the same $320k pledge (see fy26_58 note)
UPDATE coding_form_rows SET organization_id = 'rec56v5anV8D4xP9l', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_59' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy26_6: Loyola University Maryland — Center for Montessori Education sits under Loyola University Maryland; no $2,088 gift booked yet
UPDATE coding_form_rows SET organization_id = 'recSToOLE0pP2kst1', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy26_6' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;

-- ── 4. Skip non-donations (25 rows: refunds, reimbursements, school fees, test rows, one duplicate) ──
  -- (The two IRS ERC refund rows first judged as skips moved to section 7 — real expected money.)
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy24_49' AND status = 'pending' AND match_confirmed_at IS NULL; -- WeWork service-retainer refund — not a donation
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


  -- ── 6. SECOND PASS — confirm hand-matched donor + gift (50 rows; each verified against the booked gift in prod) ──
  -- 12 of these were donor-only in section 3 in the first pass and are upgraded here now that
  -- their booked gifts were found; their section-3 stamps were removed above. Decisions follow
  -- the same owner policy rules as the first pass (Rock never restricted; BWF = usage-restricted;
  -- Hub circle = region appended + regional axis; multi-allocation gifts skip all allocation attributes).
  -- cfr_fy25_45: Sinha Kikeri Fund org; Meera Sinha (rec6Hdt6FCL1eoq8V) is the associated person
UPDATE coding_form_rows SET organization_id = 'rec2CHW7kSCPbfWoz', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'rec1NB1EFS7dppJxA', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_45' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy24_38: Scholler Foundation FY24 $5,000 grant, 2023-11-15
UPDATE coding_form_rows SET organization_id = 'recpJVf8d3D7fDCad', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recMHxIilqMtmedlw', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"apply","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_38' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_61: Scholler FY26 $5,000, 2026-01-05
UPDATE coding_form_rows SET organization_id = 'recpJVf8d3D7fDCad', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recYz1N2w7yA2Rj8s', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_61' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy24_39: Spring Point $5,000 MidAtlantic conference travel
UPDATE coding_form_rows SET organization_id = 'recyNsmL9fqD2I4am', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recbtJ7T6UEpUmrQE', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_39' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_34: Klevan Schwab DAF $250 FY25, 2024-11-22
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = NULL, household_id = 'recKYqy4Ex554BliC', matched_gift_id = 'recWAZ502r2py0y79', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_34' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_21: Klevan DAFGiving360 $500 FY26, same-day
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = NULL, household_id = 'recKYqy4Ex554BliC', matched_gift_id = 'recuWeRNpweITpTmV', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_21' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_25: Cisco/Benevity matching gift; booked $9,745 net of Benevity fee vs $10,000 sheet
UPDATE coding_form_rows SET organization_id = 'recnvTVfO9PjlXm6Q', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'rectfTJHD1Ct2Bff6', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_25' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_99: Gary Community $500 FY26, 2026-04-03
UPDATE coding_form_rows SET organization_id = 'recv3OOopQycgtsey', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recSZlM6PB2MpEjpb', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"apply","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_99' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_19: Allen Vasan FY26 $5,000, 2025-10-28
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recUUKMRD6p9qLG15', household_id = NULL, matched_gift_id = 'recfizeCcgJDLcstI', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_19' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_66: Tosha Downey $500 via AOGF DAF (AOGF org is the intermediary, person is donor)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'rec5mpAQy007hRwoW', household_id = NULL, matched_gift_id = 'recscOXQlnqcFapGh', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_66' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_94: Schiavoni $261.28 (sheet matches booked amount exactly), 2026-02-17
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = NULL, household_id = 'recRCXN9REdI3Wg5c', matched_gift_id = 'recJD01osCFlp9JBK', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_94' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_60: Barrientos FY26 $10,000 to Girasol; gift on household (row prefill was person)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = NULL, household_id = 'recUeqEPY6Y4SCUqc', matched_gift_id = 'recKJm17gyYk0ElbE', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_60' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy24_21: "Hub: Colorado / $95,000" = Gates Family Foundation FY23/24 $95,000 gift
UPDATE coding_form_rows SET organization_id = 'recbilotVgDGcwqOx', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'reclJw7j6j0cv1AZW', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_21' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_72: Erica Cantoni $1,041.44 booked 2024-12-13 (sheet $1,041, sheet date is entry date)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'reczTuMKDMJjQpg5z', household_id = NULL, matched_gift_id = 'reclHgE9b3eAiV4yB', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_72' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_74: Zita FY25 $200 to BWF, 2024-11-13; donor from gift
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recbgDQl6P7V19TGl', household_id = NULL, matched_gift_id = 'rec0CStLdZIdrKaUq', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_74' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_78: Alia Peera $26.34 to BWF, 2024-11-20
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recYsqRBl5RFnz7Iq', household_id = NULL, matched_gift_id = 'rec8WGeEsMTXIzkui', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_78' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_83: Jasmine Williams $30 FY25 to BWF
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recvk5cHkYzfcLKsq', household_id = NULL, matched_gift_id = 'recDVrhuBjwrQn2tp', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_83' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_99: Esposito $5 FY25 to BWF
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'rec6oHUM8F5RTGd4T', household_id = NULL, matched_gift_id = 'rec4RAqfCFyKbpOPd', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_99' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_50: Yohance Fuller $1,000 donation booked $1,025.52 gross (donor covered fees)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'rec18uj0VT5t1dtEk', household_id = NULL, matched_gift_id = 'rec2rmfIruZyp45QG', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_50' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_67: Keith Tom FY26 $50,000 (gift was prefilled by matcher; date on gift is 2024-12-03)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recgSdSGWkP7H3KhI', household_id = NULL, matched_gift_id = 'recIFKQo27eY4UAss', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_67' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_39: Amy Gips $5,000 FY25 BWF sponsorship, exact date match 2024-12-03
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recV86TdJUORXwIXo', household_id = NULL, matched_gift_id = 'recSzMEOcixiUIJCc', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_39' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_61: $52.37 FY25 Coulter to BWF booked on person Cristina Coulter (row FK was Coulter Financial org)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recivwq0y3IgWsH8H', household_id = NULL, matched_gift_id = 'recv2jzkZwsWyswq5', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_61' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_70: Jacqueline Miller $104.70 booked 2025-12-31; sheet dated 2026-02-23 (entry lag)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recv386PuzZGDaBNx', household_id = NULL, matched_gift_id = 'recD9JriPj0KXnfs9', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_70' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_91: Jim Cantoni $104.70 to WF MN booked 2026-02-12
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = NULL, household_id = 'rec09zdC8mGgea1Dj', matched_gift_id = 'recWGpAhncOLyoCZ2', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_91' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy24_22: "Hub: Minnesota / $20,000" = Sauer Family Foundation FY24 renewal $20,000, 2023-06-28 (inferred: only $20k MN-donor gift in window)
UPDATE coding_form_rows SET organization_id = 'recXsKWPyEdi4MW0f', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'copper-26819504', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_22' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_82: Inspired Minds Collide $514.41 booked on Erika McDowell person (her org); same exact amount
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recOCgtncqvV7ad1g', household_id = NULL, matched_gift_id = 'rechzl3wVUGWvokGY', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_82' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_7: Erica Cantoni $25 + covered fees = $26.41 gross, same-day 2025-08-13
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'reczTuMKDMJjQpg5z', household_id = NULL, matched_gift_id = '3Sma2jl733kNY_PeaKufu', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_7' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_9: Kramer $50 2025-08-13; gift on "Matthew Kramer" person (row prefill "Matt Kramer" recfaGqFyVmmQEt9Q is a duplicate person record — dedup candidate)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'rec3SDFFk6rokw1pW', household_id = NULL, matched_gift_id = 'q8hdNMW-tU3mocujuvEvs', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_9' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_100: Alexander Brown $150/month (four payments Mar/Apr/May/Jun 2026, each a Stripe charge that
--   settles into a QB deposit a few days later). This row = the April instance (gift CQCTOUS6l, Stripe-counted,
--   QB corroborating). Sheet dates are form-submission dates and lag the money — month assignment is by
--   elimination; both Brown rows carry identical decisions, so the assignment cannot change what Apply writes.
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'rec8N0JkuFLYJPbS1', household_id = NULL, matched_gift_id = 'CQCTOUS6l-g85uTYdidxx', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_100' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_104: Brown May instance (THIRD PASS retarget). The owner's duplicate hunch was RIGHT: May has TWO
--   $150 Brown gifts for ONE payment — eUBk8zWoVto1XYBEqosYN (05-08, Stripe-counted, matches the canonical
--   monthly pattern) and O19isipf8UIhokCX94iCu (05-12, counted from the QB deposit the 05-08 charge settles
--   into; every other month's QB deposit is only corroborating). Row now targets the canonical Stripe-counted
--   gift. MANUAL FOLLOW-UP: unbook/merge duplicate gift O19isipf8UIhokCX94iCu (demote its QB deposit
--   R2a_3l4HEIV7b4sWIAfjO to corroborating on eUBk8zWoVto1XYBEqosYN) so May isn't double-counted.
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'rec8N0JkuFLYJPbS1', household_id = NULL, matched_gift_id = 'eUBk8zWoVto1XYBEqosYN', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_104' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_87: Gabriela (Lizzette) Sauque $5,000 for MN (THIRD PASS: was "no booked gift found" — the money IS
--   booked, as "$5000 College Board donation to MN Support" (rechFIhsFJgbDgGBd) under The College Board
--   (rec0jBcKPXdw6oKMG), her DAF/employer giving vehicle. Row keeps the true donor (Sauque, matcher-prefilled);
--   regional flip applies (Hub: Minnesota rule); memo/notes tags record provenance on the gift.
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recbN18kucfbE0a75', household_id = NULL, matched_gift_id = 'rechFIhsFJgbDgGBd', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_87' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_26: Kinsman gift #1
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'reccil4JAF6rGK9xi', household_id = NULL, matched_gift_id = 'recaEvDq6sH0dUwwD', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_26' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_girasol_2: duplicate of fy25_26 (girasol sheet)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'reccil4JAF6rGK9xi', household_id = NULL, matched_gift_id = 'recaEvDq6sH0dUwwD', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_2' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_27: Kinsman gift #2 (sheet row named the law firm; gift booked on person)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'reccil4JAF6rGK9xi', household_id = NULL, matched_gift_id = 'recIjd13EwIbt4srb', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_27' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_girasol_3: duplicate of fy25_27 (girasol sheet)
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'reccil4JAF6rGK9xi', household_id = NULL, matched_gift_id = 'recIjd13EwIbt4srb', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_3' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_49: Timber Capital/Clark $10,000 to Girasol, 2025-01-09
UPDATE coding_form_rows SET organization_id = 'rec80LYdX11ETxz25', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recapgGLcI8ABN0R7', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_49' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_girasol_5: duplicate of fy25_49 (girasol sheet)
UPDATE coding_form_rows SET organization_id = 'rec80LYdX11ETxz25', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recapgGLcI8ABN0R7', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_girasol_5' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_0: Arthur Rock $1.5M "Arthur School FY24" gift 2024-06-25 (2 allocations: gen-ops + seed fund per memo)
UPDATE coding_form_rows SET organization_id = 'reclK89Wz6Pd186hF', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recPuB4akP0d4AZsN', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_0' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_109: Rock FY25 $1.5M gift covers this $1M National row + fy25_110 $500k Seed row (2 allocations)
UPDATE coding_form_rows SET organization_id = 'reclK89Wz6Pd186hF', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'rec9jTzxSntRLSX5K', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_109' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_110: second row of the $1.5M FY25 Rock gift (see fy25_109)
UPDATE coding_form_rows SET organization_id = 'reclK89Wz6Pd186hF', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'rec9jTzxSntRLSX5K', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_110' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_107: FY26 Rock $1.6M gift = $1.15M gen-ops + $150k BWF + $300k Seed; 3 allocations mirror rows 107/108/109
UPDATE coding_form_rows SET organization_id = 'reclK89Wz6Pd186hF', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'DWN2URcC3_p0WhfUItlxo', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_107' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_108: BWF $150k row of the FY26 Rock $1.6M gift
UPDATE coding_form_rows SET organization_id = 'reclK89Wz6Pd186hF', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'DWN2URcC3_p0WhfUItlxo', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_108' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_109: Seed Fund $300k row of the FY26 Rock $1.6M gift
UPDATE coding_form_rows SET organization_id = 'reclK89Wz6Pd186hF', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'DWN2URcC3_p0WhfUItlxo', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_109' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_14: FY26 Bainum $200k booked as one gift with WF + BWF allocations; this is the BWF $100k row
UPDATE coding_form_rows SET organization_id = 'recykXYoQ7gJhNeoE', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recPAyPfDYjmRPFMY', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_14' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy26_15: Foundation General $100k row of the FY26 Bainum $200k gift
UPDATE coding_form_rows SET organization_id = 'recykXYoQ7gJhNeoE', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recPAyPfDYjmRPFMY', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy26_15' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_12: FY25 Bainum $150k paid as two $75k gifts; linked #1 (has the WF+BWF split allocations); #2 = rech41XoGnOj5mFf1
UPDATE coding_form_rows SET organization_id = 'recykXYoQ7gJhNeoE', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'rec6M9ehJDbPxExkc', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"skip","usageRestriction":"skip","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_12' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_40: Spencer Burns $10k booked as two $5k gifts (PR #1 + #2); linked #1; #2 = recjnNxL16EtgjwFM
UPDATE coding_form_rows SET organization_id = NULL, individual_giver_person_id = 'recfexbTrwOo44huV', household_id = NULL, matched_gift_id = 'rec45R65X7FeIZ9rs', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"skip","intendedUsage":"skip","regionalRestriction":"apply","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_40' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_64: AOGF $3,500 check funded two gifts: Gates matching $2,625 (linked) + Downey $875 (recGpltnPNwQQXuQ3); AOGF is the DAF intermediary
UPDATE coding_form_rows SET organization_id = 'recmFiVt4H3XWM4dE', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recYeA9b5NLTUTWUE', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"apply","usageRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_64' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy24_33: McKnight $25k board-designated paid as two $12.5k gifts; linked #1 (2023-09-08); #2 = recrmfdpKoADPXlWx (2023-11-06)
UPDATE coding_form_rows SET organization_id = 'rec5hHTZtAvHDAAou', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recReHXt8wdJxqRwL', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"purposeVerbatim":"skip","usageRestriction":"skip","intendedUsage":"apply","regionalRestriction":"apply","address":"skip","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy24_33' AND status = 'pending' AND match_confirmed_at IS NULL;
-- cfr_fy25_108: Stand Together final $500k of 3; they paid $1M covering FY25+FY26 — this row maps to the FY26 $500k gift
UPDATE coding_form_rows SET organization_id = 'recSv5y0mG6ZQGFBX', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = 'recPcj9oTgckhzPTp', matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', match_confirmed_at = now(), match_confirmed_by_user_id = 'usr_matthew_kramer', decisions = '{"reportDeadline":"apply","purposeVerbatim":"skip","usageRestriction":"skip","address":"apply","circle":"apply","seriesType":"apply","additionalNotes":"apply","internalMemo":"apply"}'::jsonb, updated_at = now()
  WHERE id = 'cfr_fy25_108' AND status = 'pending' AND match_confirmed_at IS NULL;

  -- ── 7. SECOND PASS — donor stamped, gift not yet booked (2 writes; 4 more verified as-is) ──
  -- The two IRS ERC rows were skipped in the first pass; they are real expected money
  -- (Employee Retention Credit refunds) — donor = US Dept of the Treasury, rows stay pending.
  -- cfr_fy24_26: IRS ERC refund — no gift booked anywhere (searched names, Treasury org, opportunities); Treasury org set as donor for when it lands
UPDATE coding_form_rows SET organization_id = 'rec1H13psR0jKXMLr', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy24_26' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
-- cfr_fy25_1: IRS ERC refund (FY25 letter) — same as fy24_26, not yet booked
UPDATE coding_form_rows SET organization_id = 'rec1H13psR0jKXMLr', individual_giver_person_id = NULL, household_id = NULL, matched_gift_id = NULL, matched_opportunity_id = NULL, match_method = 'manual', match_tier = 'high', updated_at = now()
  WHERE id = 'cfr_fy25_1' AND status = 'pending' AND match_confirmed_at IS NULL AND organization_id IS NULL AND individual_giver_person_id IS NULL AND household_id IS NULL;
  -- These 4 rows already carry the correct matcher-prefilled donor (match_method 'name'), verified
  -- against prod during the second pass; no write needed — they stay pending until the money books
  -- (fy26_87 was in this list until the third pass found its gift booked under The College Board — section 6):
  --   cfr_fy24_20: Gates Family Foundation $25k 2024-05-15 — no booked gift at that amount (only the FY23/24 $95k exists)
  --   cfr_fy26_31: Jennifer Houghton — sheet has no amount; nothing to match
  --   cfr_fy26_18: Excellent Schools NM $1,292.57 stand-alone reimbursement — no booked gift yet
  --   cfr_fy25_73: Anonymous $100 — prefilled catch-all anonymous person is right; no clean $100 FY25 gift on it yet

  -- ── 8. SECOND PASS — skip non-donations & one stale duplicate (8 rows; fy25_28 added in the third pass) ──
  -- Their QuickBooks staged counterparts (DCWFPCS, ACUDEN, McDowell, Rodeski) were checked in
  -- prod 2026-07-18 (all three ACUDEN rows re-checked 2026-07-19): every one is already excluded
  -- (earned_income / membership / zero_amount), so no new staged_payments exclusions are needed.
  UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_60' AND status = 'pending' AND match_confirmed_at IS NULL; -- duplicate of girasol_11 (Rodeski booked $7,000, already confirmed there); fy25 sheet recorded a stale $5,000
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy24_12' AND status = 'pending' AND match_confirmed_at IS NULL; -- DCWFPCS $3,182 — payment for Maia's time, not a donation (duplicate of fy25_2)
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_2' AND status = 'pending' AND match_confirmed_at IS NULL; -- DCWFPCS $3,182 — payment for services, not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy26_11' AND status = 'pending' AND match_confirmed_at IS NULL; -- DCWFPCS $24,965 — reimbursement + services, not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_29' AND status = 'pending' AND match_confirmed_at IS NULL; -- ACUDEN — service revenue, not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_30' AND status = 'pending' AND match_confirmed_at IS NULL; -- ACUDEN — service revenue, not a donation
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_28' AND status = 'pending' AND match_confirmed_at IS NULL; -- ACUDEN $1,500 — the third of the three ACUDEN service-revenue payments (sheet: "Not a donation, to be coded as service revenue"); was wrongly a §1 confirm onto the Meeker Rosebay gift (amount-only match). Its QB row 5AJOS6vgz474fVV8plHvi is already excluded (earned_income). THIRD PASS fix.
UPDATE coding_form_rows SET status = 'skipped', updated_at = now()
  WHERE id = 'cfr_fy25_6' AND status = 'pending' AND match_confirmed_at IS NULL; -- Dr. Erika McDowell $141.68 — sheet itself says not a donation

  -- ── 9. SECOND PASS — left pending intentionally (6 rows; genuine ambiguity, needs the owner) ──
  --   cfr_fy26_10: Anonymous $20,071.51 Seed Fund 2025-09-05 — no gift at this amount anywhere; donor unknown
--   cfr_fy26_8: Kramer $3 2025-08-13 — TWO identical $3 gifts same person/date (GtYi4sQJUKO4_YWcm0w8X, NONk3IQcw79-QdMJPmiNz). THIRD PASS checked Stripe: these are TWO REAL distinct charges minutes apart (both booked, each Stripe-counted) — NOT a duplicate booking. The sheet has one row for two payments; owner should pick which charge this row describes (or add a row for the other)
--   cfr_fy25_70: Erica Cantoni $6 recurring — two $5.52 gifts (2024-11-04) for three $6 sheet rows; net/gross and count ambiguity
--   cfr_fy25_71: same ambiguity as fy25_70
--   cfr_fy25_75: same ambiguity as fy25_70
--   cfr_fy26_28: Erica Cantoni $20 2025-12-02 — nearest gift $17.80 2025-11-17; not confident
  
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

-- ── 10. THIRD PASS — owner-verified data correction: LISC money is grants, not loans ──
-- The owner confirmed all LISC money is grant funding. All 5 booked LISC gifts already carry
-- loan_or_grant='grant' (verified in prod 2026-07-19); the one straggler is the LISC
-- opportunity, still flagged 'loan'. Guarded flip (no-op if already corrected):
UPDATE opportunities_and_pledges SET loan_or_grant = 'grant', updated_at = now()
  WHERE id = 'recdM1oPDrP7gGZxK' AND loan_or_grant = 'loan';

-- ── Verification ──
-- Note: confirming does NOT change status — confirmed rows stay status='pending' until
-- "Apply decided" in the app flips them to 'applied'. Expected right after this run
-- (queue was 269 pending when judged on 2026-07-18):
--   ready_to_apply  >= 218 (158 verified matcher confirms + 10 first-pass hand matches + 50 second-pass confirms; more if anyone confirmed via the UI since 2026-07-18)
--   donor_prefilled >= 8   (6 first-pass + 2 IRS/Treasury; the 4 verified matcher prefills keep match_method 'name' and are not counted here)
--   still_pending   = 236  (269 - 33 skips; drops to 18 after "Apply decided": 8 donor-stamped + 4 verified prefills + 6 left with notes)
--   qb_excluded     = 2
--   lisc_grant      = 1    (the LISC opportunity carries loan_or_grant='grant' after section 10)
SELECT
  count(*) FILTER (WHERE status = 'pending' AND match_confirmed_at IS NOT NULL) AS ready_to_apply,
  count(*) FILTER (WHERE status = 'pending' AND match_confirmed_at IS NULL AND match_method = 'manual'
                   AND matched_gift_id IS NULL
                   AND (organization_id IS NOT NULL OR individual_giver_person_id IS NOT NULL OR household_id IS NOT NULL)) AS donor_prefilled,
  count(*) FILTER (WHERE status = 'pending') AS still_pending,
  (SELECT count(*) FROM staged_payments WHERE id IN ('g6Ad2qr2RNPSkCSgnTZPb', 'OnHtz0il_QXi68OtEm2_n') AND exclusion_reason IS NOT NULL) AS qb_excluded,
  (SELECT count(*) FROM opportunities_and_pledges WHERE id = 'recdM1oPDrP7gGZxK' AND loan_or_grant = 'grant') AS lisc_grant
FROM coding_form_rows;
