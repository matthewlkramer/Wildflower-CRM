---
status: runbook
last_verified: 2026-09-30
---

# Conference research through n8n

Production public conference research is scheduled by the existing Wildflower
n8n instance. n8n is an external clock only: WFCRM remains the authority for
due windows, queue state, retry timing, leases, source evidence, speaker
proposals, and review decisions.

## Safety boundary

- n8n stores only a dedicated `CONFERENCE_RESEARCH_N8N_AUTH_TOKEN` bearer
  credential. It never receives the production database URL, OpenAI credential,
  Google tokens, conference attendee data, or research prompts.
- `POST /api/integrations/conference-research/tick` performs one bounded queue
  step. The endpoint is unavailable when the dedicated token is absent and is
  mounted before session-authenticated routes because it uses machine-to-machine
  authentication.
- The request handler owns the production advisory-lock session for the full
  queue step. A concurrent invocation returns `202` with `status: busy` rather
  than stacking another worker.
- Queue claims, event/window uniqueness, retry backoff, and stale-lease recovery
  remain durable database facts. Replaying a request is safe.
- The endpoint returns counts and status only. It does not return URLs, prompts,
  people, evidence, or provider error text.

## n8n workflow

Publish one workflow with these behaviors:

1. Schedule Trigger: every six hours, workflow timezone `America/Chicago`.
2. HTTP Request: `POST https://wfcrm.replit.app/api/integrations/conference-research/tick`
   using a Header Auth credential with `Authorization: Bearer <dedicated token>`.
   Use a three-minute request timeout and two retries with delay.
3. When `alertRequired` is true, stop draining and notify the CRM administrator
   with the returned counts only.
4. When `hasMore` is true, wait 15 seconds and call the endpoint again. Stop
   after 25 calls in one workflow execution and alert if the cap is reached.
5. Finish quietly when `status` is `idle` and `hasMore` is false.

The extra idle call after the last processed job is intentional: one HTTP call
processes at most one job, so the following call proves the queue is drained.
The CRM derives missed date, 21-day, and 2-day windows on every tick, so a late
n8n run catches up without a separate backfill.

## Publish and verification

1. Publish the reviewed WFCRM code and confirm `/api/healthz` is healthy.
2. Generate one high-entropy token and save the same value as the Replit
   deployment secret `CONFERENCE_RESEARCH_N8N_AUTH_TOKEN` and an n8n Header Auth
   credential. Never place it in a workflow node value, title, note, repository,
   log, or chat message.
3. Run the workflow once manually. A healthy empty queue returns `200` with
   `status: idle`, `hasMore: false`, and no alert.
4. Publish the n8n workflow, confirm the six-hour schedule, and inspect the first
   scheduled execution.

This schedule only handles current and future due windows. Retroactive research
remains an explicit administrator backfill from the Conferences screen.

## Rotation and recovery

To rotate the credential, create a new high-entropy value, update the Replit
deployment secret and republish, then update the n8n Header Auth credential and
run one manual proof. A `401` means the two values differ; a `503` means the
Replit deployment secret is absent. Repeated non-2xx responses or
`alertRequired: true` require inspection of CRM queue state and Replit logs;
never copy provider error text into n8n notifications.
