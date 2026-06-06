# Runbook — 0032: auto-reconcile fee-only, single-candidate staged payments

A set of high-confidence (donor) QuickBooks rows sit in **Needs review** because
the OLD matcher only auto-reconciled when the donor had exactly one **exact-amount**
gift in the window. These rows have **no exact-amount gift** but **exactly one
fee-band gift** — a CRM gift whose gross is just above the QB net deposit, the
difference being a processor fee. The "only difference is the fee", so the gift to
reconcile against is unambiguous.

Verified against production 2026-06-06 — of 28 pending rows at `match_score >= 95`:

| exact-amount gifts | fee-band gifts | rows | disposition                         |
| ------------------ | -------------- | ---- | ----------------------------------- |
| 0                  | 1              | 18   | **reconciled by 0032** (this file)  |
| 0                  | 2              | 4    | stay in Needs review (ambiguous)    |
| 2                  | 2              | 6    | stay in Needs review (ambiguous)    |

## What 0032 does

For each qualifying row it sets `matched_gift_id` to the single fee-band gift and
moves the row to the **Auto-matched** queue (`status='approved'`,
`auto_applied=true`, `match_confirmed_at` left NULL) for optional human review.

The gift row is **not** modified — it already holds the gross amount; the fee is
the implicit difference from the QB net deposit (this is a reconcile, not a mint,
so there is no double-count).

This is the one-time catch-up for existing rows. The companion code change
(`reconcileTarget()` in `quickbooksMatch.ts`) makes future ingests do the same
thing automatically, so these rows will not re-accumulate.

## Safety

- **Scope guard** — only rows still `status='pending'`, unlinked
  (`matched_gift_id`/`created_gift_id` NULL), `match_score >= 95`.
- **Single candidate only** — a staged row qualifies only when it has exactly one
  band gift and zero exact-amount gifts; gifts already linked to another staged
  payment are excluded.
- **No double-link** — a gift that is the single candidate for two different
  staged rows is skipped (respects the partial-unique index on `matched_gift_id`);
  those rows stay in Needs review.
- **Idempotent** — re-running is a no-op: reconciled rows are `approved`, and their
  gift is then "already linked" so it is excluded on the next pass.

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0032_quickbooks_feeband_autoreconcile.sql
```

To also sweep the few score 90–94 rows, change `>= 95` to `>= 90` in the SQL
before applying.

## Verification

```sql
SELECT count(*) AS moved
  FROM staged_payments
 WHERE status = 'approved' AND auto_applied
   AND match_confirmed_at IS NULL
   AND match_status = 'matched'
   AND matched_gift_id IS NOT NULL
   AND updated_at >= now() - interval '5 minutes';
-- expect ~18
```

Spot-check that each moved row's gift gross is within the fee band of the QB net:

```sql
SELECT sp.id, sp.amount AS qb_net, g.amount AS gift_gross,
       round((g.amount - sp.amount::numeric), 2)                    AS fee,
       round((g.amount - sp.amount::numeric) / sp.amount::numeric * 100, 2) AS fee_pct
  FROM staged_payments sp
  JOIN gifts_and_payments g ON g.id = sp.matched_gift_id
 WHERE sp.status = 'approved' AND sp.auto_applied
   AND sp.match_confirmed_at IS NULL
   AND sp.updated_at >= now() - interval '5 minutes'
 ORDER BY fee_pct DESC;
-- every fee_pct should be small (0–10%); gift_gross >= qb_net
```
