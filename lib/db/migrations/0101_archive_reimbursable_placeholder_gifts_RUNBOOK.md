# Runbook — 0101 Archive placeholder award-amount gifts on reimbursable pledges

## What this does

DATA-only, non-destructive cleanup. It **archives** (soft-delete, `archived_at`;
never a hard `DELETE`) the placeholder "award-amount" gifts that were booked on
reimbursable grant pledges, then re-derives the affected pledges so their
`paid`, `status`, `stage`, `written_pledge`, and `win_probability` reflect the
archived lump being gone.

Reimbursable grants (a pledge whose `pledge_allocations.conditional =
'reimbursable'`) are **pledges** — the funder reimburses real expenses over time,
so each real QuickBooks / Stripe check belongs as its own 1:1 payment gift.
Historically some were booked instead with a single gift for the FULL award
amount. That placeholder is not real money (no QB / Stripe / Donorbox evidence),
yet it makes the pledge read fully paid (`status = 'cash_in'`) and carries a
phantom `quickbooks_tie_status = 'missing'`.

## Why it is safe

Detection is deliberately conservative — a gift is archived only when ALL hold:

1. it is still active (`archived_at IS NULL`);
2. its opportunity carries a reimbursable pledge allocation;
3. the pledge has a positive `awarded_amount` and `gift.amount` **exactly**
   equals it (the award-lump signature);
4. it is the **sole active gift** on that pledge (not one of several real
   reimbursement checks);
5. it has **no settlement evidence anywhere** — no `payment_applications` ledger
   row (QB / Stripe / Donorbox), no legacy `final_amount_qb_staged_payment_id` /
   `final_amount_stripe_charge_id` pointer, no `staged_payments` link
   (matched / created / group_reconciled), no `stripe_staged_charges` link
   (matched / created);
6. it is not in a match / overpay relationship (neither points at another gift
   via `gift_being_matched_id` / `overpay_of_gift_id`, nor is pointed at by one).

Real reimbursement checks always carry settlement evidence (guard 5) or share
the pledge with other gifts (guard 4), so they are left untouched.

- **Non-destructive** — soft-delete only (invariant #6); archived gifts leave
  list views and are excluded from financial / pledge paid-amount totals, but
  the row and its allocations survive and can be un-archived.
- **Idempotent** — once archived, `archived_at` is set, so guard 1 excludes the
  gift on re-run: the archive UPDATE touches 0 rows and the re-derivation runs
  over an empty set.
- **Re-derivation mirrors the app** — a raw-SQL data change does not run the
  server's `applyDerivedOppFields`, so the file recomputes `paid` (SUM of
  non-archived gifts), `status`, `stage`, `written_pledge`, and
  `win_probability` with the exact same rules, updating only rows whose derived
  values actually change.

## Pre-check / spot-verify (read-only, run against prod first)

The migration itself emits a **read-only PREVIEW** (section 0) that lists every
candidate gift with its amount, pledge, and donor before it archives anything —
so you can eyeball known reimbursable grantors (PELSB / DEED / Early Milestones)
in the `NOTICE` output. To preview the count on its own first:

```sql
SELECT count(*)
FROM gifts_and_payments g
JOIN opportunities_and_pledges o ON o.id = g.opportunity_id
WHERE g.archived_at IS NULL
  AND EXISTS (SELECT 1 FROM pledge_allocations pa
              WHERE pa.pledge_or_opportunity_id = o.id
                AND pa.conditional = 'reimbursable')
  AND o.awarded_amount IS NOT NULL AND o.awarded_amount > 0
  AND g.amount = o.awarded_amount
  AND (SELECT count(*) FROM gifts_and_payments g2
       WHERE g2.opportunity_id = o.id AND g2.archived_at IS NULL) = 1
  AND NOT EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.gift_id = g.id)
  AND g.final_amount_qb_staged_payment_id IS NULL
  AND g.final_amount_stripe_charge_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM staged_payments sp
                  WHERE sp.matched_gift_id = g.id OR sp.created_gift_id = g.id
                     OR sp.group_reconciled_gift_id = g.id)
  AND NOT EXISTS (SELECT 1 FROM stripe_staged_charges c
                  WHERE c.matched_gift_id = g.id OR c.created_gift_id = g.id)
  AND g.gift_being_matched_id IS NULL AND g.overpay_of_gift_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM gifts_and_payments g3
                  WHERE g3.gift_being_matched_id = g.id OR g3.overpay_of_gift_id = g.id);
```

If any candidate looks wrong (e.g. a real single-check reimbursement that
happens to equal the award), do NOT apply — tighten the guard first.

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0101_archive_reimbursable_placeholder_gifts.sql
```

The file runs in ONE transaction (`-1`). It emits `RAISE NOTICE` lines: the
PREVIEW list, then `archived N placeholder award gift(s); remaining candidates =
0`. If `remaining candidates` is not 0, investigate before assuming success.

## Post-check

```sql
-- Affected pledges should no longer read cash_in purely from the archived lump.
SELECT id, name, status, paid, awarded_amount, written_pledge, win_probability
FROM opportunities_and_pledges
WHERE id IN (
  SELECT DISTINCT opportunity_id FROM gifts_and_payments
  WHERE archived_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM pledge_allocations pa
                WHERE pa.pledge_or_opportunity_id = gifts_and_payments.opportunity_id
                  AND pa.conditional = 'reimbursable')
);
```

## Rollback

Non-destructive. To reverse a specific gift, clear its `archived_at`
(`UPDATE gifts_and_payments SET archived_at = NULL WHERE id = '<gift_id>'`) and
re-run the app's derivation for its pledge (any PATCH touching the opportunity,
or re-run the section-3 re-derivation scoped to that opportunity).
