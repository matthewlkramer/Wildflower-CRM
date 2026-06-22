---
name: Background processes are killed when the tool call returns
description: Long commands (orval codegen, tsc builds) must run in the FOREGROUND inside one bash tool call; detached/setsid/nohup procs get reaped, and pgrep -f <name> self-matches the shell.
---

Long-running commands in this environment must run in the **foreground**, blocking
inside a single bash tool call. Detaching them (`setsid`/`nohup`/`& disown`) does
NOT keep them alive — the platform reaps the background process group shortly after
the launching tool call returns. The process appears to "run for minutes" only
because of two measurement illusions (see below); in reality it dies within
seconds of the call ending.

**Why this misled for hours:**
- `pgrep -f orval` (or any `-f <pattern>`) **matches your own shell command**, because
  your command line literally contains the pattern. So "RUNNING" was the shell
  matching itself, not a live orval.
- A `cat sentinel || echo "still running"` check only proves the sentinel is absent,
  NOT that the process is alive.
- `kill -9 $(pgrep -f orval)` then self-kills the shell → exit code **137** with no
  output (the recurring "137" mystery).

**Reliable signals instead:**
- `ps -eo pid,comm,args | awk '$2=="node"'` — count REAL node processes (immune to
  shell self-match). Zero node procs = it's dead.
- CPU sampling: `awk '{print $14+$15}' /proc/$PID/stat` twice a few seconds apart.
  Rising = working; flat ~0 over seconds = deadlocked (e.g. blocked on an open stdin).

**The fix that worked:** run it foreground with a timeout under the tool cap:
`cd lib/api-spec && timeout 115 ./node_modules/.bin/orval --config ./orval.config.ts > /tmp/fg.log 2>&1; echo EXIT=$?`
orval codegen for this repo completes in **~31 seconds** foreground (NOT the ~7 min
the broken background runs implied). Success log ends with `🎉 ... converted!` and
`EXIT=0`; the api-zod `generated/api.ts` mtime updates.

**How to apply:** for orval codegen, `tsc --build`, drizzle push, etc., prefer a
single foreground bash call (timeout ≤115s). Only if a command genuinely exceeds the
tool cap should you consider a workflow. Never trust `pgrep -f`/sentinel-absence as
proof a background job is alive.
