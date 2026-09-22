# Receivable invoice components and Broadstreet rule

Apply these migrations after the application release is ready:

1. Run `0259_receivable_invoice_components.sql` with autocommit. PostgreSQL enum
   values cannot be added and used in the same transaction.
2. Run `0260_broadstreet_lease_guaranty_rule.sql` in a new transaction.

The schema change stores read-only QuickBooks invoice applications and gives
each derived deposit component a stable invoice identity. The seed rule affects
new QuickBooks payments only and does not overwrite later admin edits.

Verification:

```sql
SELECT id, exclusion_reason, conditions
FROM quickbooks_handling_rules
WHERE id = 'seed_broadstreet_lease_guaranty';

SELECT column_name
FROM information_schema.columns
WHERE table_name IN ('staged_payments', 'bank_deposit_components')
  AND column_name IN ('qb_invoice_applications', 'source_invoice_id');
```
