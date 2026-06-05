---
name: QuickBooks clean re-ingestion
description: How to force a clean QB re-pull, why existing gifts survive, and why the staged queue needs pagination + payments-first sort.
---

# QuickBooks clean re-ingestion

The incremental, watermark-based QB sync NEVER re-pulls its back-catalog. Rows
staged before a sync-logic change (e.g. lump bank deposits staged before per-line
splitting / LinkedTxn dedupe / scoring existed) sit forever and bury real
per-donor payments.

**To force a full clean re-ingest:** wipe `staged_payments` + reset
`quickbooks_connections.sync_watermark` (and last_synced_at/last_error) to NULL,
then "Sync now". Null watermark ⇒ `since=null` ⇒ full history pull.

**Do NOT delete the auto-created gifts.** QB-minted gifts carry `gift_allocations`;
deleting them loses real ledger data. The re-pull RECONCILES (links via
`matched_gift_id`) to existing gifts by identical donor/amount/date instead of
minting duplicates — the matcher only mints when `giftCandidateCount===0`.
**Why:** preserves the ledger and avoids dupes without a destructive delete.
**Residual risk:** gifts have no natural-key uniqueness, so a missed donor match
(or differing amount/date) can still mint a duplicate — verify post-sync with a
donor+amount+date duplicate sweep.

**Queue visibility:** the staged-payments list is capped + paginated. Two things
keep payments from being buried under deposits: a server **payments-first sort**
(`CASE WHEN qb_entity_type='deposit' THEN 1 ELSE 0`, then date desc) and **UI
pagination** (the spec/list endpoint already supports `Limit`/`Page`/`total`; the
page just has to pass `page` and clamp it when the queue shrinks).
