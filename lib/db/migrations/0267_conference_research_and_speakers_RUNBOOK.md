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
2. Configure a **separate Replit Scheduled Deployment** for conference
   research (below). The production API server does not start the conference
   interval; Autoscale traffic must not become a second scheduler. Pending
   requests remain in the database between runs. Local development still runs
   the five-minute interval.
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

## Scheduled Deployment (create only after schema publish)

Use Replit Publishing → **Scheduled** to create a separate scheduled job for
this project. It is a one-shot process, not a web service:

- Cron: `15 */6 * * *` (00:15, 06:15, 12:15, 18:15).
- Time zone: **America/Chicago**. Confirm the UI's displayed time zone and
  next-run times, especially across daylight-saving changes; do not silently
  treat a browser's fixed UTC offset as an IANA time zone. Due-window dates
  retain the existing UTC calendar-day calculation.
- Build command (from workspace root):
  `pnpm --filter @workspace/api-server run build`
- Run command (from workspace root):
  `pnpm --filter @workspace/api-server run conference-research:once`
  (executes `node --enable-source-maps ./dist/conference-research-once.mjs`
  in the API package, never the HTTP entrypoint).
- Recommended job timeout: **20 minutes**. The CLI stops starting new jobs
  after 12 minutes or 20 attempted jobs; its parent process terminates a
  still-running child at 15 minutes and exits nonzero, leaving any claimed
  request for lease recovery on the next run. A reached soft cap leaves
  remaining queue work for the next scheduled run.
- Machine: use the Scheduled Deployment's default machine setting; no
  documented minimum size is known. Do not configure it as a web Autoscale
  deployment solely to get an interval.
- Production environment must include the managed production `DATABASE_URL`,
  `AI_INTEGRATIONS_OPENAI_API_KEY`, and
  `AI_INTEGRATIONS_OPENAI_BASE_URL` (or the supported direct OpenAI fallback
  `OPENAI_API_KEY` and `OPENAI_BASE_URL`). Do not paste their values into
  commands. Public outbound HTTPS/DNS access to Bing/Google search and
  qualifying organizer HTML/PDF URLs is required; there is no search API key.

The job checks for the complete 0267 schema before queue writes and exits
nonzero with `schema_not_ready` if Publish has not applied it. A session-level
advisory lock skips an overlapping invocation; unique event/kind/window keys
and row leases with skip-locked claims guard individual jobs. It logs
aggregate counts only; enqueue failures, newly invalidated requests,
failed/retryable jobs, exhausted stale leases, and hard timeouts produce a
nonzero exit for alerts. A no-work or lock-skipped run exits zero.

After the schema is published and the Scheduled Deployment is configured,
use **Run now** once. Confirm the run completes within the timeout, has a
zero exit when no work is due (or inspect reported failure counts if nonzero),
and that the event/run UI shows cited public-source evidence for any processed
work. Check the production database and OpenAI/outbound configuration if the
job reports `schema_not_ready` or `initialization_or_job_error`; never run the
numbered DDL file as a repair.

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
error. The six-hour scheduled catch-up sweep is idempotent; a successful
Scheduled Deployment run is required for it. It does not automatically research
historical events outside the explicit backfill.

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