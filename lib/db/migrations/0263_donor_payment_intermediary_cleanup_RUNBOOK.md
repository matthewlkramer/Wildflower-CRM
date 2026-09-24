# 0263 donor/payment-intermediary cleanup runbook

This migration adds reversible relationship archiving, repairs defaults that
point at archived payment intermediaries, and replaces the new-gift routing
trigger with source-first default-intermediary resolution.

## Apply before publishing the application

The old application remains compatible after this additive migration. Apply it
to the production database before publishing the new application bundle:

```sh
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0263_donor_payment_intermediary_cleanup.sql
```

## Verify

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'donor_payment_intermediaries'
  AND column_name = 'archived_at';

SELECT count(*) AS invalid_defaults
FROM donor_payment_intermediaries dpi
JOIN payment_intermediaries pi ON pi.id = dpi.payment_intermediary_id
WHERE dpi.is_default = true
  AND (dpi.archived_at IS NOT NULL OR pi.archived_at IS NOT NULL);

SELECT to_regprocedure(
  'resolve_default_payment_intermediary(text,text,text,text)'
) AS resolver;
```

Expected: `archived_at` is present, `invalid_defaults` is zero, and `resolver`
is non-null.

## Rollback

Application rollback does not require a database rollback: the added column,
constraint, indexes, and functions are backward-compatible. Keep them in place
while rolling the application back. Relationship rows archived by the new UI
will remain hidden only to the new application; no data is lost.
