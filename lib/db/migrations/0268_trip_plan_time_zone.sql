-- Trip schedule times are displayed in the destination's local time, not the
-- viewer's browser time. Existing US trips are backfilled from destination.

ALTER TABLE trip_plans
  ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'America/Chicago';

UPDATE trip_plans
SET time_zone = CASE
  WHEN upper(trim(destination_state)) IN ('CT', 'DE', 'DC', 'FL', 'GA', 'IN', 'KY', 'ME', 'MD', 'MA', 'MI', 'NH', 'NJ', 'NY', 'NC', 'OH', 'PA', 'RI', 'SC', 'VT', 'VA', 'WV') THEN 'America/New_York'
  WHEN upper(trim(destination_state)) IN ('AL', 'AR', 'IL', 'IA', 'KS', 'LA', 'MN', 'MS', 'MO', 'NE', 'ND', 'OK', 'SD', 'TN', 'TX', 'WI') THEN 'America/Chicago'
  WHEN upper(trim(destination_state)) IN ('CO', 'ID', 'MT', 'NM', 'UT', 'WY') THEN 'America/Denver'
  WHEN upper(trim(destination_state)) IN ('CA', 'NV', 'OR', 'WA') THEN 'America/Los_Angeles'
  WHEN upper(trim(destination_state)) = 'AZ' THEN 'America/Phoenix'
  WHEN upper(trim(destination_state)) = 'AK' THEN 'America/Anchorage'
  WHEN upper(trim(destination_state)) = 'HI' THEN 'Pacific/Honolulu'
  ELSE time_zone
END;
