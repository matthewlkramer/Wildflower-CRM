-- Migration 0004: Reclassify verbal_confirmation opportunities off the Pledges page
--
-- A verbal confirmation is now an OPPORTUNITY, not a pledge. Rows whose pledge
-- status is attributable ONLY to the verbal stage (sticky was_pledge flag set,
-- no grant letter, no recorded payment) are pulled back onto Opportunities:
--   * was_pledge       -> false  (clears the sticky Pledges-page flag)
--   * status           -> the canonical derived value: the loss_type override
--                         if one is set (dormant/lost stay sticky), otherwise
--                         `open` (verbal never derives to `pledge`)
--   * win_probability  -> 0.9000 only when the status actually changes (mirrors
--                         applyDerivedOppFields, which keeps win_probability when
--                         only was_pledge flips). Verbal's win prob is 0.9000.
--
-- Rows kept as pledges for an INDEPENDENT reason are left untouched:
--   * a grant letter is attached (grant_letter_url IS NOT NULL), or
--   * at least one payment has been recorded against the row.
-- written_commitment / conditional_commitment rows are out of scope (different
-- stage) and never matched by this predicate.
--
-- ORDER: run AFTER 0003 (the enum value must already be `verbal_confirmation`).
-- Depends on Task #158's schema (the loss_type column + calculated status).
--
-- Idempotent: each matched row clears was_pledge, so a second run matches
-- nothing (predicate requires was_pledge = true).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0004_reclassify_verbal_confirmation.sql

UPDATE opportunities_and_pledges o
SET
  was_pledge = false,
  status = COALESCE(o.loss_type::text, 'open')::opportunity_status,
  win_probability = CASE
    WHEN COALESCE(o.loss_type::text, 'open') <> o.status::text THEN 0.9000
    ELSE o.win_probability
  END,
  updated_at = now()
WHERE o.stage = 'verbal_confirmation'
  AND o.was_pledge = true
  AND o.grant_letter_url IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM gifts_and_payments g WHERE g.payment_on_pledge_id = o.id
  );
