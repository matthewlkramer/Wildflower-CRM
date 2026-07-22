---
name: Direct Playwright fallback when the testing subagent is down
description: How to run the committed e2e specs directly when runTest is unavailable, plus process/OOM gotchas.
---

# Direct Playwright fallback

When the runTest testing subagent is unavailable, the committed specs in
`artifacts/wildflower-crm/e2e/` can be run directly (Clerk testing-token setup
is already in the specs; see the playwright-e2e-clerk-setup note for the four
hard constraints).

**How to apply:**

- Full-suite runs die silently mid-run (process vanishes, no tally — likely
  OOM). Run in small `-g "F8|F9"` style batches instead.
- Launch detached and poll (agent bash has a 120s cap):
  `(setsid nohup pnpm exec playwright test <spec> -g "..." --reporter=line --timeout=90000 > /tmp/x.log 2>&1 < /dev/null &)` then sleep + tail.
- **Never `pkill -f "playwright"`** — it matches the agent's own bash command
  and self-kills (exit 143). Kill via a `ps aux | grep | awk` PID loop instead.
- Clean up after killed runs per the test-data-hygiene note (e2esweep gifts,
  "E2E sweep task" tasks, demote the e2e user back to team_member).

**Why:** discovered while browser-verifying flows during a subagent outage;
these three footguns each cost a full rerun.
