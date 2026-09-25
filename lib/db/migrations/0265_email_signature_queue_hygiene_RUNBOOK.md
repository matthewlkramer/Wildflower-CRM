# Runbook — 0265 email signature queue hygiene

This data-only migration removes known-bad pending Contact Updates while
preserving every proposal as audit history. It does not change CRM people,
phones, roles, or previously reviewed proposals.

It performs two guarded repairs:

1. Pending signature proposals sourced before September 25, 2024 are marked
   ignored. The application now enforces the same rolling 24-month freshness
   rule for new messages.
2. Deterministically invalid actions are removed: duplicate phones, the mailbox
   owner's phone, self-contradictory phone suggestions, and role actions that
   exactly match the mailbox owner's current title and organization. A proposal
   is ignored only when no valid actions remain.

The migration is idempotent and touches only `status='pending'` rows. It never
deletes data and never modifies accepted, rejected, or already ignored history.

## Preflight

```sql
SELECT
  count(*) FILTER (WHERE email_sent_at < TIMESTAMPTZ '2024-09-25 00:00:00+00') AS stale,
  count(*) AS total_pending
FROM email_proposals
WHERE kind = 'signature_update' AND status = 'pending';
```

## Apply after publishing the code

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0265_email_signature_queue_hygiene.sql
```

The script emits two notices; both remaining counts should be zero. Re-running
the migration is safe.

## Postflight

```sql
SELECT status, count(*)
FROM email_proposals
WHERE kind = 'signature_update'
GROUP BY status
ORDER BY status;
```
