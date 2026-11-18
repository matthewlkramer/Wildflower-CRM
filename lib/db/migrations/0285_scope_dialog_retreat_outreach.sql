-- Scope the reported Dialog Retreat trip to the 2027 edition and requested outreach organization.
-- The registration confirmation gives March 4–7, 2027 in San Diego.
-- Grantmakers for Education is the feedback's requested outreach scope, separate from the event organizer.
DO $$
DECLARE
  series_id text;
  edition_id text;
  outreach_id constant text := 'recfkDyBNuK3OYAGe';
  trip_id constant text := '1poBDBTB6M7pt5xAZIPYy';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM trip_plans
    WHERE id = trip_id AND title = 'Dialog Retreat' AND archived_at IS NULL
      AND travel_starts_at = TIMESTAMPTZ '2027-03-03 15:00:00+00'
      AND travel_ends_at = TIMESTAMPTZ '2027-03-08 00:00:00+00'
  ) THEN
    RETURN;
  END IF;

  SELECT id INTO STRICT series_id FROM conference_types
  WHERE lower(trim(display_name)) = 'dialog retreat';
  IF NOT EXISTS (
    SELECT 1 FROM organizations WHERE id = outreach_id
      AND lower(trim(name)) = 'grantmakers for education'
      AND archived_at IS NULL AND NOT anonymous
  ) THEN
    RAISE EXCEPTION 'The verified Dialog outreach organization is unavailable';
  END IF;

  INSERT INTO conference_events
    (id, conference_type_id, year, start_date, end_date, location, status, source)
  VALUES
    ('dialog_retreat_2027', series_id, 2027, DATE '2027-03-04', DATE '2027-03-07',
      'San Diego, CA', 'planned', '2027 Dialog registration confirmation')
  ON CONFLICT (conference_type_id, year) DO NOTHING;

  SELECT id INTO STRICT edition_id FROM conference_events
  WHERE conference_type_id = series_id AND year = 2027;

  UPDATE trip_plans
  SET conference_event_id = coalesce(conference_event_id, edition_id),
      outreach_organization_id = coalesce(outreach_organization_id, outreach_id),
      updated_at = now()
  WHERE id = trip_id AND archived_at IS NULL
    AND (conference_event_id IS NULL OR conference_event_id = edition_id)
    AND (conference_event_id IS NULL OR outreach_organization_id IS NULL);
END $$;
