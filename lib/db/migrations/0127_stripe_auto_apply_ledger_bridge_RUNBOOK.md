# Migration 0127: Stripe auto-apply ledger bridge

## Purpose

During the ledger-first rolling deploy, older Stripe sync processes may still write an unconfirmed auto-match through legacy gift pointers and then call the generic Stripe booking helper. Migration 0127 normalizes that transaction into the target state:

- one `payment_applications` row with `link_role='counted'` and `lifecycle='proposed'`;
- `match_method='system'` with no confirmer or confirmation timestamp;
- no durable `matched_gift_id` or `created_gift_id` pointer on the charge;
- no contribution to settled totals or book-once capacity.

The triggers are a compatibility bridge, not the final writer architecture. Remove them after all Stripe proposal call sites use `proposeStripeChargeApplication` or `proposeStripeAutoApplyInTx` directly.

## Preconditions

Apply migrations 0125 and 0126 first. Confirm the active-owner audit returns no violations:

```sql
SELECT stripe_charge_id, count(*)
FROM payment_applications
WHERE stripe_charge_id IS NOT NULL
  AND link_role = 'counted'
  AND lifecycle IN ('proposed', 'confirmed')
GROUP BY stripe_charge_id
HAVING count(*) > 1;
```

Expected: zero rows.

## Apply

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0127_stripe_auto_apply_ledger_bridge.sql
```

## Verify

```sql
SELECT tgname
FROM pg_trigger
WHERE tgname IN (
  'payment_applications_normalize_stripe_system_lifecycle',
  'stripe_staged_charges_retire_unconfirmed_gift_pointers'
)
AND NOT tgisinternal
ORDER BY tgname;
```

Expected: two rows.

Exercise one high-confidence Stripe auto-match in development, then verify:

```sql
SELECT
  sc.id,
  sc.auto_applied,
  sc.match_confirmed_at,
  sc.matched_gift_id,
  sc.created_gift_id,
  pa.gift_id,
  pa.lifecycle,
  pa.match_method,
  pa.confirmed_at
FROM stripe_staged_charges sc
LEFT JOIN payment_applications pa
  ON pa.stripe_charge_id = sc.id
 AND pa.link_role = 'counted'
WHERE sc.id = :'charge_id';
```

Expected:

- `auto_applied = true`
- `match_confirmed_at IS NULL`
- both legacy gift pointers are `NULL`
- exactly one ledger row
- `lifecycle = 'proposed'`
- `match_method = 'system'`
- `confirmed_at IS NULL`

## Rollback

Rollback removes only the compatibility triggers and functions; it does not alter relationship data.

```sql
BEGIN;
DROP TRIGGER IF EXISTS payment_applications_normalize_stripe_system_lifecycle
  ON payment_applications;
DROP FUNCTION IF EXISTS normalize_stripe_system_application_lifecycle();
DROP TRIGGER IF EXISTS stripe_staged_charges_retire_unconfirmed_gift_pointers
  ON stripe_staged_charges;
DROP FUNCTION IF EXISTS retire_unconfirmed_stripe_gift_pointers();
COMMIT;
```

Do not roll back while an older Stripe sync process is still deployed, or new auto-matches may again be persisted as confirmed money with legacy pointers.
