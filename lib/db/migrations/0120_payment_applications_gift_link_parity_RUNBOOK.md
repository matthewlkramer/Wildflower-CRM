# Runbook — 0120 payment_applications gift-link parity (read cutover for the four legacy QB gift-link columns)

## What this does

The app now treats `payment_applications` (counted rows, `evidence_source =
'quickbooks'`) as the **SOLE** QB↔gift link record. The four legacy pointer
columns are `@deprecated` — never read, never written by the new build:

| Legacy column | Was |
| --- | --- |
| `staged_payments.matched_gift_id` | link to a pre-existing gift (reconcile) |
| `staged_payments.created_gift_id` | gift minted from this staged row |
| `staged_payments.group_reconciled_gift_id` | member of a group reconciled to one gift |
| `gifts_and_payments.final_amount_qb_staged_payment_id` | gift-side QB provenance pointer |

This file re-runs the 0066 backfill sources (A `matched_gift_id`, B
`created_gift_id`, C `group_reconciled_gift_id`, E the gift-side
`final_amount_qb_staged_payment_id` pointer) so that **every positive-amount
legacy link has a counted quickbooks ledger row**, then a parity gate DO block
**hard-fails the whole transaction** if any gap remains. Nothing is dropped;
the legacy columns stay physical, frozen at their pre-cutover values, until a
much-later drop migration.

## Ordering — apply AFTER Publish, AFTER 0118/0119, AFTER 0122

1. **Publish first.** The new build ships the read-flip and stops all legacy
   writes; 0120 only closes the data gap. (Schema-wise 0120 needs nothing new,
   but the runbook order keeps the "backfill → parity gate → reads already
   flipped" story consistent, and prod must not run the OLD build against a
   ledger the new build assumes is complete for longer than necessary.)
2. Apply 0118 and 0119 first if not yet applied (0120 assumes their state).
3. **Apply 0122 first** (`0122_clear_kirby_deposit_stale_link.sql`). A
   2026-07-14 ~01:20 UI session under the pre-cutover build left one stale
   deposit-level `matched_gift_id` on `staged_payments`
   `e5RPVWzQ79CD_jEBqrre1`. If 0120 runs before it is cleared, source A
   converts that junk pointer into a counted deposit→gift ledger row, which
   double-counts the gift once its Stripe charge is relinked per-charge. After
   0122, the `matched` census line below should report 0 for that row.

## How to apply (from the project root)

Pre-apply census (read-only — expected-gap counts; each SELECT should be
small; zero is fine):

```bash
psql "$PROD_DATABASE_URL" <<'SQL'
-- Legacy links WITHOUT a counted ledger row (what 0120 will insert):
SELECT 'matched'  AS src, count(*) FROM staged_payments sp
 WHERE sp.matched_gift_id IS NOT NULL AND sp.amount > 0
   AND EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.id = sp.matched_gift_id)
   AND NOT EXISTS (SELECT 1 FROM payment_applications pa
     WHERE pa.payment_id = sp.id AND pa.gift_id = sp.matched_gift_id AND pa.link_role = 'counted')
UNION ALL
SELECT 'created', count(*) FROM staged_payments sp
 WHERE sp.created_gift_id IS NOT NULL AND sp.amount > 0
   AND EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.id = sp.created_gift_id)
   AND NOT EXISTS (SELECT 1 FROM payment_applications pa
     WHERE pa.payment_id = sp.id AND pa.gift_id = sp.created_gift_id AND pa.link_role = 'counted')
UNION ALL
SELECT 'group', count(*) FROM staged_payments sp
 WHERE sp.group_reconciled_gift_id IS NOT NULL AND sp.amount > 0
   AND EXISTS (SELECT 1 FROM gifts_and_payments g WHERE g.id = sp.group_reconciled_gift_id)
   AND NOT EXISTS (SELECT 1 FROM payment_applications pa
     WHERE pa.payment_id = sp.id AND pa.gift_id = sp.group_reconciled_gift_id AND pa.link_role = 'counted')
UNION ALL
SELECT 'final_amount_ptr', count(*) FROM gifts_and_payments g
 WHERE g.final_amount_qb_staged_payment_id IS NOT NULL AND g.amount > 0
   AND EXISTS (SELECT 1 FROM staged_payments sp WHERE sp.id = g.final_amount_qb_staged_payment_id)
   AND NOT EXISTS (SELECT 1 FROM payment_applications pa
     WHERE pa.payment_id = g.final_amount_qb_staged_payment_id AND pa.gift_id = g.id AND pa.link_role = 'counted')
UNION ALL
-- Zero/null-amount legacy links (fatal if > 0 — investigate BEFORE applying):
SELECT 'zero_amount_links', count(*) FROM staged_payments sp
 WHERE (sp.matched_gift_id IS NOT NULL OR sp.created_gift_id IS NOT NULL
        OR sp.group_reconciled_gift_id IS NOT NULL)
   AND (sp.amount IS NULL OR sp.amount <= 0);
SQL
```

Apply (single transaction; the file has no BEGIN/COMMIT of its own):

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0120_payment_applications_gift_link_parity.sql
```

Success looks like: several `INSERT 0 <n>` lines (n may be 0 — idempotent
`ON CONFLICT DO NOTHING`) followed by

```
NOTICE:  0120 parity gate passed: every legacy gift link has a counted quickbooks ledger row.
```

If the parity gate RAISEs instead, the whole transaction rolled back and
nothing changed — report the gate's counts back before retrying.

## Why it is safe

- **Idempotent / re-runnable.** Every INSERT is `ON CONFLICT DO NOTHING`
  against the role-scoped partial unique `(payment_id, gift_id) WHERE
  link_role = 'counted'`.
- **All-or-nothing.** `psql -1` + the fatal parity gate: a gap aborts the
  entire transaction.
- **Additive only.** Inserts ledger rows; never updates or deletes anything,
  never touches the legacy columns themselves.
- **Money-total-neutral for gift amounts.** Gifts, allocations, and staged
  rows are untouched; only link records are added. The QB-tie deriver already
  reads the ledger, so any newly inserted rows can only make a gift's tie
  status MORE correct (a gift whose only link was legacy-column-resident will
  flip from `missing` to `tied`/`amount_mismatch` on its next recompute).

## Post-apply verification

```bash
psql "$PROD_DATABASE_URL" -c "SELECT count(*) FROM payment_applications WHERE link_role = 'counted' AND evidence_source = 'quickbooks';"
```

Then re-run the pre-apply census — every gap count must now be 0.
