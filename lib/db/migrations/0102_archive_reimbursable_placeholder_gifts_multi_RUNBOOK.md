# Runbook — 0102 Archive phantom award-amount gifts on reimbursable pledges that ALSO carry real checks

## What this does

DATA-only, non-destructive cleanup. It **archives** (soft-delete, `archived_at`;
never a hard `DELETE`) the single phantom "award-amount" placeholder gift on a
reimbursable pledge **that also already carries one or more real reimbursement
checks**, then re-derives the affected pledges so their `paid`, `status`,
`stage`, `written_pledge`, and `win_probability` reflect the archived lump being
gone.

This is the case migration **0101 deliberately skipped**. 0101 only archived the
placeholder when it was the **sole** active gift on the pledge. This file handles
the messier, more dangerous case: a reimbursable pledge with BOTH a full-award
placeholder (no evidence) AND real checks. There the placeholder **double-counts**
— the pledge's derived `paid` is the full award PLUS the real checks, so it reads
over-/fully-paid (`cash_in`) and the lump carries a phantom
`quickbooks_tie_status = 'missing'`.

Reimbursable grants (a pledge whose `pledge_allocations.conditional =
'reimbursable'`) are **pledges** — the funder reimburses real expenses over time,
so each real QuickBooks / Stripe check belongs as its own 1:1 payment gift. The
full-award placeholder is not real money; the real checks are.

## Why it is safe

Detection is deliberately conservative — a gift is archived only when ALL hold:

1. it is still active (`archived_at IS NULL`);
2. its opportunity carries a reimbursable pledge allocation;
3. the pledge has a positive `awarded_amount` and `gift.amount` **exactly**
   equals it (the award-lump signature);
4. it has **no settlement evidence anywhere** — no `payment_applications` ledger
   row (QB / Stripe / Donorbox), no legacy `final_amount_qb_staged_payment_id` /
   `final_amount_stripe_charge_id` pointer, no `staged_payments` link
   (matched / created / group_reconciled), no `stripe_staged_charges` link
   (matched / created);
5. it is not in a match / overpay relationship (neither points at another gift
   via `gift_being_matched_id` / `overpay_of_gift_id`, nor is pointed at by one);
6. **the multi-gift discriminator** — the pledge has at least one OTHER active
   gift that DOES carry settlement evidence (a real reimbursement check booked
   alongside the lump); AND
7. **the ambiguity guard** — the pledge has **exactly one** phantom candidate. If
   two or more award-amount, no-evidence gifts sit on the same pledge we cannot
   tell which is the phantom, so we archive NONE and leave them for manual review.

Guards 1-5 are identical to 0101's. Guards 6-7 replace 0101's "sole active gift"
requirement: instead of demanding the lump be alone, we require it to sit
alongside an evidence-backed real check and be the unambiguous phantom.

- **Non-destructive** — soft-delete only (invariant #6); archived gifts leave
  list views and are excluded from financial / pledge paid-amount totals, but
  the row and its allocations survive and can be un-archived. The real checks are
  never touched.
- **Idempotent** — once archived, `archived_at` is set, so guard 1 excludes the
  gift on re-run: the archive UPDATE touches 0 rows and the re-derivation runs
  over an empty set.
- **Re-derivation mirrors the app** — a raw-SQL data change does not run the
  server's `applyDerivedOppFields`, so the file recomputes `paid` (SUM of
  non-archived gifts — now just the real checks), `status`, `stage`,
  `written_pledge`, and `win_probability` with the exact same rules, updating
  only rows whose derived values actually change.

## Pre-check / spot-verify (read-only, run against prod first)

The migration itself emits a **read-only PREVIEW** (section 0) that, for every
pledge, lists the phantom gift it will archive AND — indented beneath it — each
real sibling check it will preserve, with amounts and donor. Eyeball known
reimbursable grantors (PELSB / DEED / Early Milestones) in the `NOTICE` output.
To preview the count on its own first:

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
                  WHERE g3.gift_being_matched_id = g.id OR g3.overpay_of_gift_id = g.id)
  -- a real evidence-backed sibling check exists
  AND EXISTS (SELECT 1 FROM gifts_and_payments g2
              WHERE g2.opportunity_id = o.id AND g2.id <> g.id AND g2.archived_at IS NULL
                AND (EXISTS (SELECT 1 FROM payment_applications pa WHERE pa.gift_id = g2.id)
                     OR g2.final_amount_qb_staged_payment_id IS NOT NULL
                     OR g2.final_amount_stripe_charge_id IS NOT NULL
                     OR EXISTS (SELECT 1 FROM staged_payments sp
                                WHERE sp.matched_gift_id = g2.id OR sp.created_gift_id = g2.id
                                   OR sp.group_reconciled_gift_id = g2.id)
                     OR EXISTS (SELECT 1 FROM stripe_staged_charges sc
                                WHERE sc.matched_gift_id = g2.id OR sc.created_gift_id = g2.id)));
```

> Note: the count above omits the exactly-one-phantom-candidate guard for
> brevity, so it may over-count when a pledge has two ambiguous phantoms. The
> migration's own PREVIEW applies that guard, so trust its `NOTICE` list for the
> exact set to be archived.

If any candidate looks wrong (e.g. a real full-amount check that happens to equal
the award and simply lacks ledger evidence yet), do NOT apply — investigate and
tighten the guard first.

## Apply

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0102_archive_reimbursable_placeholder_gifts_multi.sql
```

The file runs in ONE transaction (`-1`). It emits `RAISE NOTICE` lines: the
PREVIEW (phantom + preserved checks per pledge), then `archived N phantom award
gift(s); remaining candidates = 0`. If `remaining candidates` is not 0,
investigate before assuming success.

## Post-check

```sql
-- Affected pledges should no longer be inflated by the archived lump; paid now
-- reflects only the real checks.
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
