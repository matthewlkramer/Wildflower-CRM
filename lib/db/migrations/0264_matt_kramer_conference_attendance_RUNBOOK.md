# 0264 — Matthew Kramer conference-attendance backfill

This data-only migration records reviewed attendance evidence from Matthew
Kramer's synced CRM calendar. It targets the active `Matthew Kramer` person
record linked to Wildflower Foundation (`rec3SDFFk6rokw1pW`), not the separate
historical University of Minnesota `Matt Kramer` record.

The migration creates missing annual conference-event rows, reuses any existing
row with the same conference type and year, and inserts attendance with the
database uniqueness guard on `(conference_event_id, person_id)`. Existing
attendance is never overwritten.

## Reviewed evidence

| Conference                                  | Year | Status    | Calendar evidence                                                                          |
| ------------------------------------------- | ---: | --------- | ------------------------------------------------------------------------------------------ |
| SXSW EDU                                    | 2018 | confirmed | Panel preparation plus an in-person Austin meeting during conference week                  |
| NewSchools Summit                           | 2018 | likely    | A calendar-attached message says Matthew heard the invitee at the summit the prior week    |
| ASU+GSV Summit                              | 2023 | confirmed | Panel planning and in-person conference-hotel meetings                                     |
| ASU+GSV Summit                              | 2024 | confirmed | In-person meeting explicitly located at ASU GSV                                            |
| Grantmakers for Education Annual Conference | 2024 | likely    | Conference-specific planning and an in-person Minneapolis session in the conference window |
| NewSchools Summit                           | 2025 | confirmed | Calendar explicitly says “Matt at New Schools Summit”                                      |
| ASU+GSV Summit                              | 2026 | confirmed | Multiple in-person meetings at summit venues                                               |

Preparation-only items without corroborating attendance, future events, generic
partner meetings, and asynchronous Yass Prize judging windows were excluded.

## Production application

From the repository root, a human runs:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0264_matt_kramer_conference_attendance.sql
```

## Verification

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT
  ct.display_name,
  ce.year,
  ca.status,
  ca.source_reference,
  ca.evidence_note
FROM conference_attendance ca
JOIN conference_events ce ON ce.id = ca.conference_event_id
JOIN conference_types ct ON ct.id = ce.conference_type_id
WHERE ca.person_id = 'rec3SDFFk6rokw1pW'
ORDER BY ce.year, ct.display_name;
"
```

Expected result: seven rows matching the reviewed-evidence table above.
