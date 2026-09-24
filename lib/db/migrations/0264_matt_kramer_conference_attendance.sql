-- 0264: Backfill Matthew Kramer's conference attendance from synced calendar evidence.
-- Data-only and idempotent. Production application is human-run; see the runbook.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM people p
    JOIN people_entity_roles per
      ON per.person_id = p.id
     AND per.organization_id IS NOT NULL
     AND per.current = 'current'
    JOIN organizations o ON o.id = per.organization_id
    WHERE p.id = 'rec3SDFFk6rokw1pW'
      AND p.full_name = 'Matthew Kramer'
      AND o.name = 'Wildflower Foundation'
  ) THEN
    RAISE EXCEPTION 'Expected active Matthew Kramer / Wildflower Foundation CRM record is missing';
  END IF;

  IF (
    SELECT count(*)
    FROM conference_types
    WHERE id = ANY (ARRAY[
      'conference_type_asu_gsv',
      'conference_type_gfe',
      'conference_type_newschools',
      'conference_type_sxsw_edu'
    ]::text[])
  ) <> 4 THEN
    RAISE EXCEPTION 'One or more required conference types are missing';
  END IF;
END
$$;

INSERT INTO conference_events (
  id,
  conference_type_id,
  year,
  status,
  source,
  notes
)
VALUES
  (
    'conference_event_sxsw_edu_2018',
    'conference_type_sxsw_edu',
    2018,
    'completed',
    'calendar_evidence',
    'Created from reviewed calendar evidence for Matthew Kramer attendance.'
  ),
  (
    'conference_event_newschools_2018',
    'conference_type_newschools',
    2018,
    'completed',
    'calendar_evidence',
    'Created from reviewed calendar evidence for Matthew Kramer attendance.'
  ),
  (
    'conference_event_asu_gsv_2023',
    'conference_type_asu_gsv',
    2023,
    'completed',
    'calendar_evidence',
    'Created from reviewed calendar evidence for Matthew Kramer attendance.'
  ),
  (
    'conference_event_asu_gsv_2024',
    'conference_type_asu_gsv',
    2024,
    'completed',
    'calendar_evidence',
    'Created from reviewed calendar evidence for Matthew Kramer attendance.'
  ),
  (
    'conference_event_gfe_2024',
    'conference_type_gfe',
    2024,
    'completed',
    'calendar_evidence',
    'Created from reviewed calendar evidence for Matthew Kramer attendance.'
  ),
  (
    'conference_event_newschools_2025',
    'conference_type_newschools',
    2025,
    'completed',
    'calendar_evidence',
    'Created from reviewed calendar evidence for Matthew Kramer attendance.'
  ),
  (
    'conference_event_asu_gsv_2026',
    'conference_type_asu_gsv',
    2026,
    'completed',
    'calendar_evidence',
    'Created from reviewed calendar evidence for Matthew Kramer attendance.'
  )
ON CONFLICT (conference_type_id, year) DO NOTHING;

UPDATE conference_events
SET
  status = 'completed',
  source = COALESCE(source, 'calendar_evidence'),
  updated_at = now()
WHERE (conference_type_id, year) IN (
  ('conference_type_sxsw_edu', 2018),
  ('conference_type_newschools', 2018),
  ('conference_type_asu_gsv', 2023),
  ('conference_type_asu_gsv', 2024),
  ('conference_type_gfe', 2024),
  ('conference_type_newschools', 2025),
  ('conference_type_asu_gsv', 2026)
)
  AND status = 'planned';

WITH reviewed_attendance (
  attendance_id,
  conference_type_id,
  conference_year,
  attendance_status,
  source_reference,
  evidence_note
) AS (
  VALUES
    (
      'conference_attendance_matt_sxsw_edu_2018',
      'conference_type_sxsw_edu',
      2018,
      'confirmed',
      'calendar_event:sAlLVZZATPPjMN6g8rkTi',
      'Calendar shows panel preparation and an in-person meeting in Austin during SXSW EDU week.'
    ),
    (
      'conference_attendance_matt_newschools_2018',
      'conference_type_newschools',
      2018,
      'likely',
      'calendar_event:HuFka7xP417PUt1hbXQwi',
      'A calendar-attached message says Matthew heard the invitee speak at the NewSchools Summit the prior week.'
    ),
    (
      'conference_attendance_matt_asu_gsv_2023',
      'conference_type_asu_gsv',
      2023,
      'confirmed',
      'calendar_events:R1q-dO5Iutyld3Nnsku5O,mPR2UbhMzxHye90rgaI8f',
      'Calendar shows Montessori panel planning plus in-person meetings at the conference hotel during the summit.'
    ),
    (
      'conference_attendance_matt_asu_gsv_2024',
      'conference_type_asu_gsv',
      2024,
      'confirmed',
      'calendar_event:K6HeNfm-vBvVJC6dnj2b4',
      'Calendar contains an in-person ASU GSV meeting during the 2024 summit.'
    ),
    (
      'conference_attendance_matt_gfe_2024',
      'conference_type_gfe',
      2024,
      'likely',
      'calendar_events:5gDTX_1NIVm06-EPzmO3n,cio3wPeTdDeoEHlxUV9dX',
      'Calendar shows conference-specific planning and an in-person Minneapolis session during the conference window.'
    ),
    (
      'conference_attendance_matt_newschools_2025',
      'conference_type_newschools',
      2025,
      'confirmed',
      'calendar_event:tZYNtxWK_MxNc1uZKhW6f',
      'Calendar explicitly marks Matthew at the New Schools Summit.'
    ),
    (
      'conference_attendance_matt_asu_gsv_2026',
      'conference_type_asu_gsv',
      2026,
      'confirmed',
      'calendar_events:i7Jjgg_nmGpLnp8vw2oHu,JfMilD3YsIV2KY7tFSllZ',
      'Calendar contains multiple in-person meetings at ASU+GSV venues during the 2026 summit.'
    )
)
INSERT INTO conference_attendance (
  id,
  conference_event_id,
  person_id,
  status,
  source_type,
  source_reference,
  evidence_note,
  organization_snapshot,
  matched_by_user_id,
  reviewed_by_user_id,
  reviewed_at
)
SELECT
  reviewed.attendance_id,
  event.id,
  'rec3SDFFk6rokw1pW',
  reviewed.attendance_status,
  'manual',
  reviewed.source_reference,
  reviewed.evidence_note,
  'Wildflower Foundation',
  'usr_matthew_kramer',
  'usr_matthew_kramer',
  now()
FROM reviewed_attendance reviewed
JOIN conference_events event
  ON event.conference_type_id = reviewed.conference_type_id
 AND event.year = reviewed.conference_year
ON CONFLICT (conference_event_id, person_id) DO NOTHING;
