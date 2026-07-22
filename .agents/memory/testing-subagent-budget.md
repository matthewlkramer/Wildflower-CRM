---
name: Testing subagent budget and timeouts
description: runTest has a hard per-task iteration cap and is prone to 600s StartToClose timeouts; keep e2e plans tiny.
---

# Testing subagent budget and timeouts

- `runTest` is capped at **10 iterations per assigned task**; every call counts,
  including ones that die in infrastructure timeouts. Budget flows accordingly —
  do not burn retries on the same plan.
- Combined multi-flow plans (sign-in + two feature areas + DB seeding) reliably
  hit the 600s code_execution cap. Keep each plan to ONE small flow with minimal
  steps and terse documentation.
- Infra failure signature: Temporal `SubagentSession ... Child workflow timeout
  (StartToClose)` with zero progress (no Clerk test user created in the dev DB).
  This is an environment outage, not a plan problem — checking `users` for the
  test email is the cheap way to distinguish "test stalled mid-flow" from
  "subagent never started". When it recurs after 1–2 retries, defer remaining
  flows to a follow-up task instead of retrying.

**Why:** an e2e sweep exhausted its entire testing budget on retries against a
subagent outage, leaving 8 of 11 flows unverified.

**How to apply:** any time you plan multiple runTest calls — count them against
the cap up front and design one-flow plans.
