# Runbook — 0066 QuickBooks cash-application ledger backfill (`payment_applications`)

## What this does

Phase 2 (dual-write + backfill) of the QuickBooks cash-application ledger rollout.
Seeds the historical `payment_applications` rows that predate live dual-write —
one ledger row per HISTORICAL QB payment→gift booking, reconstructed from the
legacy linkage columns/tables:

- **A. `staged_payments.matched_gift_id`** → 1 row, `created_the_gift=false`
  (also covers a group-RECONCILE representative, whose `matched_gift_id` is the
  group gift).
- **B. `staged_payments.created_gift_id`** → 1 row, `created_the_gift=true`
  (single mint + group-MINT representative).
- **C. `staged_payments.group_reconciled_gift_id`** → 1 row per non-representative
  MEMBER payment.
- **D. `staged_payment_splits`** → 1 row per split (`amount_applied = sub_amount`,
  the gift's gross slice).
- **E. `gifts_and_payments.final_amount_qb_staged_payment_id`** → supplement
  ONLY where no `(payment, gift)` row already exists from A–D (catches QB-stamped
  gifts whose staged-row link columns were cleared but whose provenance pointer
  survives).

The app dual-writes these rows going forward; this file only seeds the
pre-dual-write back-catalog. **No legacy column or table is changed or dropped**
— purely additive into the (until now empty) ledger.

## Provenance mapping (mirrors the live dual-write)

- `evidence_source` = `'quickbooks'` for every row (QB-only this phase — see below).
- `match_method` = `'system_confirmed'` when `auto_applied` AND
  `match_confirmed_at` is set (a human already graduated the auto-applied match),
  `'system'` when `auto_applied` but not yet confirmed (worker / auto-create
  rule), else `'human'`. Splits are always `'human'`. This mirrors the live
  dual-write: the worker writes `'system'`, and the confirm-match path promotes
  it to `'system_confirmed'`.
- `confirmed_by_user_id` / `confirmed_at` come from the staged row's
  `match_confirmed_*` (null for auto rows, which never stamp them); splits
  attribute `confirmed_by` to the split's creator.
- `amount_applied` has a CHECK (> 0), so every source filters out null /
  non-positive amounts (mirrors the dual-write guard
  `if (amount && Number(amount) > 0)`).

## Deliberately NOT booked

Stripe-payout confirm-replace and Donorbox enrichment are **not** QB
cash-applications — per the frozen model the ledger holds QB-settled money only
in this phase (`evidence_source = 'quickbooks'`). Those evidence sources land in
a later phase. This backfill is QB-only.

## Ordering

Requires migration **0065** (the `payment_applications` table + enums) already
applied, and the legacy source tables (`staged_payments`, `staged_payment_splits`,
`gifts_and_payments`) to exist. Apply **after 0065**.

### Deploy ordering

Dual-write code must be live before — or at the same time as — this backfill so
no QB booking is missed in the window between backfill and code going live. Order
on prod: apply 0065 → Publish/deploy the dual-write code → apply 0066. Because
every INSERT is `ON CONFLICT (payment_id, gift_id) DO NOTHING`, running 0066
after dual-write has already begun never duplicates a row the live code wrote.

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0066_payment_applications_backfill.sql
```

For production, use `$PROD_DATABASE_URL`:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0066_payment_applications_backfill.sql
```

`psql -1` wraps the whole file in ONE transaction — do not add `BEGIN`/`COMMIT`
inside the file (it would nest and warn). Running in file order inside that single
transaction is what lets source E's `NOT EXISTS` see the rows A–D inserted above
it.

## Idempotency

Safe to re-run. Every INSERT is `ON CONFLICT (payment_id, gift_id) DO NOTHING`,
so a second run — or a run after live dual-write has begun — is a no-op for any
pair that already exists; it only fills in genuinely missing rows. Each source
also JOINs to `gifts_and_payments`, so an orphaned/stale pointer is skipped
rather than aborting the whole load on the `gift_id` FK.

## Verify

```sql
-- Row count + breakdown by source category:
SELECT created_the_gift, match_method, count(*)
FROM payment_applications GROUP BY 1, 2 ORDER BY 1, 2;

-- BOOK-ONCE audit: any payment whose ledger SUM exceeds its own amount by more
-- than a cent (no DB constraint enforces this — inspect before the T003 read flip):
SELECT pa.payment_id, sp.amount AS payment_amount,
       sum(pa.amount_applied) AS applied
FROM payment_applications pa
JOIN staged_payments sp ON sp.id = pa.payment_id
GROUP BY pa.payment_id, sp.amount
HAVING sum(pa.amount_applied) > coalesce(sp.amount, 0) + 0.01
ORDER BY applied - sp.amount DESC;

-- PARITY spot-check: on-books gifts whose ledger SUM diverges from the gift's
-- stored amount (expected for amount_mismatch ties; should be empty for cleanly
-- QB-stamped gifts):
SELECT g.id, g.amount AS gift_amount, sum(pa.amount_applied) AS ledger_sum
FROM gifts_and_payments g
JOIN payment_applications pa ON pa.gift_id = g.id
WHERE coalesce(g.off_books_fiscal_sponsor, false) = false
  AND coalesce(g.designated_to_school, false) = false
GROUP BY g.id, g.amount
HAVING abs(sum(pa.amount_applied) - coalesce(g.amount, 0)) > 0.01
ORDER BY abs(sum(pa.amount_applied) - coalesce(g.amount, 0)) DESC;
```

Dev result at authoring time: **65 rows**; book-once audit empty; parity
spot-check clean apart from the expected `amount_mismatch` ties.

## Rollback

The ledger is still unread in Phase 2 (dual-write only; reads flip in T003), so
the backfilled rows can be cleared without affecting any live read. To remove
ONLY the backfilled QB rows (leave any live dual-written rows alone, this is a
blunt clear of all QB rows — only safe before dual-write traffic, otherwise skip):

```sql
DELETE FROM payment_applications WHERE evidence_source = 'quickbooks';
```

If abandoning the whole rollout before T003, drop the table per the 0065 runbook.
