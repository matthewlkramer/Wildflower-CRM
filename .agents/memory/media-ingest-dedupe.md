---
name: media-mention GDELT ingestion dedupe
description: Media mention advisory-lock dedupe, relevance filtering, tombstones, and the no-AI-summary policy.
---

# media_mentions GDELT ingestion

The automated press-coverage job (GDELT DOC 2.0, free/no-key) dedupes by raw
URL, tracking-free canonical URL, and same-day normalized headline.

## Rule: dedupe stays transaction-serialized

The importer takes sorted transaction-scoped PostgreSQL advisory locks for the
canonical URL and same-day headline fingerprint before selecting and updating
or inserting. The URL column also retains its unique index. Existing entity ID
arrays are merged without duplicates.

**Why:** the daily scheduler, manual ingestion, and multiple server instances
can overlap. Without the advisory locks, different raw URL variants could pass
the lookup concurrently and create duplicate rows or lose link merges.

**How to apply:** any change to the ingestion upsert must preserve both advisory
locks and the unique URL index. The manual script must call
`runMediaIngestIfDue({force:true})` (shares the global advisory lock + state table),
never `ingestMediaMentions()` directly — calling the inner fn bypasses the lock.

## Rule: relevance is reversible and pinning wins

Person results are scored from name, current affiliation, and location signals.
Rows below `MEDIA_RELEVANCE_THRESHOLD` (default `0.4`) are stored with
`is_filtered = true`; they are not deleted. `includeFiltered=true` reveals them.
Pinned rows always pass API/UI read filters, and the historical backfill never
changes a pinned row's stored `is_filtered` value. For a row linked to several
targets, retain the maximum score.

## Rule: "deleting" a media mention is a soft-delete (dismissed tombstone)

`media_mentions.dismissed` (boolean) is the soft-delete flag. The DELETE endpoint
UPDATEs `dismissed = true` instead of removing the row; the list endpoint always
filters `dismissed = false`; the ingest upsert's `DO UPDATE ... WHERE` guard adds
checks `dismissed = false` before any link/score update so a dismissed URL is
never re-linked or un-dismissed.

**Why:** a hard DELETE left the url free, so the next GDELT sweep re-inserted the
same article (dedupe is by url) and the mention came back. Keeping the row as a
url tombstone is the only way the dismissal survives a sync.

**How to apply:** dismissal is GLOBAL per article (per url) — it hides the mention
for every linked entity, by design. Keep the guard inside the advisory-locked
transaction. No admin trash/undo UI yet.

## Rule: do NOT AI-summarize auto-ingested headlines

Store the GDELT headline verbatim in `title`; leave `aiSummary` null for `source='gdelt'`.

**Why:** this is a donor CRM. Summarizing a bare headline risks fabricating claims
about a real donor. Factual headline only.
