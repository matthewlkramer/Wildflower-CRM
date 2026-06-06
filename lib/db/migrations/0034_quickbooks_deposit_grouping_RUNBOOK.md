# 0034 — QuickBooks deposit grouping (staged-payments reconciler)

## What this adds

Manual **deposit grouping** in the staged-payments reconciler: a fundraiser can
select several QuickBooks staged payments that share ONE underlying bank Deposit,
group them into a "deposit unit", and reconcile the group as a whole to ONE
existing CRM gift (multi-allocation). The match is gated on the combined member
total ≈ gift amount within the same fee-band tolerance used for single matches.
Reversible (ungroup / unmatch) and idempotent under re-sync.

Two columns + their indexes on `staged_payments`:

- `qb_deposit_id` (text, indexed) — the bank Deposit a staged row belongs to.
  Only rows sharing this value may be grouped; rows with NULL are never offered
  for grouping.
- `group_reconciled_gift_id` (text, FK → `gifts_and_payments` ON DELETE SET
  NULL, indexed) — set on EVERY member of a grouped reconciliation. The
  representative member (lowest id) ALSO carries `matched_gift_id` = the same
  gift, so the gift still shows as "linked" through the existing single-link
  path; other members resolve to the gift via this column alone. Cleared for the
  whole group on revert.

## How to apply

Code/schema ship via the normal **Publish** flow. Publish applies column / index
/ FK diffs but never `CREATE EXTENSION`; this migration only adds plain columns,
indexes, and one FK, so Publish covers prod automatically.

If you want to pre-apply to prod by hand (e.g. before Publish), the agent cannot
write prod — a human runs the reviewed, idempotent file:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0034_quickbooks_deposit_grouping.sql
```

It is additive and safe to re-run: existing rows get NULL for both columns, which
is exactly "ungrouped". No data is rewritten.

## Caveats

- **Historical rows won't get `qb_deposit_id` from an incremental re-sync.** The
  bank Deposit that records a Payment/SalesReceipt is pulled by the same
  `LastUpdatedTime` watermark as everything else, so deposits older than the
  watermark are absent from incremental pulls and their `qb_deposit_id` stays
  NULL. Grouping is simply not offered for those rows (no deposit id). To enrich
  the back-catalog, do a clean re-ingestion (wipe `staged_payments` + reset the
  per-connection watermark — see `0024_quickbooks_clean_reingest_RUNBOOK.md`),
  which re-pulls deposits and folds the deposit id onto each line.
- **No auto-grouping, no new-gift mint, no QB writeback, no cross-deposit
  grouping** — grouping is entirely operator-driven and stays within one
  deposit; matching a group only links to a *pre-existing* gift.
