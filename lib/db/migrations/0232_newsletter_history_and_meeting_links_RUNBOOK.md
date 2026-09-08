# Runbook — newsletter history and meeting links

This release adds source-evidence tables for the reviewed Flodesk workbook and
direct calendar-event pointers on structured meeting notes and optional
free-form CRM notes. The workbook contains contact data and is intentionally
**not** committed to git.

## 1. Apply the idempotent schema migration

From the repository root, after setting the production connection URL:

```bash
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0232_newsletter_history_and_meeting_links.sql
```

The migration also backfills meeting-note links only when creator, exact event
timestamp, exact title, and linked CRM contact produce a one-to-one match.
Ambiguous notes remain unlinked.

## 2. Publish the application

Use the normal human-initiated Replit Publish flow from `main`.

## 3. Import the workbook

Sign in as an admin, open **Engagement → Newsletter**, choose **Import Flodesk
workbook**, and select the reviewed `.xlsx` file. The import is idempotent and
can be repeated after corrections.

Expected source-only parse counts for the September 8, 2026 workbook:

- 11 campaigns
- 1,572 unique audience/contact evidence rows
- 3,427 recipient engagement rows across five campaigns
- 1,536 current active subscriber addresses after the August 2026 unsubscribe section

CRM-linked, subscribed, unsubscribed, and invalidated-email counts depend on
the production database and are shown in the success message/audit log.

## 4. Verify

```sql
SELECT count(*) FROM newsletter_campaigns;
SELECT count(*) FROM newsletter_contacts;
SELECT count(*) FROM newsletter_engagement;
SELECT count(*) FROM meeting_notes WHERE calendar_event_id IS NOT NULL;
SELECT count(*) FROM notes WHERE calendar_event_id IS NOT NULL;
```
