---
status: current-status
last_verified: 2026-11-11
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

The shared backfill service processes 100 unscored rows per batch and can
resume safely. It is not an application startup task. The standalone command
and the Admin → Integrations “Historical media review” action both call that
same service; only the configured feedback implementation owner can start the
in-app action. A database advisory lock prevents overlapping runs across app
instances.

The review updates the canonical URL and relevance score, but never changes
`is_filtered` for a pinned row and never deletes a media record. Progress is
reported from database counts, so an interrupted run appears as paused and can
be resumed without reprocessing scored rows. Follow
[`0244_media_relevance_filtering_RUNBOOK.md`](../lib/db/migrations/0244_media_relevance_filtering_RUNBOOK.md)
and obtain human approval before production.

## Funder scans

The public funder scan uses the same Media Mentions rows and deduplication.
For active opportunities and on-demand checks it also looks for key investment
and leadership roles on the funder's official staff pages. Unmatched names
appear in the Fundraising Brief as reviewable findings. The source stays
linked to the organization and discovery leaves contact creation to review.
It checks public search results and the funder's site, including linked
newsrooms and grant announcements, and verifies dates on the source page.
A press mention stays linked to the organization. A verified open funding
announcement also contributes a public source to the matching Grant Lead.

Search schedules are derived from CRM records in America/Chicago. Open
opportunities, outstanding pledges, and application or decision dates within
90 days get weekly checks. Positive gift or committed pledge allocations
credited to the current or previous fiscal year get checks every two weeks.
Credit in the two preceding fiscal years gets monthly checks. Staff can queue
a single check for another funder in Fundraising brief → Scan coverage.
A one-time request leaves the cadence rule unchanged.

The worker reevaluates due checks in bounded batches every 15 minutes and
records the last attempt, last complete check, and result for each funder.
Failed or partial recurring checks are eligible to retry after one day.
Scheduled GDELT media ingestion still handles people. The funder worker takes
over scheduled organization checks. DISABLE_FUNDER_SCAN=1 pauses the funder
worker and restores the previous organization search in the media scheduler.
DISABLE_MEDIA_INGEST=1 and DISABLE_SYNC_SCHEDULER=1 also pause the funder worker.
