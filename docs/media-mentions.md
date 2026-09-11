---
status: current-status
last_verified: 2026-09-11
---

# Media mentions

Media coverage is stored once in `media_mentions` and linked to any number of
people or organizations through ID arrays. GDELT ingestion retains the factual
headline and does not generate an AI summary.

## Identity and deduplication

Ingestion derives a tracking-free `canonical_url` by removing fragments,
normalizing the host, sorting query parameters, and dropping common campaign
parameters. For Yahoo, MSN, AOL, and similar syndication wrappers it uses an
original publisher URL found in supplied metadata or canonical body markup
when available; it never fetches a second page to resolve the URL.

The write path takes transaction-scoped advisory locks and reuses a row when
the raw URL, canonical URL, or same-day normalized headline fingerprint
matches. Entity links are merged without duplicates. A dismissed row remains a
global tombstone and is never resurrected.

## Relevance

Person hits receive a deterministic score from 0 to 1. Strong signals are the
person's full name, current organization affiliations, and city/region context
in the headline or descriptive text. Configured disqualifying terms reduce the
score. Organization targets retain score 1 because their GDELT search is an
exact quoted organization name.

- `MEDIA_RELEVANCE_THRESHOLD` sets the cutoff; invalid or absent values use
  `0.4`.
- `MEDIA_RELEVANCE_DISQUALIFYING_TERMS` is an optional comma-separated
  replacement for the default terms.

One media row can link to several entities, so the stored score is the maximum
score across evaluated targets. This keeps an article visible everywhere when
it is a strong match for at least one linked CRM record.

`GET /api/media-mentions` excludes `is_filtered = true` by default. Passing
`includeFiltered=true` returns them. Pinned rows always pass the read filter,
even when their stored classification remains filtered. The API exposes that
classification as `filtered` so the activity feed can hide it by default and
offer an explicit “show all” disclosure.

## Historical backfill

The backfill is a standalone command, not an application startup task. It
processes 100 unscored rows per batch and can resume safely. It updates the
canonical URL and relevance score, but never changes `is_filtered` for a
pinned row. Follow
[`0244_media_relevance_filtering_RUNBOOK.md`](../lib/db/migrations/0244_media_relevance_filtering_RUNBOOK.md)
and obtain human approval before production.
