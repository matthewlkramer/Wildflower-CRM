# 0037 — QuickBooks split staged payment (staged-payments reconciler)

## What this adds

Manual **split reconciliation** in the staged-payments reconciler: a fundraiser
can take ONE QuickBooks staged payment (typically a Stripe payout that nets fees
and deposits a lump sum) and reconcile it across TWO OR MORE pre-existing CRM
gifts. Each link carries that gift's own gross amount; **no new gift is minted**
and QuickBooks is never written back. The match is gated on the gifts' combined
gross total sitting in the same fee-band tolerance used elsewhere — here the
staged (net) amount plays the gift role and the summed gross the combined role
(`sum >= staged - 0.01 && sum <= staged * 1.1 + 1`). Reversible as a whole
(unsplit returns the row to review and deletes every split link; the gifts are
untouched).

This is the inverse of deposit grouping (0034): grouping is many staged rows → one
gift; splitting is one staged row → many gifts.

One new child table, `staged_payment_splits`:

- `id` (text, PK)
- `staged_payment_id` (text, FK → `staged_payments` ON DELETE CASCADE, indexed) —
  the split parent. Split membership is exactly the rows sharing this value.
- `gift_id` (text, FK → `gifts_and_payments` ON DELETE RESTRICT, **unique**) — the
  pre-existing gift this portion links to. The unique index enforces that a gift
  is split-linked at most once, mirroring the one-staged↔one-gift partial-unique
  indexes on `staged_payments.matched_gift_id` / `created_gift_id`. Combined with
  the split route's cross-link guard, a gift is "taken" once it is matched,
  created, group-reconciled, OR split-linked — never twice.
- `sub_amount` (numeric(14,2)) — the portion attributed to this gift = the gift's
  own gross amount at split time.
- `created_by_user_id` (text, FK → `users` ON DELETE SET NULL) — who split it.
- `created_at` / `updated_at` (timestamp, default now()).

A split staged row carries NONE of `matched_gift_id` / `created_gift_id` /
`group_reconciled_gift_id` and no donor of its own — its resolution lives entirely
in this table.

## How to apply

Code/schema ship via the normal **Publish** flow. Publish applies table / column
/ index / FK diffs but never `CREATE EXTENSION`; this migration only adds a plain
table, indexes, and FKs, so Publish covers prod automatically.

If you want to pre-apply to prod by hand (e.g. before Publish), the agent cannot
write prod — a human runs the reviewed, idempotent file:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0037_quickbooks_split_staged_payment.sql
```

It is additive and safe to re-run: the table is created empty (`CREATE TABLE IF
NOT EXISTS`), FKs are added under stable names guarded by name-prefix probes, and
indexes use `IF NOT EXISTS`. No existing data is rewritten.

## Caveats

- **No auto-splitting, no new-gift mint, no QB writeback** — splitting is entirely
  operator-driven and only ever links to *pre-existing* gifts.
- **Each gift must already carry a single valid donor** (the same Donor-XOR guard
  the single-row and group-reconcile paths use); a gift with no donor is rejected.
- **Split and group are mutually exclusive in the UI** — a deposit group already
  claims the gift rows, so split mode is offered only with a single pending
  payment selected and no active group.
