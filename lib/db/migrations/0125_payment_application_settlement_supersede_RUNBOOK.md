# Migration 0125 — Payment-application settlement supersession

## Purpose

A confirmed Stripe payout ↔ QuickBooks deposit settlement identifies the same bank dollars at two grains:

- Stripe charge applications are donor-level evidence.
- The QBO deposit application is coarse settlement evidence.

When confirmed counted Stripe applications from the settled payout cover a gift's QBO application within the shared processor fee band, migration 0125 changes the QBO row from `counted` to `corroborating`. This prevents the same dollars from entering gift settled gross twice.

The migration records `superseded_by_settlement_link_id` so removal of the settlement or charge-level coverage can safely restore only rows demoted by this mechanism.

## Preconditions

1. Apply all earlier migrations, including the settlement-link and payment-application ledger migrations.
2. Deploy application code containing:
   - lifecycle-aware `payment_applications` readers;
   - `settlementSupersede.ts`;
   - settlement-link mutation hooks.
3. Run and save the integrity audit:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/audits/reconciliation_integrity.sql \
  > reconciliation-integrity-before-0125.txt
```

4. Review all critical pointer/ledger disagreement and multiple-owner rows. Migration 0125 does not repair donor or ownership conflicts.
5. Take a fresh database backup.

## Dry run

Restore a recent production backup to an isolated database, then run:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0125_payment_application_settlement_supersede.sql
```

Run the audit again:

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/audits/reconciliation_integrity.sql \
  > reconciliation-integrity-after-0125.txt
```

Expected results:

- `settlement_double_count_candidate` falls to zero once the audit recognizes corroborating QBO rows.
- No new `stripe_pointer_ledger_disagree`, `stripe_charge_multiple_counted_gifts`, or `gift_claimed_by_multiple_stripe_charges` rows appear.
- Gift settled totals drop only by the duplicated QBO representation, not by the Stripe donor-level applications.
- A second execution of 0125 changes no application roles.

## Production execution

Apply manually with fail-fast behavior:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0125_payment_application_settlement_supersede.sql \
  | tee migration-0125-output.txt
```

Do not apply through an automatic startup migration runner.

The migration aborts when it finds an application collision that would require choosing between multiple counted or unrelated corroborating rows.

## Verification queries

### Superseded QBO applications

```sql
SELECT
  pa.id,
  pa.payment_id,
  pa.gift_id,
  pa.amount_applied,
  pa.link_role,
  pa.superseded_by_settlement_link_id
FROM payment_applications pa
WHERE pa.superseded_by_settlement_link_id IS NOT NULL
ORDER BY pa.payment_id, pa.gift_id;
```

### No covered row remains counted

```sql
WITH stripe_by_settlement_gift AS (
  SELECT
    sl.id AS settlement_link_id,
    sl.deposit_staged_payment_id AS payment_id,
    spa.gift_id,
    SUM(spa.amount_applied)::numeric AS stripe_gross
  FROM settlement_links sl
  JOIN stripe_staged_charges c ON c.stripe_payout_id = sl.payout_id
  JOIN payment_applications spa
    ON spa.stripe_charge_id = c.id
   AND spa.evidence_source = 'stripe'
   AND spa.link_role = 'counted'
   AND spa.lifecycle = 'confirmed'
  WHERE sl.lifecycle = 'confirmed'
    AND sl.deposit_staged_payment_id IS NOT NULL
  GROUP BY sl.id, sl.deposit_staged_payment_id, spa.gift_id
)
SELECT pa.*
FROM payment_applications pa
JOIN stripe_by_settlement_gift s
  ON s.payment_id = pa.payment_id
 AND s.gift_id = pa.gift_id
WHERE pa.evidence_source = 'quickbooks'
  AND pa.lifecycle = 'confirmed'
  AND pa.link_role = 'counted'
  AND (
    ABS(s.stripe_gross - pa.amount_applied::numeric) < 0.01
    OR (
      s.stripe_gross >= pa.amount_applied::numeric - 0.01
      AND s.stripe_gross <= pa.amount_applied::numeric * 1.1 + 1
    )
  );
```

Expected: zero rows.

## Rollback

Application-level supersession is bidirectional. If the migration must be reversed before application code is enabled:

```sql
BEGIN;

UPDATE payment_applications
SET
  link_role = 'counted',
  superseded_by_settlement_link_id = NULL,
  updated_at = now()
WHERE evidence_source = 'quickbooks'
  AND lifecycle = 'confirmed'
  AND link_role = 'corroborating'
  AND superseded_by_settlement_link_id IS NOT NULL;

COMMIT;
```

Do not drop the provenance column during an incident rollback. Keeping it is harmless and preserves diagnostic information until the system is stable.
