# App feedback proposal rollout

This change adds a durable AI proposal row for every in-app feedback item. It
does not alter or delete feedback records. New submissions are queued
immediately; a bounded background sweep creates proposals for older feedback
and recovers interrupted generations.

## Before production

1. Deploy the application code only after the migration is ready to run.
2. Confirm the existing Anthropic integration is configured; missing or
   rate-limited AI access is recorded as a proposal error and does not affect
   feedback submission.
3. Add the server secret `FEEDBACK_IMPLEMENTER_USER_ID=usr_matthew_kramer`.
   This is the single authenticated CRM account allowed to start an
   implementation handoff. If the secret is missing or blank, nobody can start
   implementation; all administrators can still review and revise proposals.

Confirm that the configured owner is still an active administrator before
publishing:

```sql
SELECT id, email, role, archived_at
FROM users
WHERE id = 'usr_matthew_kramer';
```

The row should have `role = 'admin'` and `archived_at IS NULL`.

## Apply

```sh
psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0242_app_feedback_proposals.sql
```

The migration is additive and idempotent. The application can then be
published normally. No manual backfill command is required.

## Verify

```sql
SELECT generation_status, count(*)
FROM app_feedback_proposals
GROUP BY generation_status
ORDER BY generation_status;

SELECT count(*) AS feedback_without_proposal
FROM app_feedback f
LEFT JOIN app_feedback_proposals p ON p.feedback_id = f.id
WHERE p.id IS NULL;
```

The second count should fall to zero as the bounded background sweep runs.
Rows in `error` remain visible in the admin queue and can be regenerated with
reviewer guidance. Rows stuck in `generating` for more than fifteen minutes are
automatically re-queued.

As an additional authorization check, another administrator should be able to
review and revise a proposal but should not see `Start implementation`; a direct
request to the implementation endpoint should return HTTP 403.

## Rollback

The application should be rolled back before removing the table. Data rollback
is optional because the table is isolated and references feedback with
`ON DELETE CASCADE`.

```sql
DROP TABLE IF EXISTS app_feedback_proposals;
```
