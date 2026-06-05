---
name: QuickBooks deposit-coding preserve-on-conflict
description: Why the staged-payment upsert must not overwrite stored line coding with an empty incremental pull, and the watermark coupling that backs it.
---

Deposit-derived coding (account names / classes / memo) is folded onto a bare
Payment/SalesReceipt from the **deposit line** that re-records it. Deposits are
pulled by the same `LastUpdatedTime` watermark as everything else, and QBO's
query language CANNOT filter deposits by nested `Line.LinkedTxn.TxnId`, so an
older deposit cannot be re-fetched by payment id.

**Rule:** the staged-payment upsert (`buildStagedLineUpsert` in
`quickbooksSync.ts`) must be preserve-on-conflict for line coding — keep the
stored value whenever the incoming pull is empty (arrays:
`CASE WHEN cardinality(excluded.col) > 0 THEN excluded.col ELSE stored END`;
memo: `coalesce(nullif(excluded.line_description,''), stored)`). A non-empty pull
still wins (don't over-preserve / freeze first-seen coding).

**Why:** on an incremental re-sync an *edited* Payment gets re-pulled while its
linked deposit is older than the watermark and therefore absent from the pull,
so the freshly-pulled coding arrays are empty. A blind overwrite wiped good
coding captured on the prior full sync — a real data-loss regression for
uninvoiced payments whose only coding is deposit-derived.

**How to apply:**
- Never revert the ON CONFLICT DO UPDATE SET back to assigning the raw pulled
  values for `line_item_names` / `line_account_names` / `line_classes` /
  `line_description`.
- INSERT path is safe (a brand-new payment can't have a deposit older than the
  watermark), so the fix lives only in the conflict/update path.
- Any `staged_payments` reseed (DELETE / re-ingest) MUST also reset
  `quickbooks_connections.sync_watermark` to NULL so the next pull is full and
  re-seeds coding — a "first-seen" INSERT under an advanced watermark can miss an
  out-of-window deposit's coding. Runbook `lib/db/migrations/0024_*` couples both.
- Coverage is structural: `quickbooks-staged-upsert.test.ts` asserts the compiled
  `.toSQL()` of the real builder (suite is DB-mocked, so no live-DB harness).
