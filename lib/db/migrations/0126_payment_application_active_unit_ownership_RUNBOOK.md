# Migration 0126 — Active processor-unit ownership

## Purpose

Prevent a non-splittable processor unit from being actively assigned to more than one CRM gift.

The migration adds partial unique indexes for:

- one active counted gift owner per Stripe charge;
- one active counted gift owner per Donorbox donation.

`proposed` and `confirmed` applications are active. `exempt` rows are historical and do not participate. QuickBooks payments are intentionally excluded because one payment may be split across gifts.

## Preconditions

Run these read-only checks before applying:

```sql
SELECT stripe_charge_id, array_agg(DISTINCT gift_id ORDER BY gift_id) AS gift_ids
FROM payment_applications
WHERE stripe_charge_id IS NOT NULL
  AND link_role = 'counted'
  AND lifecycle IN ('proposed', 'confirmed')
GROUP BY stripe_charge_id
HAVING count(DISTINCT gift_id) > 1;

SELECT donorbox_donation_id, array_agg(DISTINCT gift_id ORDER BY gift_id) AS gift_ids
FROM payment_applications
WHERE donorbox_donation_id IS NOT NULL
  AND link_role = 'counted'
  AND lifecycle IN ('proposed', 'confirmed')
GROUP BY donorbox_donation_id
HAVING count(DISTINCT gift_id) > 1;
```

Both result sets must be empty. The migration repeats these checks and aborts before creating either index if a conflict exists.

## Apply

Apply after migration 0125:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0126_payment_application_active_unit_ownership.sql
```

## Verify

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'payment_applications'
  AND indexname IN (
    'payment_applications_stripe_charge_active_owner_uq',
    'payment_applications_donorbox_donation_active_owner_uq'
  )
ORDER BY indexname;
```

Expected: two rows.

Test the guard only in a disposable database by attempting to insert a second proposed or confirmed counted application for the same Stripe charge or Donorbox donation with a different gift. PostgreSQL should reject it with a unique-constraint violation.

## Rollback

```sql
DROP INDEX IF EXISTS payment_applications_stripe_charge_active_owner_uq;
DROP INDEX IF EXISTS payment_applications_donorbox_donation_active_owner_uq;
```

Dropping the indexes restores the previous schema but does not modify any application rows.
