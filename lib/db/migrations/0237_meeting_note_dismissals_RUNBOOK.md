# 0237 — Meeting note dismissals

This additive migration creates the CRM-owned disposition used by the Meetings
page's **No notes** action. It does not alter or delete synced Google Calendar
events, meeting notes, or free-form CRM notes.

From the repository root, with the production connection in
`$PROD_DATABASE_URL`:

```sh
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0237_meeting_note_dismissals.sql
```

Verify the table and unique physical-event key before publishing application
code that uses the disposition:

```sh
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select to_regclass('public.meeting_note_dismissals') as meeting_note_dismissals;"
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select indexname from pg_indexes where schemaname = 'public' and tablename = 'meeting_note_dismissals' order by indexname;"
```

Expected: the table name is non-null and the primary-key, unique Google event,
and dismissed-user indexes are listed.
