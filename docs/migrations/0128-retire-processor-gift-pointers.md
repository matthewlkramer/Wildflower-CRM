# Migration 0128 — retire Stripe and Donorbox gift pointers

## Purpose

`payment_applications` becomes the authoritative Stripe-charge/Donorbox-donation → gift relationship. The physical `matched_gift_id` and `created_gift_id` columns remain temporarily, but migration 0128 clears them and prevents older application processes from making them durable again during a rolling deployment.

## Required order

1. Deploy the ledger-first application code from the reconciliation rewrite branch.
2. Apply migrations through 0127.
3. Run the pointer-retirement audit:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f lib/db/audits/stripe_pointer_retirement.sql
   ```

4. Resolve every pointer/ledger disagreement reported by the audit. Do not weaken the migration guards.
5. Dry-run migration 0128 inside a transaction.
6. Apply migration 0128.
7. Re-run the integrity audits and application checks.

Migration 0128 must run after the application writers are ledger-first. Its database triggers are a rolling-deploy safety net, not a replacement for the code cutover.

## Preflight

The following queries must return zero before application:

```sql
-- Stripe pointer without equivalent active application.
SELECT count(*)
FROM stripe_staged_charges sc
WHERE (sc.matched_gift_id IS NOT NULL OR sc.created_gift_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM payment_applications pa
    WHERE pa.stripe_charge_id = sc.id
      AND pa.evidence_source = 'stripe'
      AND pa.link_role = 'counted'
      AND pa.lifecycle IN ('proposed', 'confirmed')
      AND pa.gift_id = coalesce(sc.matched_gift_id, sc.created_gift_id)
  );

-- Donorbox pointer without equivalent active application.
SELECT count(*)
FROM donorbox_donations dd
WHERE (dd.matched_gift_id IS NOT NULL OR dd.created_gift_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM payment_applications pa
    WHERE pa.donorbox_donation_id = dd.id
      AND pa.evidence_source = 'donorbox'
      AND pa.link_role = 'counted'
      AND pa.lifecycle IN ('proposed', 'confirmed')
      AND pa.gift_id = coalesce(dd.matched_gift_id, dd.created_gift_id)
  );

-- Malformed dual pointers.
SELECT count(*)
FROM (
  SELECT id FROM stripe_staged_charges
  WHERE matched_gift_id IS NOT NULL AND created_gift_id IS NOT NULL
  UNION ALL
  SELECT id FROM donorbox_donations
  WHERE matched_gift_id IS NOT NULL AND created_gift_id IS NOT NULL
) malformed;
```

The migration performs stricter versions of these checks, including `created_the_gift` parity, and aborts if they fail.

## Dry-run

Use a disposable restored backup first:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
\i lib/db/migrations/0128_retire_processor_gift_pointers.sql

SELECT count(*) AS stripe_pointers_remaining
FROM stripe_staged_charges
WHERE matched_gift_id IS NOT NULL OR created_gift_id IS NOT NULL;

SELECT count(*) AS donorbox_pointers_remaining
FROM donorbox_donations
WHERE matched_gift_id IS NOT NULL OR created_gift_id IS NOT NULL;

SELECT count(*) AS normalized_donorbox_terminal_statuses
FROM donorbox_donations
WHERE status IN ('approved', 'reconciled');

ROLLBACK;
SQL
```

Because the migration contains its own `BEGIN/COMMIT`, a local dry-run may instead be performed against a disposable database restored from backup. Do not wrap the file in another transaction in production automation unless nested transaction handling is known to be safe.

## Apply

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0128_retire_processor_gift_pointers.sql
```

The migration is idempotent. A second run should make no data changes and should recreate the same trigger definitions.

## Verification

```sql
SELECT count(*) AS stripe_pointers_remaining
FROM stripe_staged_charges
WHERE matched_gift_id IS NOT NULL OR created_gift_id IS NOT NULL;

SELECT count(*) AS donorbox_pointers_remaining
FROM donorbox_donations
WHERE matched_gift_id IS NOT NULL OR created_gift_id IS NOT NULL;

SELECT tgname
FROM pg_trigger
WHERE tgname IN (
  'stripe_suppress_retired_gift_pointer',
  'donorbox_suppress_retired_gift_pointer',
  'payment_application_clear_retired_processor_pointer'
)
  AND NOT tgisinternal
ORDER BY tgname;
```

Expected results:

- Both pointer counts are `0`.
- All three triggers are present.
- Donorbox `approved`/`reconciled` stored statuses are `0`; operational done status derives from confirmed applications.
- Reconciliation cards, Stripe queues, Donorbox queues, refunds, and gift summaries remain unchanged except for the removal of previously stale pointer behavior.

Then run:

```bash
pnpm check:api
pnpm check:codegen
pnpm check:test-api
pnpm check:full
```

## Rollback

Do not repopulate the retired pointers as an emergency response. They are duplicate state and may already be stale.

Application rollback options:

1. Keep migration 0128 applied and roll back only to an application version that can read `payment_applications`.
2. If an older pointer-dependent application must be restored, restore the pre-migration database backup into a separate environment and reconcile the application/database versions before traffic is moved.

To remove only the rolling-deploy enforcement triggers after every old writer has been eliminated:

```sql
BEGIN;
DROP TRIGGER IF EXISTS stripe_suppress_retired_gift_pointer
  ON stripe_staged_charges;
DROP TRIGGER IF EXISTS donorbox_suppress_retired_gift_pointer
  ON donorbox_donations;
DROP TRIGGER IF EXISTS payment_application_clear_retired_processor_pointer
  ON payment_applications;
DROP FUNCTION IF EXISTS suppress_retired_processor_gift_pointer();
DROP FUNCTION IF EXISTS clear_retired_processor_gift_pointer_from_application();
COMMIT;
```

Removing the triggers does not restore pointer data and should happen only after repository search confirms there are no remaining operational pointer writes.
