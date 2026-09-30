# 0267 — Conference research and speaker review release

This release adds cited date proposals, public agenda/speaker research, a durable
research queue, speaker review, and protected conference-type merges. This is a
**post-deploy production procedure for a human administrator**. Do not execute it
as part of code review or in a deployment build/startup hook.

## Prerequisites

1. Review and publish the application through Replit's Publish flow. Confirm the
   production schema diff is additive (event/research columns, speaker-proposal
   table, indexes, and the expanded attendance source constraint); do not select
   a data-overwrite option. The numbered SQL file is the reviewable schema
   reference, not a command to apply to the managed production database.
2. Confirm the running API-server process is continuously scheduled. Its
   conference worker runs at startup and every five minutes; a sleeping or
   stopped server cannot process queued research or enqueue the 21-day and
   2-day windows. A request remains in the database and resumes when it runs.
3. Confirm the server-side OpenAI Responses integration can extract facts from
   fetched public pages. The Replit proxy did not complete the native
   `web_search` tool in development, so the server uses bounded public-web
   search/fetch and source-grounded extraction instead. It can also read
   public HTTPS PDF agendas from qualifying organizer search results or links
   on fetched official pages. PDFs must have a valid PDF response type and
   signature, fit within 3 MB and 24 pages, and provide extractable text;
   the first 10,000 characters are available for cited extraction. Scanned,
   malformed, private, or inaccessible PDFs remain visible delayed-retry work,
   not inferred findings. Network access to public search and organizer sites
   is also required. A credential alone is **not
   proof** that research works; test a known official page and check run errors.
   Missing credentials or inaccessible sources leave visible retryable work;
   uncited or unsupported findings are rejected. Never put a credential in the
   browser, a runbook command, or a conference source field.

## Before the production backfill

In the published app, open **Engagement → Conferences** and confirm a known
event and its existing attendance still display. Test one public research run
for a known event. Verify its source URLs and evidence link to public official
event/organizer pages, or stop if public search or extraction is unavailable.
Research does not grant access to private attendee lists or paywalled material.

Use **Prepare retroactive research → Include completed historical events →
Queue backfill** as an authorized admin. Keep "Also research dates already
known" off unless those dates specifically need review. The API alternative for
an authenticated admin is `POST /api/admin/conference-research/backfill` with
`{"includeCompletedEvents":true,"includeKnownDates":false}`. Do not put
authentication material in this document. The result reports selected events
and queued date/agenda runs. Repeating the action is safe: each event/kind/window
has a unique key, so the same run is reused. Existing confirmed dates are
unchanged; missing dates are researched first and displayed as proposals.
Human confirmation of a cited date proposal unlocks that event's agenda run.

## Check and recover

In each event, inspect run status, errors, sources, and pending speaker
proposals. Confirm proposed dates only after checking the cited page. Review
ambiguous speaker matches rather than attaching by similar names; adding a new
person is a reviewer action. "Retry" requeues a failed run after fixing its
error. The nightly/daily catch-up sweep is idempotent; a running API process is
required for it. It does not automatically research historical events outside
the explicit backfill.

For read-only SQL checks, compare event coverage and job states:

```sql
SELECT count(*) AS events, count(*) FILTER (WHERE start_date IS NULL) AS dates_unknown
FROM conference_events;

SELECT kind, status, count(*) AS runs
FROM conference_research_requests
GROUP BY kind, status ORDER BY kind, status;

SELECT status, count(*) AS proposals
FROM conference_speaker_proposals
GROUP BY status ORDER BY status;
```

Do not run the numbered DDL file or any backfill against production before
publishing and explicitly starting this administrator procedure.