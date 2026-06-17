---
name: Email-intel AI failure recovery
description: How stuck errored-pending email proposals get re-analyzed (manual retry + scheduled sweep), and why they share one code path.
---

# Email-intelligence AI failure recovery

Email proposals carry an AI action-analysis stage. A failure leaves a row
`status='pending'` with `actions_error` set — the inline sync fan-out only fires on
brand-new rows and the one-time backfill never re-runs, so without an explicit
recovery path those rows are frozen and the UI keeps showing red "AI analysis
failed" boxes. A rate-limit storm can strand hundreds at once.

## One shared mechanism, three entry points

All recovery routes funnel through `analyzePendingForUser(userId, opts)` in
`artifacts/api-server/src/lib/analyzePending.ts`. It has two phases:
- **fresh** — rows never analyzed (`actions_analyzed_at IS NULL`)
- **retry** — rows with `actions_error` set; gains an
  `actions_analyzed_at < now - cooldown` predicate when `retryCooldownMs` is set.

Per-proposal AI runs through `proposeActionsForProposal(id)`, which atomically
claims a row only when `actions_analyzed_at IS NULL`. **So any retry must first
reset `actions_error = null, actions_analyzed_at = null`, then call it.**

1. **Manual retry button** — `POST /email-proposals/:id/retry` (owner-scoped via
   `mailboxUserId` + `status='pending'`; 404 vs 409 like accept/reject). Resets the
   two fields, runs `proposeActionsForProposal` synchronously, returns the refreshed
   row for in-place UI update.
2. **Scheduled sweep** — `emailIntelRecoveryScheduler.ts`: 30-min tick, off-hours CT
   window, global advisory lock (key pair `9003,1` — distinct from media `9001`,
   task-suggestion `9002`), per-user `gmail` `withSyncLock` so it never overlaps that
   user's scheduled sync or one-time backfill. Runs retry phase with a 24h data-level
   cooldown (the real guard; cadence is stateless).
3. **Operator drain** — write a userId to `/tmp/analyze-pending/trigger` and restart,
   or admin `POST /admin/email-intel/:id/analyze-pending`. Default opts run both
   phases with NO cooldown — use this to clear an existing backlog immediately.

## Why the shared limiter matters

Every AI call goes through `aiProposalLimit` (concurrency) + `withRateLimitRetry`
(SDK `maxRetries:0`). That is why a burst of manual retries — or the sweep itself —
can never re-create a rate-limit storm: they all serialize behind the same limiter.

**Why:** keeping recovery on the same limiter as normal analysis was the whole point
— independent retry paths would defeat the rate-limit protection.

## How to apply

- Draining a backlog: trigger-file + restart is the fastest; it processes
  sequentially through the limiter (~15 rows/min observed), so hundreds of rows take
  20+ minutes. Monitor with a `count(*) FILTER (WHERE status='pending' AND
  actions_error IS NOT NULL)` query, not the logs.
- Prod self-heals via the scheduler after publish (agent cannot write to prod).
