-- Restore the single trip reported accidentally archived in feedback_rIVzsTS4iMG_1sPbKHuT6.
UPDATE trip_plans
SET archived_at = NULL, updated_at = now()
WHERE id = '0GFunMfZWI8y_NPFBN9qp'
  AND title = 'Philly for Yass event'
  AND travel_starts_at = TIMESTAMPTZ '2026-10-05 14:00:00+00'
  AND travel_ends_at = TIMESTAMPTZ '2026-10-07 20:00:00+00'
  AND archived_at < TIMESTAMPTZ '2026-11-18 21:10:00+00';
