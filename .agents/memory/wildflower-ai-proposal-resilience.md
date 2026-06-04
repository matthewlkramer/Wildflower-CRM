---
name: AI proposal call resilience
description: How the email-intelligence per-proposal Anthropic call must stay resilient to the shared integration proxy's rate limit.
---

# AI proposal call resilience

The per-proposal AI call (`proposeActionsForProposal`) talks to the **shared**
Anthropic integration proxy, which rate-limits aggressively. Under sync fan-out
this produced ~hundreds of permanent `429 RATELIMIT_EXCEEDED` / quota errors
stored in `email_proposals.actions_error` ("AI analysis failed" in the UI).

Two rules any future change to that call path must keep:

1. **Single-call resilience** — wrap the `anthropic.messages.create` call in
   `withRateLimitRetry` (from `@workspace/integrations-anthropic-ai`), which
   reuses the batch helper's `isRateLimitError` detection, backs off
   exponentially, and honors `retry-after`. Set the SDK's `maxRetries: 0` on the
   call so backoff is owned solely by `withRateLimitRetry` — do NOT stack the
   SDK's own retry loop on top (double-backoff).
   **Why:** only retry rate-limit/quota errors; everything else must still fail
   fast and land in `actions_error`.

2. **Global concurrency cap** — route every AI proposal call through the shared
   `aiProposalLimit` (`artifacts/api-server/src/lib/aiConcurrency.ts`,
   `AI_PROPOSAL_CONCURRENCY`, default 2). Both the inline fire-and-forget
   fan-out and the sequential sweeps call `proposeActionsForProposal`, so
   wrapping the call there bounds the inline burst with one limiter.
   **Why:** a sync ingesting many emails otherwise fires dozens of simultaneous
   calls at the rate-limited proxy.

**Backlog cleanup:** the on-demand pending sweep (`analyzePendingForUser`, admin
route `/admin/email-intel/:id/analyze-pending`) has a two-phase fresh+retry loop;
the retry phase re-runs any `actions_error IS NOT NULL` row with NO 24h cooldown
(unlike gmailBackfill phase-D). Prod backlog is drained by hitting that route per
affected mailbox user after deploy — the agent can't write prod directly.
