# Runbook — 0042: clear donor-less "amount + date" suggested matches

## Background

The QuickBooks reconciliation matcher used to guess a donor purely from
**amount + date**: when a staged payment had no donor evidence (no email, payer
name, or memo hit), it adopted the donor of the single existing CRM gift with the
same dollar amount within ±10 days. This produced misleading attributions — e.g.
a $25,000 loan repayment from "Flor do Loto" showed a donor of "Amy Gips" only
because an unrelated $25,000 gift from Amy sat near that date.

The matcher no longer does this (the donor-less amount+date fallback was removed),
so newly-scored rows can never carry `match_method = 'amount_date'` again. This
backfill clears the wrong donor off the rows the old fallback already stamped.

## What 0042 does

For every staged payment whose `match_method = 'amount_date'`, it nulls the
suggested donor FKs (`organization_id`, `individual_giver_person_id`,
`household_id`), nulls `match_score` and `match_method`, and sets `match_status`
back to `unmatched`. Those rows return to the queue as plain "unmatched" for a
human to resolve from real evidence.

The `amount_date` enum value is **kept** (deprecated, unused) per the project's
"retain deprecated, don't drop" convention — only the row data is cleared.

## Guards (only touches rows nobody has resolved)

- `match_method = 'amount_date'` — only the bad guesses.
- `status = 'pending'` — never reopens an approved / rejected / excluded decision.
- `match_confirmed_at IS NULL` — never overrides a human-confirmed match.
- `matched_gift_id`, `created_gift_id`, `group_reconciled_gift_id` all `NULL` —
  never unlinks a row already tied to a ledger gift. (`amount_date` was a
  suggested-tier hint, never auto-applied, so unlinked is the expected state.)

## Ledger impact

None. `amount_date` was never written to the gifts ledger (suggested-tier only),
so there is nothing to mint, void, or unwind.

## Apply

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0042_quickbooks_clear_amount_date_suggestions.sql
```

Idempotent: after the first apply no pending/unconfirmed/unlinked row carries
`match_method = 'amount_date'`, so re-running is a no-op. Production must be
applied by a human — the agent cannot write to prod.

## Verification

```sql
-- Expect 0 after apply (no pending/unconfirmed/unlinked amount_date rows remain;
-- any remaining are human-confirmed or already ledger-linked and intentionally
-- left alone).
SELECT count(*)
  FROM staged_payments
 WHERE match_method = 'amount_date'
   AND status = 'pending'
   AND match_confirmed_at IS NULL
   AND matched_gift_id IS NULL
   AND created_gift_id IS NULL
   AND group_reconciled_gift_id IS NULL;
```
