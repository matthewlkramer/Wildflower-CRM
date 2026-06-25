---
name: Airtable→schools sync & school-recipient FK
description: School recipient is allocation-level only; the scheduled school sync upserts before stale-detection, so an error status can hide already-synced data.
---

# Airtable→schools sync gotchas

**School recipient lives ONLY on `gift_allocations.school_recipient_id`.** There is
NO `gifts_and_payments.school_recipient_id` column (school scope is allocation-level
per the header+allocations money model). Any "which schools are referenced / is this
school safe to delete" query MUST count through `gift_allocations`. A stale query in
the daily school sync referenced the phantom gifts column and crashed every run.

**Why:** schools are recipients of *allocations*, not whole gifts; a single gift can
split across multiple school recipients.

**How to apply:** when touching school references (stale detection, merge inventory,
delete guards), go through `gift_allocations.school_recipient_id` only.

## Operational gotcha: error status ≠ data not synced

The `schoolSync` worker commits the **upsert in its own transaction first**, then runs
stale-detection separately. So if stale-detection throws, the schools were still
upserted but `school_sync_state.last_status` flips to `error` and the process exits
non-zero — the run looks failed while the data is actually current. Check
`schools_fetched/upserted` in the run log before concluding the sync did nothing.

Token: the Airtable client prefers `AIRTABLE_API_TOKEN`, falling back to the legacy
`AIRTABLE_TOKEN` (the explicit new secret must win, or a stale legacy token shadows it).
