# Runbook — 0103 Backfill off-books gifts onto no-payment allocation entities

## What this does

Prepares the data for retiring the three legacy off-books header booleans on
`gifts_and_payments` (`designated_to_school`, `off_books_fiscal_sponsor`,
`payment_expected`). Off-books / payment-exempt now derives **only** from the
allocation entities: a gift is off-books exactly when it has ≥1 allocation and
**every** allocation sits on a no-payment entity (`entities.expects_payment =
false`) — `direct_to_school` or `wildflower_foundation_tsne`. This mirrors
`giftIsOffBooksExpr()` in `artifacts/api-server/src/lib/giftPaymentSummary.ts`.

| Step | Action |
| --- | --- |
| 1 | Idempotently seed the two no-payment entities (`direct_to_school`, `wildflower_foundation_tsne`). Prod already has both; **dev has neither**. |
| 2 | Repoint every allocation of a `designated_to_school` gift onto `direct_to_school`. |
| 3 | Repoint every allocation of an `off_books_fiscal_sponsor` / `payment_expected = false` gift (not already designated) onto `wildflower_foundation_tsne`. Zero rows today. |
| 4 | Guard: abort (roll back) if **any** header-off-books gift would flip to on-books under the allocation-only rule. |

## Why it is needed

The currently-deployed build **OR's the header flags into** the off-books
derivation. This task's new build drops those OR terms. Without this backfill,
every gift that is off-books *only* because of a header flag would silently flip
**off-books → on-books** the moment the new code deploys (pulled into the
settled-vs-entered reconciliation queue, QB-tie demanded). Repointing their
allocations onto a no-payment entity keeps them off-books under the new rule —
**zero flips**.

## Why it is safe (verified read-only, dev AND prod)

- `designated_to_school = TRUE` on **49** gifts (dev **and** prod);
  `off_books_fiscal_sponsor` and `payment_expected = false` are **0 rows** in dev
  **and** prod.
- All 49 designated gifts have ≥1 allocation and **every** allocation currently
  sits on `wildflower_foundation` (`expects_payment = TRUE`) — i.e. they would all
  flip on-books without this file.
- Prod already holds both no-payment entity rows; **dev holds neither**, so step 1
  seeds them (no-op in prod, creates them in dev) — the repoint FK would fail in
  dev otherwise.
- **Booking decision (confirmed with the product owner):** the 49 designated gifts
  are true pass-through money → booked onto `direct_to_school`, stay off-books.
  This is deliberately distinct from an allocation's `school_recipient_id` on the
  `wildflower_foundation` entity (money WF received then passed to a school, still
  expects a payment, stays on-books) — those rows are **not** touched.

## Pre-checks (re-run read-only against prod right before applying)

```sql
-- expect 49 / 0 / 0:
SELECT count(*) FILTER (WHERE designated_to_school)      AS designated,
       count(*) FILTER (WHERE off_books_fiscal_sponsor)  AS offbooks_fs,
       count(*) FILTER (WHERE payment_expected = false)  AS not_pay_expected
FROM gifts_and_payments;
-- expect both no-payment entities present in prod:
SELECT id, expects_payment FROM entities WHERE expects_payment = false ORDER BY id;
-- expect all designated gifts' allocations on wildflower_foundation (pre-state):
SELECT ga.entity_id, count(DISTINCT g.id) FROM gifts_and_payments g
  JOIN gift_allocations ga ON ga.gift_id = g.id
 WHERE g.designated_to_school GROUP BY 1 ORDER BY 1;
```

## Ordering

Apply this file **before** 0104 (which drops the columns — this file still reads
them). It is safe to apply **before** the new code is Published: the old build
already treats no-payment-entity allocations as off-books, so repointing changes
nothing for the old build while pre-positioning the new one. Apply to **prod and
dev**; do not Publish in between.

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0103_backfill_offbooks_to_allocation_entities.sql   # prod
psql "$DATABASE_URL"      -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0103_backfill_offbooks_to_allocation_entities.sql   # dev
```

`psql -1` wraps the file in ONE transaction — do not add `BEGIN`/`COMMIT` inside it.

## Idempotency

Entity seed is `ON CONFLICT DO NOTHING`; each repoint is guarded by `entity_id IS
DISTINCT FROM` the target. A re-run after a successful apply is a no-op. The step-4
guard raises and rolls back the whole file if any flip remains.

## Verify (read-only, after applying)

```sql
-- Every designated gift's allocations now on direct_to_school (expect one row):
SELECT ga.entity_id, count(*) FROM gifts_and_payments g
  JOIN gift_allocations ga ON ga.gift_id = g.id
 WHERE g.designated_to_school GROUP BY 1 ORDER BY 1;
```

## Rollback

Data-only and non-destructive; there is nothing structural to undo. If a repoint
must be reversed before 0104 runs, restore the prior `entity_id` from a backup for
the affected `gift_allocations` rows (all were `wildflower_foundation`). After 0104
drops the header columns the old semantics no longer exist, so forward-fix by
correcting the allocation entity instead.
