---
name: media-mention GDELT ingestion dedupe
description: Why media_mentions dedupe must stay a DB-atomic upsert, and the no-AI-summary policy for auto items.
---

# media_mentions GDELT ingestion

The automated press-coverage job (GDELT DOC 2.0, free/no-key) dedupes by `url`.

## Rule: dedupe stays DB-atomic — never read-then-write
`media_mentions.url` has a UNIQUE index. The importer uses
`INSERT ... ON CONFLICT (url) DO UPDATE` that `array_append`s the entity id, with
a WHERE guard so an already-linked id is a no-op. `RETURNING (xmax = 0)`
distinguishes created vs linked.

**Why:** the daily scheduler and the manual `ingest:media` script can run
concurrently (and multiple server instances exist). A `SELECT`-then-`UPDATE`/`INSERT`
upsert loses entity-link merges (last-writer-wins on the array) and can create
duplicate rows. A code review failed the feature specifically on this.

**How to apply:** any change to the ingestion upsert must preserve the single-statement
ON CONFLICT form and the unique index. The manual script must call
`runMediaIngestIfDue({force:true})` (shares the global advisory lock + state table),
never `ingestMediaMentions()` directly — calling the inner fn bypasses the lock.

## Rule: do NOT AI-summarize auto-ingested headlines
Store the GDELT headline verbatim in `title`; leave `aiSummary` null for `source='gdelt'`.

**Why:** this is a donor CRM. Summarizing a bare headline risks fabricating claims
about a real donor. Factual headline only.
